const METRIC_KINDS = new Set(["sync-success", "sync-failure", "load-complete", "load-failure"]);
const METRIC_FIELDS = new Set(["kind", "atMs", "durationMs", "itemCount"]);
const finiteNonnegative = value => typeof value === "number" && Number.isFinite(value) && value >= 0;
const sum = (a, b) => Math.min(Number.MAX_SAFE_INTEGER, a + b);

/** Fixed aggregate schema: raw events and identifying strings are never retained. */
export function createDiagnostics({ now = Date.now } = {}) {
  let values;
  function resetDiagnostics() {
    values = { schemaVersion: 1, eventCount: 0, successCount: 0, failureCount: 0, syncSuccessCount: 0, syncFailureCount: 0, loadCompleteCount: 0, loadFailureCount: 0, itemCount: 0, lastEventAtMs: null, lastSuccessAtMs: null, lastFailureAtMs: null, lastDurationMs: 0, loadDurationMs: 0, totalDurationMs: 0 };
  }
  resetDiagnostics();
  function recordMetric(event) {
    if (!event || typeof event !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(event))) return false;
    if (Reflect.ownKeys(event).some(key => !METRIC_FIELDS.has(key)) || !METRIC_KINDS.has(event.kind) || !finiteNonnegative(event.atMs)) return false;
    if ((event.durationMs !== undefined && !finiteNonnegative(event.durationMs)) || (event.itemCount !== undefined && !finiteNonnegative(event.itemCount))) return false;
    const duration = event.durationMs ?? 0, count = event.itemCount ?? 0;
    values.eventCount = sum(values.eventCount, 1);
    values.itemCount = sum(values.itemCount, count);
    values.totalDurationMs = sum(values.totalDurationMs, duration);
    values.lastEventAtMs = Math.max(values.lastEventAtMs ?? 0, event.atMs);
    values.lastDurationMs = duration;
    const success = event.kind === "sync-success" || event.kind === "load-complete";
    const counter = success ? "successCount" : "failureCount", at = success ? "lastSuccessAtMs" : "lastFailureAtMs";
    values[counter] = sum(values[counter], 1);
    values[at] = Math.max(values[at] ?? 0, event.atMs);
    const kindCounter = { "sync-success": "syncSuccessCount", "sync-failure": "syncFailureCount", "load-complete": "loadCompleteCount", "load-failure": "loadFailureCount" }[event.kind];
    values[kindCounter] = sum(values[kindCounter], 1);
    if (event.kind.startsWith("load-")) values.loadDurationMs = duration;
    return true;
  }
  return { recordMetric, resetDiagnostics, getDiagnosticsSnapshot() {
    const at = now();
    return { ...values, sinceSuccessMs: values.lastSuccessAtMs === null ? null : Math.max(0, (finiteNonnegative(at) ? at : values.lastSuccessAtMs) - values.lastSuccessAtMs) };
  } };
}

export function createCommandRegistry() {
  const commands = new Map();
  function available(command) { try { return command.enabled ? command.enabled() === true : true; } catch { return false; } }
  return {
    register(command) {
      if (!command || typeof command.id !== "string" || !/^[a-z][a-z0-9._-]{0,79}$/i.test(command.id) || typeof command.label !== "string" || !command.label.trim() || command.label.length > 160 || typeof command.run !== "function" || (command.enabled !== undefined && typeof command.enabled !== "function")) throw new TypeError("Invalid UI command");
      if (commands.has(command.id) || commands.size >= 64) throw new Error("Command already registered or registry full");
      const copy = { id: command.id, label: command.label, shortcut: typeof command.shortcut === "string" ? command.shortcut.slice(0, 40) : "", disabledReason: typeof command.disabledReason === "string" ? command.disabledReason.slice(0, 160) : "", enabled: command.enabled, run: command.run };
      commands.set(copy.id, copy);
      return () => { if (commands.get(copy.id) === copy) commands.delete(copy.id); };
    },
    list() { return Array.from(commands.values(), command => ({ id: command.id, label: command.label, shortcut: command.shortcut, enabled: available(command), disabledReason: command.disabledReason })); },
    execute(id) { const command = commands.get(id); if (!command || !available(command)) return false; command.run(); return true; },
  };
}

export function navigationShortcut(event = {}) {
  if (event.editing || event.isComposing || event.keyCode === 229 || event.repeat || event.altKey) return null;
  if (String(event.key).toLowerCase() === "k" && Boolean(event.ctrlKey) !== Boolean(event.metaKey) && !event.shiftKey) return "workflow.palette";
  if (event.key === "?" && !event.ctrlKey && !event.metaKey) return "workflow.help";
  return null;
}

const FALLBACK = {
  palette: "명령 찾기", help: "키보드 도움말", reading: "읽기 모드", diagnostics: "연결·로딩 진단", close: "닫기",
  search: "명령 이름 검색", noCommands: "사용 가능한 명령이 없습니다.", unavailable: "현재 사용할 수 없습니다.",
  privacy: "초안과 책갈피는 현재 탭의 메모리에만 보관됩니다. 탭을 닫거나 새로고침하면 삭제됩니다.",
  shortcuts: "Ctrl/Cmd+K: 명령 찾기 · ?: 키보드 도움말 (입력·IME 중 제외)",
  existing: "기존 단축키: Alt+2 Mirror · Alt+3 Hermes. 기존 앱 전환기가 처리하며 입력·IME 중에는 동작하지 않습니다. Escape는 가장 위의 보조 화면을 닫습니다.",
  default: "기본", comfortable: "넉넉하게", focused: "집중", restore: "기본값 복원",
  diagnosticPrivacy: "현재 탭에서 수집한 시간·건수만 표시하고 내보냅니다. 메시지·초안·ID·URL·오류 문자열은 수집하지 않습니다.",
  reset: "진단 초기화", download: "진단 JSON 다운로드", downloadFailed: "다운로드를 시작하지 못했습니다.",
  commandFailed: "명령을 실행하지 못했습니다.",
};
let instanceSequence = 0;

/** All UI is owned by this instance. Call dispose before replacing it. */
export function createUiNavigation({ document: doc, host, registry, t = key => key, getReadingTarget = () => null, onReadingChange, features = {} } = {}) {
  if (!doc || !host || !registry) throw new TypeError("Navigation requires document, host and registry");
  const id = `wf-navigation-${++instanceSequence}`;
  const label = key => { const translated = t(`workflow.${key}`); return translated && translated !== `workflow.${key}` ? translated : FALLBACK[key] || key; };
  const node = (tag, text, className) => { const element = doc.createElement(tag); if (text !== undefined) element.textContent = text; if (className) element.className = className; return element; };
  const button = (action, text, run) => { const element = node("button", text); element.type = "button"; element.dataset.wfAction = action; element.addEventListener("click", run); return element; };
  const metrics = createDiagnostics();
  const style = node("style");
  style.textContent = `
    .wf-navigation { display:flex; flex-wrap:wrap; gap:6px; min-width:0; }
    .wf-navigation button,.wf-dialog button { min-height:38px; padding:7px 10px; border:1px solid var(--line,#777); border-radius:8px; background:var(--panel,#fff); color:var(--ink,#222); font:inherit; cursor:pointer; }
    .wf-dialog { box-sizing:border-box; width:min(620px,calc(100% - 24px)); max-width:calc(100% - 24px); max-height:calc(100dvh - 32px); padding:16px; border:1px solid var(--line,#777); border-radius:12px; background:var(--panel,#fff); color:var(--ink,#222); overflow:auto; }
    .wf-dialog::backdrop { background:#0008; }
    .wf-dialog-header { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:8px; }
    .wf-dialog h2 { margin:0; font-size:1.1rem; }
    .wf-dialog p { overflow-wrap:anywhere; line-height:1.6; }
    .wf-dialog input { box-sizing:border-box; width:100%; min-width:0; min-height:40px; margin:12px 0; padding:8px; font:inherit; background:var(--surface,#fff); color:inherit; border:1px solid var(--line,#777); border-radius:6px; }
    .wf-command-list { display:grid; gap:6px; max-height:48dvh; overflow:auto; }
    .wf-command-list button { display:block; width:100%; text-align:left; overflow-wrap:anywhere; }
    .wf-command-list button[aria-selected=true] { outline:2px solid var(--accent,#5579bd); outline-offset:-2px; }
    .wf-command-list button:disabled { cursor:default; opacity:.6; }
    .wf-dialog-actions { display:flex; flex-wrap:wrap; gap:8px; margin-top:12px; }
    .wf-diagnostics-values { overflow:auto; white-space:pre-wrap; overflow-wrap:anywhere; font-size:12px; }
    .wf-reading-body .message:is(.user,.assistant) > .bubble.markdown { font-size:var(--wf-reading-font); line-height:var(--wf-reading-line); max-width:min(100%,var(--wf-reading-width)); overflow-wrap:anywhere; min-width:0; }
    .wf-reading-body .message:is(.user,.assistant) > .bubble.markdown :is(pre,table) { max-width:100%; overflow-x:auto; }
    .wf-reading-body .message:is(.user,.assistant) > .bubble.markdown table { display:block; }
  `;
  doc.head.append(style);
  const toolbar = node("nav", undefined, "wf-navigation"); toolbar.setAttribute("aria-label", label("palette")); host.append(toolbar);
  const dialog = node("dialog", undefined, "wf-dialog"); dialog.id = id; doc.body.append(dialog);
  let disposed = false, opener = null, mode = null, preset = "default", readingTarget = null, renderDiagnostics = null;
  const registered = [];
  function close() { if (dialog.open) dialog.close(); }
  const afterClose = () => {
    // Native close is queued: an older event must not clear a panel reopened in the same turn.
    if (dialog.open) return;
    const target = opener; opener = null; mode = null; renderDiagnostics = null;
    if (target?.isConnected) target.focus();
  };
  dialog.addEventListener("close", afterClose);
  const cancel = event => { event.preventDefault(); close(); };
  dialog.addEventListener("cancel", cancel);
  function open(title, nextMode) {
    if (disposed) return false;
    if (!dialog.open && !opener) opener = doc.activeElement;
    mode = nextMode; renderDiagnostics = null;
    dialog.replaceChildren();
    const header = node("div", undefined, "wf-dialog-header"), heading = node("h2", title); heading.id = `${id}-heading`;
    dialog.setAttribute("aria-labelledby", heading.id);
    const closeButton = button("close", label("close"), close);
    header.append(heading, closeButton); dialog.append(header);
    if (!dialog.open) dialog.showModal();
    closeButton.focus();
    return true;
  }
  function runCommand(commandId) {
    const current = registry.list().find(command => command.id === commandId);
    if (!current?.enabled) return false;
    close();
    // Finish our focus restoration before run() chooses a new external focus destination.
    // The native queued close then has no old opener left to steal focus back to.
    afterClose();
    try { return registry.execute(commandId); } catch { if (open(label("palette"), "error")) dialog.append(node("p", label("commandFailed"))); return false; }
  }
  function openPalette() {
    if (features.F09 === false) return;
    if (!open(label("palette"), "palette")) return;
    const input = node("input"); input.type = "search"; input.maxLength = 160; input.setAttribute("aria-label", label("search")); input.setAttribute("role", "combobox"); input.setAttribute("aria-autocomplete", "list"); input.setAttribute("aria-expanded", "true");
    const list = node("div", undefined, "wf-command-list"); list.id = `${id}-commands`; list.setAttribute("role", "listbox"); list.setAttribute("aria-label", label("palette")); input.setAttribute("aria-controls", list.id);
    const status = node("p"); status.setAttribute("role", "status");
    let options = [], selected = -1, commandIds = [];
    function select(index) {
      selected = index;
      for (const [i, option] of options.entries()) option.setAttribute("aria-selected", String(i === selected));
      if (selected >= 0) { input.setAttribute("aria-activedescendant", options[selected].id); options[selected].scrollIntoView?.({ block: "nearest" }); } else input.removeAttribute("aria-activedescendant");
    }
    function refresh() {
      const query = input.value?.trim().toLocaleLowerCase() || "";
      const commands = registry.list().filter(command => `${command.id} ${command.label}`.toLocaleLowerCase().includes(query));
      options = []; commandIds = []; list.replaceChildren();
      for (const [i, command] of commands.entries()) {
        const row = button("command", `${command.label}${command.shortcut ? ` · ${command.shortcut}` : ""}${!command.enabled ? ` — ${command.disabledReason || label("unavailable")}` : ""}`, () => { if (!runCommand(command.id)) refresh(); });
        row.id = `${id}-option-${i}`; row.dataset.commandId = command.id; row.disabled = !command.enabled; row.tabIndex = -1; row.setAttribute("role", "option");
        list.append(row); options.push(row); commandIds.push(command.id);
      }
      select(options.findIndex(option => !option.disabled)); status.textContent = commands.length ? "" : label("noCommands");
    }
    input.addEventListener("input", refresh);
    input.addEventListener("keydown", event => {
      if (event.isComposing || event.keyCode === 229) return;
      if (["ArrowDown", "ArrowUp"].includes(event.key)) {
        event.preventDefault(); const direction = event.key === "ArrowDown" ? 1 : -1;
        for (let step = 1; step <= options.length; step++) { const index = (selected + direction * step + options.length) % options.length; if (!options[index].disabled) { select(index); break; } }
      } else if (event.key === "Enter") { event.preventDefault(); if (selected >= 0 && !runCommand(commandIds[selected])) refresh(); }
    });
    dialog.append(input, list, status); refresh(); input.focus();
  }
  function openHelp() {
    if (features.F10 === false) return;
    if (!open(label("help"), "help")) return;
    dialog.append(node("p", label("shortcuts")), node("p", label("existing")));
    const list = node("div", undefined, "wf-command-list");
    for (const command of registry.list()) {
      const row = button("help-command", `${command.label}${command.shortcut ? ` · ${command.shortcut}` : ""}${!command.enabled ? ` — ${command.disabledReason || label("unavailable")}` : ""}`, () => runCommand(command.id)); row.disabled = !command.enabled; list.append(row);
    }
    dialog.append(list, node("p", label("privacy")));
  }
  const readingValues = { comfortable: ["17px", "1.85", "78ch"], focused: ["18px", "1.9", "62ch"] };
  function applyReading(next) {
    const target = getReadingTarget();
    const apply = () => {
      if (readingTarget && readingTarget !== target) clearReading(readingTarget);
      readingTarget = target;
      if (target) {
        clearReading(target);
        if (next !== "default") {
          target.classList.add("wf-reading-body");
          for (const [index, key] of ["font", "line", "width"].entries()) target.style.setProperty(`--wf-reading-${key}`, readingValues[next][index]);
        }
      }
      preset = next;
    };
    // Integration captures the current message anchor, applies synchronously, then restores it.
    if (onReadingChange) onReadingChange({ preset: next, apply }); else apply();
    return preset;
  }
  function clearReading(target) {
    target.classList.remove("wf-reading-body");
    for (const key of ["font", "line", "width"]) target.style.removeProperty(`--wf-reading-${key}`);
  }
  function cycleReading() { return disposed || features.F14 === false ? preset : applyReading({ default: "comfortable", comfortable: "focused", focused: "default" }[preset]); }
  function openReading() {
    if (features.F14 === false) return;
    if (!open(label("reading"), "reading")) return;
    const actions = node("div", undefined, "wf-dialog-actions");
    for (const name of ["default", "comfortable", "focused"]) {
      const option = button(`reading-${name}`, label(name), () => { applyReading(name); openReading(); }); option.setAttribute("aria-pressed", String(preset === name)); actions.append(option);
    }
    actions.append(button("reading-restore", label("restore"), () => { applyReading("default"); openReading(); })); dialog.append(actions);
  }
  function openDiagnostics() {
    if (features.F15 === false) return;
    if (!open(label("diagnostics"), "diagnostics")) return;
    const output = node("pre", undefined, "wf-diagnostics-values"), status = node("p"); status.setAttribute("role", "status");
    renderDiagnostics = () => { output.textContent = JSON.stringify(metrics.getDiagnosticsSnapshot(), null, 2); };
    const actions = node("div", undefined, "wf-dialog-actions");
    actions.append(button("diagnostics-reset", label("reset"), () => { metrics.resetDiagnostics(); renderDiagnostics?.(); }), button("diagnostics-download", label("download"), () => {
      // The palette only opens this panel. This explicit click is the sole download entry.
      const api = doc.defaultView || globalThis; let url;
      try {
        url = api.URL.createObjectURL(new api.Blob([JSON.stringify(metrics.getDiagnosticsSnapshot(), null, 2)], { type: "application/json" }));
        const link = node("a"); link.href = url; link.download = "codex-webui-diagnostics.json"; doc.body.append(link); link.click(); link.remove();
      } catch { status.textContent = label("downloadFailed"); }
      finally { if (url) api.URL.revokeObjectURL(url); }
    }));
    dialog.append(node("p", label("diagnosticPrivacy")), output, actions, status); renderDiagnostics();
  }
  const keydown = event => {
    if (disposed || event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
    const openDialogs = Array.from(doc.querySelectorAll("dialog[open]"));
    if (dialog.open) {
      // Escape's native cancel event targets the actual top-layer modal. DOM order cannot
      // determine that ownership. Suppress unrelated page listeners only for keys inside us,
      // preserving the browser default so cancel, not this dispatcher, performs the close.
      if (event.key === "Escape" && dialog.contains(event.target)) event.stopImmediatePropagation();
      return;
    }
    if (openDialogs.length) return;
    const editing = Boolean(event.target?.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]') || doc.activeElement?.isContentEditable);
    const commandId = navigationShortcut({ key: event.key, ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey, altKey: event.altKey, isComposing: event.isComposing, keyCode: event.keyCode, repeat: event.repeat, editing });
    if (commandId && registry.execute(commandId)) { event.preventDefault(); event.stopImmediatePropagation(); }
  };
  doc.addEventListener("keydown", keydown, true);
  for (const [action, run, shortcut] of [["palette", openPalette, "Ctrl/Cmd+K"], ["help", openHelp, "?"], ["reading", openReading, ""], ["diagnostics", openDiagnostics, ""]]) {
    if (features[{palette:"F09",help:"F10",reading:"F14",diagnostics:"F15"}[action]] === false) continue;
    registered.push(registry.register({ id: `workflow.${action}`, label: label(action), shortcut, run }));
    toolbar.append(button(action, label(action), run));
  }
  return {
    openPalette, openHelp, cycleReading, openDiagnostics,
    recordMetric(event) { if (disposed || features.F15 === false) return false; const accepted = metrics.recordMetric(event); if (accepted && mode === "diagnostics") renderDiagnostics?.(); return accepted; },
    getDiagnosticsSnapshot: metrics.getDiagnosticsSnapshot,
    resetDiagnostics() { metrics.resetDiagnostics(); renderDiagnostics?.(); },
    dispose() {
      if (disposed) return; disposed = true;
      doc.removeEventListener("keydown", keydown, true); close();
      dialog.removeEventListener("close", afterClose); dialog.removeEventListener("cancel", cancel);
      if (readingTarget) clearReading(readingTarget);
      for (const unregister of registered) unregister();
      toolbar.remove(); dialog.remove(); style.remove(); metrics.resetDiagnostics();
    },
  };
}
