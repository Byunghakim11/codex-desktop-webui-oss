import { createNativeControls } from "./native-controls.js";
import { createNativeLoopControls } from "./native-loop-controls.js";
import { createInputAssist } from "./input-assist.js";
import { createNativeThreadControls } from "./native-thread-controls.js";
import { createNativeUtilityControls } from "./native-utility-controls.js";

export const nativeWorkspaceMessages = {
  en: { "nativeWorkspace.goal": "Goal", "nativeWorkspace.loop": "Loops", "nativeWorkspace.files": "Project files", "nativeWorkspace.model": "Choose model", "nativeWorkspace.permissions": "Permission mode", "nativeWorkspace.search": "Search conversation", "nativeWorkspace.bookmarks": "Bookmarks", "nativeWorkspace.new": "New conversation" },
  ko: { "nativeWorkspace.goal": "목표", "nativeWorkspace.loop": "반복 작업", "nativeWorkspace.files": "프로젝트 파일", "nativeWorkspace.model": "모델 선택", "nativeWorkspace.permissions": "권한 모드", "nativeWorkspace.search": "대화 내 검색", "nativeWorkspace.bookmarks": "북마크", "nativeWorkspace.new": "새 대화" }
};

// Credentials stay in request headers; dialogs receive only safe native DTOs.
export function createNativeTransport({ getContext, fetchImpl = fetch }) {
  async function request(route, body) {
    const context = getContext();
    const headers = { "content-type": "application/json", "x-codex-webui": "1" };
    if (context.token) headers.authorization = `Bearer ${context.token}`;
    let response;
    try {
      response = await fetchImpl(`/api/native-actions/${route}`, { method: "POST", headers, credentials: "same-origin", redirect: "error", signal: AbortSignal.timeout(45000), body: JSON.stringify(body) });
    } catch { throw Object.assign(new Error("NATIVE_OUTCOME_UNKNOWN"), { code: "NATIVE_OUTCOME_UNKNOWN" }); }
    const live = getContext();
    if (live.threadId !== context.threadId || live.token !== context.token || live.connected !== true) {
      throw Object.assign(new Error("CONTEXT_CHANGED"), { code: "CONTEXT_CHANGED" });
    }
    let value;
    try { value = await response.json(); } catch { throw Object.assign(new Error("INVALID_NATIVE_RESPONSE"), { code: "INVALID_NATIVE_RESPONSE" }); }
    if (!response.ok) {
      const code = /^[A-Z][A-Z0-9_]{0,63}$/.test(value?.code || "") ? value.code : "NATIVE_ACTION_FAILED";
      throw Object.assign(new Error(code), { code, status: response.status });
    }
    return value;
  }
  return { getGoal: body => request("goal", body), describe: body => request("describe", body), prepareConfirmation: body => request("confirm", body), execute: body => request("execute", body) };
}

export function createNativeWorkspace({ document, input, menuHost, popupHost, getContext, t, registerMessages, fileClient, commands = {}, onFeedback, onChanged, onOpenThread }) {
  registerMessages?.(nativeWorkspaceMessages);
  const dialogHost = document.createElement("div");
  dialogHost.className = "native-dialog-host";
  document.body.append(dialogHost);
  const transport = createNativeTransport({ getContext });
  const goal = createNativeControls({ document, host: dialogHost, transport, getContext, t, registerMessages, onFeedback });
  const loops = createNativeLoopControls({ document, host: dialogHost, transport, getContext, t, registerMessages, onFeedback });
  const threads = createNativeThreadControls({ document, host: dialogHost, transport, getContext, t, registerMessages, onFeedback, onChanged, onOpenThread });
  const utilities = createNativeUtilityControls({ document, host: dialogHost, transport, getContext, t, registerMessages, onFeedback });
  const buttons = [];
  for (const [key, run] of [["goal", () => goal.openGoal()], ["loop", () => loops.openLoops()], ["tools",()=>utilities.open()]]) {
    const button = document.createElement("button");
    button.type = "button"; button.className = "secondary-action native-menu-action";
    button.dataset.nativeAction = key;
    button.addEventListener("click", () => { menuHost.closest("details")?.removeAttribute("open"); void run(); });
    menuHost.append(button); buttons.push([button, key]);
  }
  const context = () => ({ ...getContext(), key: `${getContext().threadId || ""}|${getContext().token || ""}|${getContext().cwd || ""}` });
  const assist = createInputAssist({ document, input, host: popupHost, t, registerMessages, getContext: context, onFeedback,
    getCommands: () => [
      { name: "goal", description: t("nativeWorkspace.goal"), run: () => goal.openGoal() },
      { name: "loop", description: t("nativeWorkspace.loop"), run: () => loops.openLoops() },
      ...["plan","mcp","memory","skills","plugins","apps","compact","review","status"].map(name=>({name,description:t(`nativeUtility.${name}`),run:()=>utilities.open(name)})),
      ...Object.entries(commands).map(([name, run]) => ({ name, description: t(`nativeWorkspace.${name}`), run }))
    ],
    searchFiles: async ({ threadId, query, signal }) => {
      const { context: root } = await fileClient.get("tree", { threadId, path: "" }, signal);
      return fileClient.get("search", { threadId, rootRevision: root.rootRevision, search: query }, signal);
    }
  });
  let stamp = "";
  function update() {
    const current = getContext();
    const next = `${current.threadId || ""}|${current.token || ""}|${current.cwd || ""}|${current.connected === true}`;
    if (stamp !== next) { stamp = next; goal.contextChanged(); loops.contextChanged(); threads.contextChanged(); utilities.contextChanged(); assist.contextChanged(); }
    for (const [button] of buttons) button.disabled = !current.threadId || current.connected !== true;
  }
  function refreshLabels() { for (const [button, key] of buttons) button.textContent = t(key==="tools"?"nativeUtility.tools":`nativeWorkspace.${key}`); goal.refreshLabels(); loops.refreshLabels(); threads.refreshLabels(); utilities.refreshLabels(); assist.close(); }
  update(); refreshLabels();
  return { transport, goal, loops, threads, utilities, update, refreshLabels, dispose() { goal.dispose(); loops.dispose(); threads.dispose(); utilities.dispose(); assist.dispose(); for (const [button] of buttons) button.remove(); dialogHost.remove(); } };
}
