import { composerAssistMessages } from "./input-assist-messages.js";

const MAX_COMMAND_RESULTS = 20;
const MAX_FILE_RESULTS = 50;
const SEARCH_DEBOUNCE_MS = 150;
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;
const EMAIL_LOCAL_CHARS = /[A-Za-z0-9._%+\-@]/;
const ARIA_KEYS = ["aria-controls", "aria-expanded", "aria-activedescendant", "aria-autocomplete"];

let popupCounter = 0;

function codeFenceOpen(text, index) {
  const matches = text.slice(0, index).match(/```/g);
  return (matches ? matches.length : 0) % 2 === 1;
}

function makeToken(kind, text, start, caret, query) {
  let end = caret;
  while (end < text.length && !/\s/.test(text[end])) end += 1;
  return {
    kind,
    start,
    end,
    query,
    trigger: kind === "slash" ? "/" : "@",
    raw: text.slice(start, end)
  };
}

// Pure token finder shared by the popup and tests. A slash token only exists as
// the first composer token; an @ token only at a word boundary outside fences.
export function findAssistToken(text, caret) {
  if (typeof text !== "string") return null;
  const length = text.length;
  let index = Number.isInteger(caret) ? caret : length;
  if (!Number.isFinite(index)) index = length;
  index = Math.max(0, Math.min(length, index));
  if (index === 0) return null;
  const before = text.slice(0, index);
  const slashMatch = /^\/(\S*)$/.exec(before);
  if (slashMatch) {
    const query = slashMatch[1];
    // Ordinary paths and dotfiles typed as the first token are not commands.
    if (/[/\\]/.test(query) || query.startsWith("~") || query.startsWith(".")) return null;
    return makeToken("slash", text, 0, index, query);
  }
  const at = before.lastIndexOf("@");
  if (at === -1) return null;
  const segment = before.slice(at + 1);
  if (/\s/.test(segment)) return null;
  if (at > 0 && EMAIL_LOCAL_CHARS.test(before[at - 1])) return null;
  if (codeFenceOpen(text, at)) return null;
  return makeToken("file", text, at, index, segment);
}

export function filterSlashCommands(commands, query) {
  if (!Array.isArray(commands)) return [];
  let normalized = typeof query === "string" ? query.trim().toLowerCase() : "";
  normalized = normalized.replace(/^\/+/, "");
  const results = [];
  for (const command of commands) {
    if (!command || typeof command.name !== "string") continue;
    const name = command.name.replace(/^\/+/, "").toLowerCase();
    if (normalized !== "" && !name.startsWith(normalized)) continue;
    results.push(command);
    if (results.length >= MAX_COMMAND_RESULTS) break;
  }
  return results;
}

// Workspace relative paths only: no absolute/drive/parent segments, no control
// characters, no hidden or credential-like dot segments, no quoting surprises.
export function safeWorkspaceCandidate(entry) {
  if (!entry || typeof entry !== "object") return null;
  const path = typeof entry.path === "string" ? entry.path : "";
  if (path === "" || path.length > 1024) return null;
  if (CONTROL_CHARS.test(path)) return null;
  if (path.startsWith("/") || path.startsWith("\\") || path.startsWith("~")) return null;
  if (/^[A-Za-z]:/.test(path)) return null;
  if (path.includes("\\") || /["']/.test(path)) return null;
  const segments = path.split("/");
  if (segments.some(segment => segment === "" || segment === "." || segment === "..")) return null;
  if (segments.some(segment => segment.startsWith("."))) return null;
  const kind = entry.kind === "directory" ? "directory" : entry.kind === "file" ? "file" : null;
  if (!kind) return null;
  const declared = typeof entry.name === "string" && entry.name !== "" ? entry.name : "";
  const fallback = segments[segments.length - 1];
  const name = declared !== "" && !CONTROL_CHARS.test(declared) && !declared.includes("/") ? declared : fallback;
  return { name, path, kind };
}

export function quoteWorkspaceReference(path) {
  if (typeof path !== "string") return "";
  const trimmed = path.trim();
  if (trimmed === "" || CONTROL_CHARS.test(trimmed)) return "";
  const cleaned = trimmed.replace(/"/g, "");
  if (cleaned === "") return "";
  return /\s/.test(cleaned) ? `@"${cleaned}"` : `@${cleaned}`;
}

export function replaceAssistToken(text, token, replacement) {
  const source = typeof text === "string" ? text : "";
  const value = typeof replacement === "string" ? replacement : "";
  if (!token || typeof token !== "object") return { text: source, caret: source.length };
  let start = Number.isInteger(token.start) ? token.start : 0;
  let end = Number.isInteger(token.end) ? token.end : start;
  start = Math.max(0, Math.min(source.length, start));
  end = Math.max(start, Math.min(source.length, end));
  return { text: source.slice(0, start) + value + source.slice(end), caret: start + value.length };
}

export function createInputAssist({
  document,
  input,
  host,
  t,
  registerMessages,
  getContext,
  getCommands,
  searchFiles,
  onFeedback
} = {}) {
  if (typeof registerMessages === "function") {
    try {
      registerMessages(composerAssistMessages);
    } catch {
      // Message registration belongs to the host; never break the popup.
    }
  }

  const messages = composerAssistMessages.en;
  popupCounter += 1;
  const popupId = `composer-assist-${popupCounter}`;
  const listeners = [];
  const ariaBackup = new Map();

  let disposed = false;
  let popup = null;
  let optionNodes = [];
  let session = null;
  let generation = 0;
  let debounceTimer = null;
  let searchAbort = null;
  let composing = false;
  let busy = false;
  let ariaCaptured = false;
  let suppressDepth = 0;

  function label(key, params) {
    try {
      const value = typeof t === "function" ? (params ? t(key, params) : t(key)) : undefined;
      if (typeof value === "string" && value !== "" && value !== key) return value;
    } catch {
      // Fall back to the bundled English label.
    }
    const template = messages[key] ?? key;
    if (!params) return template;
    return template.replace(/\{(\w+)\}/g, (match, name) =>
      params[name] === undefined ? match : String(params[name])
    );
  }

  function feedback(kind, key) {
    try {
      onFeedback?.({ kind, code: key, label: label(key) });
    } catch {
      // Feedback is advisory only.
    }
  }

  function context() {
    let value = null;
    try {
      value = getContext?.();
    } catch {
      value = null;
    }
    const threadId = typeof value?.threadId === "string" && value.threadId !== "" ? value.threadId : null;
    const connected = value?.connected === true;
    const key = typeof value?.key === "string" && value.key !== "" ? value.key : `${threadId ?? ""}`;
    return { key, threadId, connected, stamp: `${key}|${threadId ?? ""}|${connected ? "1" : "0"}` };
  }

  function commandList() {
    try {
      const list = getCommands?.();
      return Array.isArray(list) ? list : [];
    } catch {
      return [];
    }
  }

  function commandEnabled(command) {
    try {
      if (typeof command?.enabled === "function") return command.enabled() !== false;
      return command?.enabled !== false;
    } catch {
      return false;
    }
  }

  function caretIndex() {
    const value = typeof input?.value === "string" ? input.value : "";
    const raw = input?.selectionStart;
    return Number.isInteger(raw) ? Math.max(0, Math.min(value.length, raw)) : value.length;
  }

  function listen(target, type, handler) {
    if (!target || typeof target.addEventListener !== "function") return;
    target.addEventListener(type, handler);
    listeners.push({ target, type, handler });
  }

  function setInputAttr(name, value) {
    if (typeof input?.setAttribute === "function") input.setAttribute(name, value);
    else if (input) input[name] = value;
  }

  function removeInputAttr(name) {
    if (typeof input?.removeAttribute === "function") input.removeAttribute(name);
  }

  function captureAria() {
    ariaBackup.clear();
    for (const name of ARIA_KEYS) {
      let value = null;
      if (typeof input?.getAttribute === "function") value = input.getAttribute(name);
      else if (input && input[name] !== undefined) value = input[name];
      ariaBackup.set(name, value == null ? null : String(value));
    }
    ariaCaptured = true;
  }

  function restoreAria() {
    if (!ariaCaptured) return;
    for (const [name, value] of ariaBackup) {
      if (value === null) removeInputAttr(name);
      else setInputAttr(name, value);
    }
    ariaBackup.clear();
    ariaCaptured = false;
  }

  function ensurePopup() {
    if (popup) return popup;
    popup = document.createElement("div");
    popup.className = "composer-assist";
    popup.setAttribute("role", "listbox");
    popup.setAttribute("id", popupId);
    return popup;
  }

  function detachPopup() {
    if (!popup) return;
    const parent = popup.parentNode || popup.parent;
    if (parent) {
      if (typeof parent.removeChild === "function") parent.removeChild(popup);
      else if (typeof popup.remove === "function") popup.remove();
    }
    if (Object.hasOwn(popup, "parent")) popup.parent = null;
    if (Object.hasOwn(popup, "parentNode")) popup.parentNode = null;
  }

  function attachPopup() {
    const node = ensurePopup();
    const parent = node.parentNode || node.parent;
    if (parent && parent === host) return;
    if (typeof host?.append === "function") host.append(node);
    else if (typeof host?.appendChild === "function") host.appendChild(node);
  }

  function clearPopupChildren() {
    for (const child of [...(popup?.children || [])]) {
      const parent = child.parentNode || child.parent || popup;
      if (typeof parent.removeChild === "function") parent.removeChild(child);
      else {
        child.parent = null;
        child.parentNode = null;
      }
    }
    if (popup && Array.isArray(popup.children)) popup.children = [];
  }

  function appendStatus(text) {
    const node = ensurePopup();
    const status = document.createElement("div");
    status.className = "composer-assist-status";
    status.setAttribute("role", "presentation");
    status.setAttribute("aria-live", "polite");
    status.textContent = text;
    node.appendChild ? node.appendChild(status) : node.append(status);
    return status;
  }

  function optionText(item) {
    if (session.kind === "slash") {
      const name = typeof item.name === "string" ? item.name.replace(/^\/+/, "") : "";
      const description = typeof item.description === "string" ? item.description : "";
      return description ? `/${name} — ${description}` : `/${name}`;
    }
    return typeof item.path === "string" ? item.path : "";
  }

  function render() {
    if (!session) return;
    const node = ensurePopup();
    node.setAttribute("aria-label", label(session.kind === "slash" ? "composerAssist.slashLabel" : "composerAssist.fileLabel"));
    clearPopupChildren();
    optionNodes = [];
    if (session.hintKey || session.errorKey) {
      appendStatus(label(session.hintKey || session.errorKey));
      return;
    }
    if (session.items.length === 0) {
      const key = session.kind === "slash"
        ? "composerAssist.slashEmpty"
        : session.searching ? "composerAssist.fileSearching" : "composerAssist.fileEmpty";
      appendStatus(label(key));
      return;
    }
    session.items.forEach((item, index) => {
      const option = document.createElement("div");
      option.className = "composer-assist-option";
      option.setAttribute("role", "option");
      option.setAttribute("id", `${popupId}-option-${index}`);
      option.setAttribute("aria-selected", index === session.activeIndex ? "true" : "false");
      if (session.kind === "slash" && !commandEnabled(item)) option.setAttribute("aria-disabled", "true");
      option.textContent = optionText(item);
      const select = () => selectIndex(index);
      option.addEventListener("mousedown", event => {
        event?.preventDefault?.();
        select();
      });
      option.addEventListener("click", () => select());
      node.appendChild ? node.appendChild(option) : node.append(option);
      optionNodes.push(option);
    });
  }

  function syncAria() {
    if (!session) return;
    setInputAttr("aria-controls", popupId);
    setInputAttr("aria-expanded", "true");
    setInputAttr("aria-autocomplete", "list");
    const active = optionNodes[session.activeIndex];
    if (active && active.getAttribute?.("id")) setInputAttr("aria-activedescendant", active.getAttribute("id"));
    else removeInputAttr("aria-activedescendant");
  }

  function show() {
    if (!ariaCaptured) captureAria();
    render();
    attachPopup();
    syncAria();
  }

  function updateSelection() {
    if (!session) return;
    optionNodes.forEach((node, index) => {
      node.setAttribute("aria-selected", index === session.activeIndex ? "true" : "false");
    });
    syncAria();
  }

  function abortSearch() {
    if (searchAbort) {
      try {
        searchAbort.abort();
      } catch {
        // Already aborted or unsupported.
      }
      searchAbort = null;
    }
  }

  function closePopup() {
    session = null;
    optionNodes = [];
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    abortSearch();
    generation += 1;
    detachPopup();
    restoreAria();
  }

  function dispatchInput() {
    suppressDepth += 1;
    try {
      if (typeof input?.dispatchEvent === "function" && typeof Event === "function") {
        input.dispatchEvent(new Event("input"));
      }
    } catch {
      // Composer notification is best effort.
    } finally {
      suppressDepth -= 1;
    }
  }

  function setInputValue(value, caret) {
    if (!input) return;
    input.value = value;
    const position = Math.max(0, Math.min(value.length, caret));
    if (typeof input.setSelectionRange === "function") input.setSelectionRange(position, position);
    else {
      input.selectionStart = position;
      input.selectionEnd = position;
    }
    dispatchInput();
  }

  function scheduleSearch() {
    const current = session;
    generation += 1;
    const token = generation;
    abortSearch();
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (disposed || session !== current) return;
      void executeSearch(current, token);
    }, SEARCH_DEBOUNCE_MS);
  }

  async function executeSearch(current, token) {
    if (session !== current || token !== generation) return;
    if (typeof searchFiles !== "function") {
      current.searching = false;
      current.errorKey = "composerAssist.error.unavailable";
      render();
      return;
    }
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    searchAbort = controller;
    let result;
    try {
      result = await searchFiles({
        threadId: current.threadId,
        query: current.query,
        signal: controller ? controller.signal : undefined
      });
    } catch {
      if (disposed || session !== current || token !== generation || controller?.signal?.aborted) return;
      current.searching = false;
      current.errorKey = "composerAssist.fileError";
      render();
      return;
    }
    if (disposed || session !== current || token !== generation) return;
    if (controller && controller.signal && controller.signal.aborted) return;
    const live = context();
    if (live.stamp !== current.contextStamp || live.threadId !== current.threadId) return;
    const entries = Array.isArray(result?.entries) ? result.entries : [];
    current.items = entries.map(safeWorkspaceCandidate).filter(Boolean).slice(0, MAX_FILE_RESULTS);
    current.searching = false;
    current.errorKey = null;
    current.activeIndex = 0;
    render();
    attachPopup();
    syncAria();
  }

  function openSlash(token) {
    const live = context();
    const items = filterSlashCommands(commandList(), token.query);
    session = {
      kind: "slash",
      token,
      query: token.query,
      items,
      activeIndex: 0,
      threadId: live.threadId,
      contextStamp: live.stamp,
      searching: false,
      hintKey: null,
      errorKey: null
    };
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    abortSearch();
    show();
  }

  function openFile(token) {
    const live = context();
    let hintKey = null;
    if (!live.threadId) hintKey = live.connected ? "composerAssist.chooseChat" : "composerAssist.offline";
    session = {
      kind: "file",
      token,
      query: token.query,
      items: [],
      activeIndex: 0,
      threadId: live.threadId,
      contextStamp: live.stamp,
      searching: !hintKey,
      hintKey,
      errorKey: null
    };
    if (hintKey) {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      abortSearch();
      show();
      return;
    }
    show();
    scheduleSearch();
  }

  function refreshToken() {
    if (disposed) return;
    const value = typeof input?.value === "string" ? input.value : "";
    const token = findAssistToken(value, caretIndex());
    if (!token) {
      if (session) closePopup();
      return;
    }
    if (token.kind === "slash") openSlash(token);
    else openFile(token);
  }

  function clearCapturedSlash(current) {
    const value = typeof input?.value === "string" ? input.value : "";
    const token = current.token;
    if (value.slice(token.start, token.end) !== token.raw) return false;
    setInputValue(value.slice(0, token.start) + value.slice(token.end), token.start);
    return true;
  }

  function runSlash(current, command) {
    busy = true;
    const release = () => {
      busy = false;
    };
    const live = context();
    if (current.contextStamp !== live.stamp || (current.threadId !== null && current.threadId !== live.threadId)) {
      release();
      feedback("error", "composerAssist.error.contextChanged");
      return;
    }
    if (!live.connected) {
      release();
      feedback("error", "composerAssist.error.offline");
      return;
    }
    if (typeof command?.run !== "function") {
      release();
      feedback("error", "composerAssist.error.unavailable");
      return;
    }
    if (!commandEnabled(command)) {
      release();
      feedback("error", "composerAssist.error.disabled");
      return;
    }
    clearCapturedSlash(current);
    let result;
    try {
      result = command.run();
    } catch (error) {
      release();
      feedback("error", "composerAssist.error.failed");
      return;
    }
    if (result && typeof result.then === "function") {
      result.then(release, () => {
        release();
        feedback("error", "composerAssist.error.failed");
      });
    } else {
      release();
    }
  }

  function acceptFile(current, item) {
    const value = typeof input?.value === "string" ? input.value : "";
    const token = current.token;
    if (value.slice(token.start, token.end) !== token.raw) return false;
    const replacement = quoteWorkspaceReference(item.path);
    if (replacement === "") return false;
    const replaced = replaceAssistToken(value, token, replacement);
    setInputValue(replaced.text, replaced.caret);
    return true;
  }

  function accept(index) {
    const current = session;
    if (!current || disposed || busy) return false;
    const item = current.items[index];
    if (!item) return false;
    session = null;
    optionNodes = [];
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    abortSearch();
    generation += 1;
    detachPopup();
    restoreAria();
    if (current.kind === "slash") runSlash(current, item);
    else acceptFile(current, item);
    return true;
  }

  function selectIndex(index) {
    if (!session || disposed) return;
    if (!session.items[index]) return;
    session.activeIndex = index;
    updateSelection();
    accept(index);
  }

  function moveActive(delta) {
    if (!session) return;
    const count = session.items.length;
    if (count === 0) return;
    session.activeIndex = (session.activeIndex + delta + count) % count;
    updateSelection();
  }

  function onInput() {
    if (disposed || suppressDepth > 0 || composing) return;
    refreshToken();
  }

  function onKeyDown(event) {
    if (disposed || !session) return;
    if (composing || event?.isComposing === true) return;
    const key = event?.key;
    if (key === "ArrowDown" || key === "ArrowUp") {
      if (session.items.length === 0) return;
      moveActive(key === "ArrowDown" ? 1 : -1);
      event.preventDefault?.();
      return;
    }
    if (key === "Escape") {
      event.preventDefault?.();
      closePopup();
      return;
    }
    if (key === "Enter" || key === "Tab") {
      if (session.items.length === 0) return;
      const index = session.activeIndex;
      event.preventDefault?.();
      event.stopImmediatePropagation?.();
      accept(index);
    }
  }

  function onCompositionStart() {
    composing = true;
  }

  function onCompositionEnd() {
    composing = false;
    if (!disposed) refreshToken();
  }

  function isWithin(node, target) {
    let cursor = target;
    for (let depth = 0; cursor && depth < 32; depth += 1) {
      if (cursor === node) return true;
      cursor = cursor.parentNode || cursor.parent;
    }
    return false;
  }

  function onDocumentPointerDown(event) {
    if (disposed || !session || !popup) return;
    const target = event?.target;
    if (target && isWithin(popup, target)) return;
    closePopup();
  }

  function refresh() {
    if (disposed || !session) return;
    const value = typeof input?.value === "string" ? input.value : "";
    const token = findAssistToken(value, caretIndex());
    if (!token || token.kind !== session.kind) {
      closePopup();
      return;
    }
    session.token = token;
    session.query = token.query;
    if (session.kind === "slash") {
      session.items = filterSlashCommands(commandList(), token.query);
      if (session.items.length === 0) session.activeIndex = 0;
      else if (session.activeIndex >= session.items.length) session.activeIndex = session.items.length - 1;
    }
    show();
  }

  function close() {
    if (disposed && !session) return;
    closePopup();
  }

  function contextChanged() {
    if (disposed) return;
    closePopup();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    composing = false;
    busy = false;
    closePopup();
    for (const { target, type, handler } of listeners.splice(0)) {
      try {
        target.removeEventListener?.(type, handler);
      } catch {
        // Listener removal is best effort.
      }
    }
    detachPopup();
    optionNodes = [];
    popup = null;
    restoreAria();
  }

  listen(input, "input", onInput);
  listen(input, "keydown", onKeyDown);
  listen(input, "compositionstart", onCompositionStart);
  listen(input, "compositionend", onCompositionEnd);
  listen(document, "pointerdown", onDocumentPointerDown);

  return { refresh, close, contextChanged, dispose };
}
