import { currentLocale, initI18n, t } from "./i18n.js";
import { authenticatedUrl, authenticationAccepted, webSocketUrl, probeAccessSession } from "./access-auth.js";
import { isWebUserApproval } from "./approval-policy.js";
import { interactionKey } from "./interaction-contracts.js";
import { createInteractionController } from "./interactive-requests.js";
import { createWorkspacePanel } from "./workspace-panel.js";
import { asyncQuestions, parseQuestionReply, groupTimeline } from "./readable-timeline.js";
import { createAsyncQuestionCards } from "./async-question-cards.js";
import { sendQuestionAnswer } from "./question-transport.js";
import { createCompanionApps } from "./companion-apps.js";
import { createProjectFilesClient } from "./project-files-client.js";
import { createConversationTools } from "./conversation-tools.js";
import { createCommandRegistry, createUiNavigation } from "./ui-navigation.js";
import { createComposerDraftController, createConversationSnapshotCache, WORKFLOW_FEATURES } from "./workflow-tools.js";
import { loadInitialView, restoreOwnedThread, recoverThreadPage, shouldRecoverThread, latestCachedPage, MANIFEST_REFRESH_MS, BACKGROUND_REFRESH_MS } from "./performance-policy.js";
import {
  buildInterruptRequest,
  buildPromptRequest,
  shouldAdvanceQueueAfterTurn,
  waitForPendingImageUploads
} from "./follow-up.js";
import { formatResetTime, normalizeRateLimits, rateLimitWindowLabel } from "./rate-limits.js";
import { projectGroupRank, projectOverflowAction, sortProjectGroupsByActivity } from "./sidebar-projects.js";
import {
  ACTIVE_THREAD_SYNC_MS,
  IDLE_THREAD_SYNC_MS,
  activeTurnIdFromLatest,
  anchoredHistoryScrollTop,
  createLatestFrameBatcher,
  createReadinessGate,
  createRecentThreadCache,
  disclosureIdentity,
  findTransientMessageAliasIndex,
  initialThreadCandidates,
  liveFollowState,
  mergeRecentMessages,
  mergeMessageClassification,
  restoreFirstUsableThread,
  selectThreadCachePrewarmIds,
  shouldAutoLoadOlderTurns,
  shouldRefreshCachedThread,
  shouldRenderThreadLoadOverlay,
  threadSyncDelay,
  turnLifecycle,
  updateDisclosureState
} from "./thread-sync.js";
import {
  THREAD_ACTIVITY,
  activityPriority,
  completionNotificationKey,
  createThreadActivity,
  reduceThreadActivity,
  shouldNotifyCompletion
} from "./thread-activity.js";
import {
  availablePermissionModes,
  buildSharedThreadStart,
  buildThreadSettingsUpdate,
  permissionModeFromSettings,
  threadSettingsFromNotification,
  threadSettingsFromResume
} from "./thread-settings.js";
const byteEncoder = new TextEncoder();
const TURN_PAGE_LIMIT = 6;
const TURN_ITEMS_VIEW = "full";
const THEME_STORAGE_KEY = "codex-webui-theme";
const LAST_THREAD_STORAGE_KEY = "codex-webui-last-thread-id";
const TOKEN_STORAGE_KEY = "codex-webui-access-token";
const THREAD_URL_PARAM = "thread";
const COLLAPSED_PROJECTS_STORAGE_KEY = "codex-webui-collapsed-projects";
const IMAGE_UPLOAD_TARGET_BYTES = 1400 * 1024;
const IMAGE_UPLOAD_MAX_EDGE = 1800;
const IMAGE_UPLOAD_MAX_PIXELS = 2400000;
const IMAGE_UPLOAD_JPEG_QUALITIES = [0.84, 0.74, 0.64];
const RECENT_THREAD_CACHE_LIMIT = 16;
const BACKGROUND_CACHE_CONCURRENCY = 1;
const PREWARM_THREAD_LIMIT = 4;
const BACKGROUND_CACHE_NOTIFICATION_METHODS = new Set([
  "item/agentMessage/delta",
  "item/started",
  "item/completed",
  "turn/started",
  "turn/completed"
]);

const state = {
  compactActivity: true,
  initialSettingsLoading: false,
  initialSettingsBarrier: null,
  lastThreadPushAt: new Map(),
  lastThreadRecoveryAt: new Map(),
  backgroundCacheLastReadAt: new Map(),
  ws: null,
  token: null,
  authMode: "",
  nextRequestId: 1,
  pending: new Map(),
  threads: [],
  expandedProjects: new Set(),
  collapsedProjects: storedCollapsedProjects(),
  pendingImages: [],
  currentThread: null,
  lastMessageAt: null,
  loadingThreadId: null,
  threadContentGate: null,
  sendingThreadId: null,
  interruptingTurnId: null,
  initialThreadRestorePending: true,
  threadLoadSeq: 0,
  threadLoadStats: null,
  lastLoadStats: null,
  turnCursor: null,
  hasOlderTurns: false,
  loadingOlderTurns: false,
  historyAutoLoadArmed: false,
  followLiveOutput: true,
  openDisclosures: new Set(),
  resumingThreadId: null,
  loadedTurnIds: new Set(),
  recentThreadCache: createRecentThreadCache(RECENT_THREAD_CACHE_LIMIT),
  threadSettingsCache: createRecentThreadCache(RECENT_THREAD_CACHE_LIMIT),
  backgroundCacheQueue: [],
  backgroundCacheQueued: new Set(),
  backgroundCacheInFlight: new Set(),
  backgroundCacheTimers: new Map(),
  activeTurns: new Map(),
  queueStartingThreadIds: new Set(),
  threadActivity: new Map(),
  pendingRequestThreads: new Map(),
  notificationKeys: new Set(),
  replyProgressThreadIds: new Set(),
  turnDiagnostics: new Map(),
  messages: [],
  models: [],
  permissionProfiles: [],
  permissionModes: [],
  configRequirements: null,
  currentThreadSettings: null,
  applyingThreadSettings: false,
  settingsSaving: false,
  pendingSettingsSelection: null,
  threadSettingsAvailable: false,
  workspaceBrowserAvailable: false,
  config: null,
  threadFilterCwds: [],
  connected: false,
  account: null,
  rateLimits: { windows: [], planType: "", credits: null },
  rateLimitsError: "",
  urlThreadId: "",
  desktopBridgeConnected: true,
  desktopBridgeReconnecting: false,
  threadSyncTimer: null,
  threadSyncInFlight: false,
  threadListSyncInFlight: false,
  lastThreadListSyncAt: 0
};

let threadTitleScrollFrame = null;
let threadTitleScrollTimer = null;
let threadTitleBeforeEdit = "";
let threadTitleSaving = false;
let backGuardSerial = 0;
let backGuardBaseUrl = "";
let backGuardHandling = false;
let backGuardArmedAt = 0;
let backSentinels = [];
let backSentinelReopening = false;
const BACK_GUARD_HASH_PREFIX = "codex-webui-stay-";
const BACK_SENTINEL_COUNT = 4;

const els = {
  connection: document.querySelector("#connection"),
  connectionBanner: document.querySelector("#connectionBanner"),
  threadList: document.querySelector("#threadList"),
  searchThreads: document.querySelector("#searchThreads"),
  newThread: document.querySelector("#newThread"),
  refreshThreads: document.querySelector("#refreshThreads"),
  openSidebar: document.querySelector("#openSidebar"),
  closeSidebar: document.querySelector("#closeSidebar"),
  sidebar: document.querySelector("#sidebar"),
  messages: document.querySelector("#messages"),
  composer: document.querySelector("#composer"),
  promptInput: document.querySelector("#promptInput"),
  followUpMenu: document.querySelector("#followUpMenu"),
  sendButton: document.querySelector("#sendButton"),
  chatPane: document.querySelector(".chat-pane"),
  setupBand: document.querySelector("#setupBand"),
  settingsToggle: null,
  imageInput: null,
  imageTray: null,
  cwdInput: document.querySelector("#cwdInput"),
  projectSelect: document.querySelector("#projectSelect"),
  contextSettingLabel: document.querySelector("#contextSettingLabel"),
  currentConversationSummary: document.querySelector("#currentConversationSummary"),
  workspaceSettingControls: document.querySelector("#workspaceSettingControls"),
  modelSelect: document.querySelector("#modelSelect"),
  reasoningSelect: document.querySelector("#reasoningSelect"),
  permissionSelect: document.querySelector("#permissionSelect"),
  browseWorkspace: document.querySelector("#browseWorkspace"),
  workspacePicker: document.querySelector("#workspacePicker"),
  workspacePickerBackdrop: document.querySelector("#workspacePickerBackdrop"),
  workspacePickerClose: document.querySelector("#workspacePickerClose"),
  workspaceCurrentPath: document.querySelector("#workspaceCurrentPath"),
  workspaceRoots: document.querySelector("#workspaceRoots"),
  workspaceParent: document.querySelector("#workspaceParent"),
  workspaceUseCurrent: document.querySelector("#workspaceUseCurrent"),
  workspaceDirectoryList: document.querySelector("#workspaceDirectoryList"),
  workspaceCreateForm: document.querySelector("#workspaceCreateForm"),
  workspaceName: document.querySelector("#workspaceName"),
  workspaceError: document.querySelector("#workspaceError"),
  threadTitle: document.querySelector("#threadTitle"),
  threadMeta: document.querySelector("#threadMeta"),
  resumeStatus: document.querySelector("#resumeStatus"),
  fullscreenToggle: document.querySelector("#fullscreenToggle"),
  imageViewer: document.querySelector("#imageViewer"),
  imageViewerImg: document.querySelector("#imageViewerImg"),
  imageViewerBackdrop: document.querySelector("#imageViewerBackdrop"),
  imageViewerClose: document.querySelector("#imageViewerClose"),
  themeSelect: document.querySelector("#themeSelect"),
  trafficSummary: document.querySelector("#trafficSummary"),
  authPanel: document.querySelector("#authPanel"),
  authText: document.querySelector("#authText"),
  deviceLogin: document.querySelector("#deviceLogin"),
  approvalPanel: document.querySelector("#approvalPanel"),
  usageCard: document.querySelector("#usageCard"),
  usagePlan: document.querySelector("#usagePlan"),
  usageWindows: document.querySelector("#usageWindows"),
  usageRefresh: document.querySelector("#usageRefresh"),
  toastRegion: document.querySelector("#toastRegion")
};

const interactionController = createInteractionController({ container: els.approvalPanel, sendResponse: sendServerResponse, t });
let workspacePanel;
let conversationTools, workflowNavigation, composerDrafts;
let workflowRevision = 0, workflowDraftSerial = 0;

function workflowInput() {
  return { threadKey: state.currentThread?.id || `draft-${workflowDraftSerial}`, revision: `${state.threadLoadSeq}:${workflowRevision}:${state.connected}:${state.desktopBridgeConnected}`, messages: state.messages, activeTurnId: state.activeTurns.get(state.currentThread?.id), title: state.currentThread?.name || state.currentThread?.preview || t("thread.untitled") };
}

const workflowSnapshotCache = createConversationSnapshotCache({ getInput: workflowInput });
function workflowSnapshot() {
  return workflowSnapshotCache.get();
}
function invalidateWorkflow() {
  workflowRevision++; workflowSnapshotCache.invalidate();
}
function refreshWorkflow() { invalidateWorkflow(); conversationTools?.update(); }

function workflowNotice(text) {
  const output = document.querySelector("#workflowFeedback");
  output.querySelector("span").textContent = text; output.hidden = false;
  updateMobileChromeMetrics();
}

function initializeWorkflow() {
  const menu = document.querySelector("#workflowMenu"), host = document.querySelector("#workflowMenuBody");
  const registry = createCommandRegistry();
  const closeMenu = () => { menu.open = false; };
  const reveal = (messageKey, { threadKey }) => {
    if (state.currentThread?.id !== threadKey) return "stale";
    const node = [...els.messages.querySelectorAll("[data-message-id]")].find(item => item.dataset.messageId === messageKey);
    if (!node) return "not-loaded";
    state.followLiveOutput = liveFollowState({ current: state.followLiveOutput, userReading: true, nearBottom: false });
    state.historyAutoLoadArmed = false;
    node.scrollIntoView({ block: "center", behavior: "instant" }); return "revealed";
  };
  conversationTools = createConversationTools({ document, host, dialogHost: document.body, getSnapshot: workflowSnapshot, revealMessage: reveal, t, onFeedback: workflowNotice, features: WORKFLOW_FEATURES });
  menu.hidden = !["F01","F04","F05","F06","F09","F10","F14","F15"].some(key => WORKFLOW_FEATURES[key]);
  document.querySelector("#workflowSearchHost").append(host.querySelector(".wf-conversation-search"));
  workflowNavigation = createUiNavigation({ document, host, registry, t, features: WORKFLOW_FEATURES, getReadingTarget: () => els.messages,
    onReadingChange({ apply }) {
      const top = els.messages.getBoundingClientRect().top;
      const anchor = [...els.messages.querySelectorAll(".message[data-message-id]")].find(node => node.getBoundingClientRect().bottom > top);
      const offset = anchor?.getBoundingClientRect().top;
      apply();
      if (anchor?.isConnected) els.messages.scrollTop += anchor.getBoundingClientRect().top - offset;
    }
  });
  const commands = [
    ["F01", "conversation.search", "wf.search", () => conversationTools.openSearch()],
    ["F06", "conversation.outline", "wf.outline", () => conversationTools.openOutline()],
    ["F05", "conversation.bookmarks", "wf.bookmarks", () => conversationTools.openBookmarks()],
    ["F04", "conversation.export", "wf.export", () => conversationTools.openExportPreview()],
    ["F11", "files.bodySearch", "files.bodySearch", () => workspacePanel.focusTextSearch(), () => Boolean(workspacePanel?.getTools()?.text)],
    ["F12", "files.line", "files.goToLine", () => workspacePanel.focusTextLine(), () => Boolean(workspacePanel?.getTools()?.text)],
    ["F13", "files.pdfPage", "files.pageNumber", () => workspacePanel.focusPdfPage(), () => Boolean(workspacePanel?.getTools()?.pdf?.getState())]
  ];
  for (const [feature, id, label, run, available] of commands) if (WORKFLOW_FEATURES[feature]) registry.register({ id, label: t(label), disabledReason: t("workflow.openFileFirst"), enabled: () => !available || available(), run: () => { closeMenu(); run(); updateMobileChromeMetrics(); } });
  // Modal openers must remain visible after the dropdown closes. Capture before
  // component click handlers so dialogs remember the stable Tools summary.
  host.addEventListener("click", event => { if (event.target.closest("button")) { closeMenu(); menu.querySelector("summary").focus(); updateMobileChromeMetrics(); } }, true);
  document.querySelector("#workflowSearchHost").addEventListener("click", updateMobileChromeMetrics);
  document.querySelector("#workflowFeedback button").addEventListener("click", () => { document.querySelector("#workflowFeedback").hidden = true; updateMobileChromeMetrics(); });
  composerDrafts = createComposerDraftController({ input: els.promptInput, features: WORKFLOW_FEATURES,
    blocked: () => Boolean(state.pendingImages.length || state.sendingThreadId),
    changed: () => { resizePromptInput(); updateFollowUpOptions(); },
    notify: status => {
      const entries = composerDrafts?.metadata() || [], deadlines = entries.filter(entry => !entry.active && entry.status === "saved").map(entry => entry.expiresAt);
      const expiry = deadlines.length ? t("draft.nextExpiry", { minutes: Math.max(0, Math.ceil((Math.min(...deadlines) - Date.now()) / 60000)) }) : "";
      document.querySelector("#workflowDraftStatus").textContent = `${t(`draft.${status}`)} ${expiry}`; updateMobileChromeMetrics();
    }
  });
  composerDrafts.switchThread("initial");
  for (const [id, action] of [["workflowClear", "clear"], ["workflowUndo", "undoClear"], ["workflowForget", "forget"]]) document.querySelector(`#${id}`).addEventListener("click", () => { composerDrafts[action](); els.promptInput.focus(); });
  document.querySelector("#workflowClear").hidden = !WORKFLOW_FEATURES.F08;
  document.querySelector("#workflowUndo").hidden = !WORKFLOW_FEATURES.F08;
  document.querySelector("#workflowForget").hidden = !WORKFLOW_FEATURES.F07;
  document.querySelector("#workflowRecover").hidden = !WORKFLOW_FEATURES.F07;
  document.querySelector("#workflowDraftControls").hidden = !WORKFLOW_FEATURES.F07 && !WORKFLOW_FEATURES.F08;
  document.querySelector("#workflowRecover").addEventListener("click", () => {
    const previous = composerDrafts.getRecovery();
    if (!previous) { workflowNotice(t("draft.noRecovery")); return; }
    const dialog = document.createElement("dialog"); dialog.className = "wf-dialog workflow-recovery";
    const heading = document.createElement("h2"); heading.id = "workflowRecoveryTitle"; heading.textContent = t("draft.recovery");
    dialog.setAttribute("aria-labelledby", heading.id);
    const field = document.createElement("textarea"); field.readOnly = true; field.value = previous.text; field.setAttribute("aria-label", t("draft.recovery"));
    const close = document.createElement("button"); close.type = "button"; close.textContent = t("wf.close"); close.addEventListener("click", () => dialog.close());
    dialog.append(heading, field, close); document.body.append(dialog);
    dialog.addEventListener("close", () => { dialog.remove(); document.querySelector("#workflowRecover").focus(); }, { once: true });
    dialog.showModal(); field.focus(); field.select();
  });
  window.addEventListener("pagehide", event => { if (!event.persisted) { conversationTools.dispose(); workflowNavigation.dispose(); composerDrafts.dispose(); } });
}

function recordWorkflowMetric(kind, startedAt, itemCount = 0) {
  if (WORKFLOW_FEATURES.F15) workflowNavigation?.recordMetric({ kind, atMs: Date.now(), durationMs: Math.max(0, performance.now() - startedAt), itemCount });
}

const streamingRenderBatcher = createLatestFrameBatcher({
  scheduleFrame: (callback) => window.requestAnimationFrame(callback),
  cancelFrame: (handle) => window.cancelAnimationFrame(handle),
  render: ({ threadId, itemId, scroll }) => {
    if (state.currentThread?.id !== threadId) return;
    const message = state.messages.find((entry) => entry.id === itemId);
    if (!patchStreamingMessage(message, scroll)) renderMessages(scroll);
  }
});

boot();

async function boot() {
  initI18n();
  window.addEventListener("languagechange", () => window.location.reload());
  const url = new URL(window.location.href);
  const urlToken = tokenFromUrl(url);
  if (urlToken) rememberAccessToken(urlToken);
  state.token = urlToken || storedAccessToken();
  state.urlThreadId = url.searchParams.get(THREAD_URL_PARAM) || "";

  const infoUrl = state.token ? `/api/info?token=${encodeURIComponent(state.token)}` : "/api/info";
  const info = await fetch(infoUrl).then((res) => res.json()).catch(() => null);
  state.authMode = String(info?.authMode || "");
  workspacePanel = createWorkspacePanel({ panel: document.querySelector("#filesPanel"), toggle: document.querySelector("#filesToggle"), shell: document.querySelector(".app-shell"), client: createProjectFilesClient({ getToken: () => state.token, getAuthMode: () => state.authMode }), t, features: WORKFLOW_FEATURES });
  createCompanionApps({container:document.querySelector("#companionApps"),t});
  try { state.compactActivity = localStorage.getItem("codex-compact-activity") !== "false"; } catch {}
  const activityToggle=document.querySelector("#activityToggle");
  activityToggle.setAttribute("aria-pressed",String(state.compactActivity));
  activityToggle.addEventListener("click",()=>{state.compactActivity=!state.compactActivity;activityToggle.setAttribute("aria-pressed",String(state.compactActivity));try{localStorage.setItem("codex-compact-activity",String(state.compactActivity));}catch{}renderMessages(false);});
  workspacePanel.setAvailable(Boolean(info?.capabilities?.projectFiles));
  state.desktopBridgeConnected = null;
  state.threadSettingsAvailable = Boolean(info?.capabilities?.threadSettings);
  state.workspaceBrowserAvailable = Boolean(info?.capabilities?.workspaceBrowser);
  state.threadFilterCwds = scopeCwdsFrom(info);
  if (info?.defaultCwd) {
    els.cwdInput.value = info.defaultCwd;
  }

  setupTheme();
  initializeWorkflow();
  bindUi();
  applyBridgeModeUi();
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopCurrentThreadSync();
    else {
      scheduleCurrentThreadSync(0);
      refreshThreadManifestIfDue();
      pumpBackgroundThreadCache();
    }
  });
  window.addEventListener("focus", () => {
    scheduleCurrentThreadSync(0);
    refreshThreadManifestIfDue();
  });

  if (!authenticationAccepted(info)) {
    setConnection("connection.missingToken");
    renderEmpty(t("connection.tokenRequiredTitle"), t("connection.tokenRequiredDescription"));
    return;
  }

  connect();
}

function tokenFromHash(hash) {
  const value = String(hash || "");
  const match = /[#&]token=([^&]+)/.exec(value);
  return match ? decodeURIComponent(match[1]) : "";
}

function tokenFromUrl(url) {
  return url.searchParams.get("token") || tokenFromHash(url.hash);
}

function storedAccessToken() {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

function rememberAccessToken(token) {
  try {
    localStorage.setItem(TOKEN_STORAGE_KEY, token);
  } catch {
    // Some private browsing modes can disable localStorage.
  }
}

function connect() {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const socketUrl = webSocketUrl(window.location, state.token);
  const ws = new WebSocket(socketUrl);
  state.ws = ws;
  let opened = false;
  const startedAt = performance.now();
  console.info("[codex-webui:ws]", {
    event: "connecting",
    url: state.token
      ? `${protocol}//${window.location.host}/ws?token=[redacted]`
      : `${protocol}//${window.location.host}/ws`,
    page: window.location.href
  });
  setConnection("connection.connecting");

  ws.addEventListener("open", () => {
    opened = true;
    state.connected = true;
    interactionController.setConnected(true);
    asyncQuestionCards.refresh();
    console.info("[codex-webui:ws]", {
      event: "open",
      elapsedMs: Math.round(performance.now() - startedAt)
    });
    setConnection("connection.connected");
    initialLoad().finally(() => scheduleCurrentThreadSync(0));
  });

  ws.addEventListener("message", (event) => {
    const raw = typeof event.data === "string" ? event.data : "";
    try {
      handleMessage(JSON.parse(event.data), raw ? byteLengthText(raw) : 0);
    } catch (error) {
      addSystemMessage(error.message || t("connection.parseError"));
    }
  });
  ws.addEventListener("close", async () => {
    if (state.ws !== ws) return;
    state.connected = false;
    interactionController.setConnected(false);
    asyncQuestionCards.refresh();
    workspacePanel?.setConnected(false);
    stopCurrentThreadSync();
    console.warn("[codex-webui:ws]", {
      event: "close",
      opened,
      pendingRequests: state.pending.size,
      elapsedMs: Math.round(performance.now() - startedAt),
      online: navigator.onLine
    });
    rejectPendingRequests(new Error(t("connection.disconnected")));
    if (!opened) {
      if (state.authMode === "cloudflare-access") {
        const session = await probeAccessSession(() => fetch(authenticatedUrl("/api/info", state.token), { credentials: "same-origin", cache: "no-store", redirect: "manual", signal: AbortSignal.timeout(6000) }));
        if (state.ws !== ws) return;
        if (session === "auth-required") {
          setConnection("connection.accessSessionInvalid");
          if (!state.currentThread) renderEmpty(t("connection.accessSessionInvalidTitle"), t("connection.accessSessionInvalidDescription"));
        } else {
          setConnection("connection.transportUnavailable");
          setTimeout(() => { if (state.ws === ws) connect(); }, 3000);
        }
      } else {
        state.token = null;
        setConnection("connection.invalidToken");
        renderEmpty(t("connection.invalidToken"), t("connection.invalidTokenDescription"));
      }
      return;
    }
    setConnection("connection.reconnecting");
    setTimeout(() => { if (state.ws === ws) connect(); }, 3000);
  });
  ws.addEventListener("error", () => {
    console.warn("[codex-webui:ws]", {
      event: "error",
      opened,
      readyState: ws.readyState,
      online: navigator.onLine
    });
    setConnection("connection.error");
  });
}

async function initialLoad() {
  let releaseSettings;state.initialSettingsBarrier=new Promise(resolve=>{releaseSettings=resolve;});state.initialSettingsLoading=true;applyBridgeModeUi();
  try {
    await loadInitialView({
      loadManifest: loadThreads,
      loadSettings:()=>Promise.allSettled([loadModels(),loadConfig(),loadPermissionModes(),loadAccount(),loadRateLimits()]),
      afterSettings:results=>{for(const result of results)if(result.status==="rejected")addSystemMessage(result.reason?.message||t("error.initialize"));const pending=state.pendingSettingsSelection;if(pending?.threadId===state.currentThread?.id){setModelValue(pending.model,pending.effort);renderPermissionModes(pending.permissionMode);}else if(state.currentThreadSettings)applyThreadSettings(state.currentThreadSettings);else applyConfigDefaults();},
      onSettingsSettled:()=>{state.initialSettingsLoading=false;releaseSettings();applyBridgeModeUi();},
      openExplicit:async()=>{
        if(state.currentThread?.id||state.currentThread?.draft)return true;
        const ids=[...new Set([state.urlThreadId,storedLastThreadId()])].filter(id=>typeof id==="string"&&id&&id.length<=256);
        const restored=await restoreOwnedThread(ids,id=>openThread(id,{showFailure:false}),()=>state.threadLoadSeq);
        if(restored.cancelled)return true;
        if(!restored.opened&&restored.version===state.threadLoadSeq&&!state.currentThread?.draft){state.currentThread=null;updateThreadHeader();}
        return restored.opened;
      },
      openFallback:restoreInitialThread,
      onError:error=>addSystemMessage(error.message||t("error.initialize"))
    });
  } finally {
    state.initialSettingsLoading=false;releaseSettings();applyBridgeModeUi();
    state.initialThreadRestorePending = false;
    els.sendButton.disabled = isSendBlocked();
  }
}

function bindUi() {
  setupImageComposer();
  setupMobileViewport();
  setupBackButtonGuard();
  updateFullscreenToggle();
  els.newThread.addEventListener("click", () => {
    if (createThread() === false) return;
    if (state.workspaceBrowserAvailable) openWorkspacePicker();
  });
  els.refreshThreads?.addEventListener("click", refreshAll);
  els.resumeStatus?.addEventListener("click", async () => {
    try {
      if (state.desktopBridgeConnected === false) {
        await reconnectDesktopBridge();
        return;
      }
      await resumeCurrentThread();
    } catch {
      // resumeCurrentThread already reports the visible error.
    }
  });
  els.searchThreads.addEventListener("input", renderThreads);
  els.openSidebar.addEventListener("click", () => els.sidebar.classList.add("open"));
  els.closeSidebar.addEventListener("click", () => els.sidebar.classList.remove("open"));
  els.deviceLogin.addEventListener("click", startDeviceLogin);
  els.usageRefresh?.addEventListener("click", loadRateLimits);
  els.themeSelect.addEventListener("change", () => setThemePreference(els.themeSelect.value));
  els.fullscreenToggle?.addEventListener("click", toggleFullscreen);
  document.addEventListener("fullscreenchange", updateFullscreenToggle);
  document.addEventListener("webkitfullscreenchange", updateFullscreenToggle);
  els.projectSelect.addEventListener("change", () => {
    if (state.pendingImages.length || state.sendingThreadId) { setProjectSelection(state.currentThread?.cwd || ""); workflowNotice(t("draft.attachments-or-send")); return; }
    if (state.currentThread?.draft) {
      state.currentThread.cwd = els.projectSelect.value;
      loadPermissionModes(state.currentThread.cwd).catch((error) => addSystemMessage(error.message));
      updateThreadHeader();
      renderEmpty(
        t("thread.new"),
        state.currentThread.cwd
          ? t("empty.newThreadProject", { project: projectFromCwd(state.currentThread.cwd).name })
          : t("empty.noProject")
      );
    }
  });
  els.modelSelect.addEventListener("change", () => {
    updateReasoningOptions("", { useModelDefault: true });
    persistSelectedThreadSettings();
  });
  els.reasoningSelect.addEventListener("change", persistSelectedThreadSettings);
  els.permissionSelect.addEventListener("change", async () => {
    if (
      els.permissionSelect.value === "full-access"
      && !window.confirm(t("permission.fullAccessConfirm"))
    ) {
      applyAuthoritativeThreadSettings();
      return;
    }
    await persistSelectedThreadSettings();
  });
  els.browseWorkspace.addEventListener("click", openWorkspacePicker);
  els.workspacePickerBackdrop.addEventListener("click", closeWorkspacePicker);
  els.workspacePickerClose.addEventListener("click", closeWorkspacePicker);
  els.workspaceRoots.addEventListener("click", () => loadWorkspaceDirectory(""));
  els.workspaceParent.addEventListener("click", () => {
    const parent = els.workspaceParent.dataset.path || "";
    loadWorkspaceDirectory(parent);
  });
  els.workspaceUseCurrent.addEventListener("click", useCurrentWorkspace);
  els.workspaceCreateForm.addEventListener("submit", createAndUseWorkspace);
  els.messages.addEventListener("scroll", () => {
    state.followLiveOutput = liveFollowState({
      current: state.followLiveOutput,
      userReading: false,
      nearBottom: isMessagesNearBottom(40)
    });
    if (shouldAutoLoadOlderTurns({
      armed: state.historyAutoLoadArmed,
      scrollTop: els.messages.scrollTop,
      hasCursor: Boolean(state.turnCursor),
      loading: state.loadingOlderTurns
    })) {
      loadOlderTurns();
    }
  });
  els.messages.addEventListener("wheel", (event) => {
    if (event.deltaY < 0) {
      state.historyAutoLoadArmed = true;
      state.followLiveOutput = liveFollowState({ current: state.followLiveOutput, userReading: true, nearBottom: false });
    }
  }, { passive: true });
  els.messages.addEventListener("touchstart", () => {
    state.historyAutoLoadArmed = true;
    state.followLiveOutput = liveFollowState({ current: state.followLiveOutput, userReading: true, nearBottom: false });
  }, { passive: true });
  els.messages.addEventListener("pointerdown", () => {
    state.historyAutoLoadArmed = true;
    state.followLiveOutput = liveFollowState({ current: state.followLiveOutput, userReading: true, nearBottom: false });
  }, { passive: true });
  els.messages.addEventListener("keydown", (event) => {
    if (["ArrowUp", "PageUp", "Home"].includes(event.key)) {
      state.historyAutoLoadArmed = true;
      state.followLiveOutput = liveFollowState({ current: state.followLiveOutput, userReading: true, nearBottom: false });
    }
  });

  els.threadTitle.addEventListener("focus", () => {
    threadTitleBeforeEdit = els.threadTitle.value;
    stopThreadTitleMarquee(true);
  });
  els.threadTitle.addEventListener("keydown", async (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter") {
      event.preventDefault();
      await commitThreadTitle();
      els.threadTitle.blur();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      cancelThreadTitleEdit();
      els.threadTitle.blur();
    }
  });
  els.threadTitle.addEventListener("blur", async () => {
    await commitThreadTitle();
    scrollThreadTitleToEnd();
  });
  window.addEventListener("resize", scrollThreadTitleToEnd);

  els.composer.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (state.desktopBridgeConnected !== true) {
      addSystemMessage(t("error.desktopBridgeOffline"));
      return;
    }
    const threadId = state.currentThread?.id;
    if (threadId && state.activeTurns.has(threadId)) {
      setFollowUpMenuOpen(true);
      return;
    }
    const text = els.promptInput.value.trim();
    if (!text && !state.pendingImages.length) return;
    try {
      await sendTurn(text);
    } catch (error) {
      addSystemMessage(error.message || t("error.send"));
    }
  });

  els.followUpMenu?.addEventListener("click", async (event) => {
    const option = event.target.closest("[data-follow-up-mode]");
    if (!option) return;
    if (state.desktopBridgeConnected !== true) {
      addSystemMessage(t("error.desktopBridgeOffline"));
      return;
    }
    const mode = option.dataset.followUpMode;
    if (mode === "stop") {
      setFollowUpMenuOpen(false);
      await interruptActiveTurn();
      return;
    }
    const text = els.promptInput.value.trim();
    if (!text && !state.pendingImages.length) return;
    const queue = mode === "queue";
    const expectedActiveTurnId = state.activeTurns.get(state.currentThread?.id) || null;
    setFollowUpMenuOpen(false);
    try {
      await sendTurn(text, { queue, expectedActiveTurnId });
    } catch (error) {
      addSystemMessage(error.message || t("error.send"));
    }
  });

  document.addEventListener("pointerdown", (event) => {
    if (els.followUpMenu?.classList.contains("hidden")) return;
    if (els.followUpMenu.contains(event.target) || els.sendButton.contains(event.target)) return;
    setFollowUpMenuOpen(false);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") setFollowUpMenuOpen(false);
  });

  els.promptInput.addEventListener("input", () => {
    resizePromptInput();
    updateFollowUpOptions();
  });
  els.promptInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    submitComposer();
  });
  els.promptInput.addEventListener("paste", async (event) => {
    const files = [...(event.clipboardData?.files || [])].filter((file) => file.type.startsWith("image/"));
    if (!files.length) return;
    event.preventDefault();
    await addImages(files);
  });
  els.composer.addEventListener("dragover", (event) => {
    event.preventDefault();
    els.composer.classList.add("dragging");
  });
  els.composer.addEventListener("dragleave", () => {
    els.composer.classList.remove("dragging");
  });
  els.composer.addEventListener("drop", async (event) => {
    event.preventDefault();
    els.composer.classList.remove("dragging");
    await addImages([...(event.dataTransfer?.files || [])]);
  });
  els.imageViewerBackdrop?.addEventListener("click", closeImageViewer);
  els.imageViewerClose?.addEventListener("click", closeImageViewer);
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeImageViewer();
  });
}

async function toggleFullscreen() {
  const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement;
  try {
    if (fullscreenElement) {
      await exitFullscreen();
    } else {
      const target = document.documentElement;
      if (target.requestFullscreen) {
        try {
          await target.requestFullscreen({ navigationUI: "hide" });
        } catch (error) {
          if (error instanceof TypeError) await target.requestFullscreen();
          else throw error;
        }
      } else if (target.webkitRequestFullscreen) {
        await target.webkitRequestFullscreen();
      }
    }
  } catch (error) {
    addSystemMessage(error.message || t("fullscreen.error"));
  } finally {
    updateFullscreenToggle();
  }
}

function updateFullscreenToggle() {
  if (!els.fullscreenToggle) return;
  const canFullscreen = Boolean(
    document.fullscreenEnabled
    || document.webkitFullscreenEnabled
    || document.documentElement.requestFullscreen
    || document.documentElement.webkitRequestFullscreen
  );
  const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement;
  document.documentElement.classList.toggle("fullscreen-active", Boolean(fullscreenElement));
  els.fullscreenToggle.disabled = !canFullscreen;
  els.fullscreenToggle.classList.toggle("active", Boolean(fullscreenElement));
  els.fullscreenToggle.title = t(fullscreenElement ? "fullscreen.exit" : "fullscreen.enter");
  els.fullscreenToggle.setAttribute("aria-label", t(fullscreenElement ? "fullscreen.exit" : "fullscreen.enter"));
}

function setupMobileViewport() {
  let largestVisualHeight = window.visualViewport?.height || window.innerHeight;
  let largestInnerHeight = window.innerHeight;
  let lastViewportLog = "";
  let pendingBottomDistance = null;

  const captureBottomDistance = () => {
    if (!els.messages || pendingBottomDistance !== null) return;
    pendingBottomDistance = Math.max(
      0,
      els.messages.scrollHeight - els.messages.scrollTop - els.messages.clientHeight
    );
  };

  const restoreBottomDistance = () => {
    if (!els.messages || pendingBottomDistance === null) return;
    const distance = pendingBottomDistance;
    pendingBottomDistance = null;
    const maxScrollTop = Math.max(0, els.messages.scrollHeight - els.messages.clientHeight);
    els.messages.scrollTop = Math.max(0, maxScrollTop - distance);
  };

  const syncViewport = () => {
    const viewport = window.visualViewport;
    const visualHeight = viewport?.height || window.innerHeight;
    const visualOffsetTop = viewport?.offsetTop || 0;
    const visualBottom = visualOffsetTop + visualHeight;
    const promptFocused = document.activeElement === els.promptInput;
    if (!promptFocused) {
      largestVisualHeight = Math.max(largestVisualHeight, visualHeight);
      largestInnerHeight = Math.max(largestInnerHeight, window.innerHeight);
    }
    const layoutViewportResized = promptFocused && largestInnerHeight - window.innerHeight > 80;
    const viewportBottom = layoutViewportResized ? window.innerHeight : visualBottom;
    const inferredKeyboardInset = Math.max(0, window.innerHeight - viewportBottom);

    updateMobileChromeMetrics();
    document.documentElement.style.setProperty("--visual-viewport-height", `${viewportBottom}px`);
    document.documentElement.style.setProperty("--visual-viewport-offset-top", `${visualOffsetTop}px`);
    document.documentElement.style.setProperty("--keyboard-inset", `${inferredKeyboardInset}px`);

    const composerBottom = els.composer?.getBoundingClientRect().bottom || viewportBottom;
    const fixedBottomAtZero = composerBottom + inferredKeyboardInset;
    const keyboardInset = Math.max(0, Math.round(fixedBottomAtZero - viewportBottom));
    const keyboardOpen = promptFocused
      && (layoutViewportResized || largestVisualHeight - visualHeight > 80 || inferredKeyboardInset > 80);
    document.documentElement.style.setProperty("--keyboard-inset", `${keyboardInset}px`);
    document.documentElement.classList.toggle("keyboard-open", keyboardOpen);

    const viewportLog = [
      Math.round(window.innerHeight),
      Math.round(visualHeight),
      Math.round(visualOffsetTop),
      keyboardInset,
      keyboardOpen
    ].join(":");
    if (viewportLog !== lastViewportLog) {
      lastViewportLog = viewportLog;
      console.debug("[codex-webui:viewport]", {
        innerHeight: Math.round(window.innerHeight),
        visualHeight: Math.round(visualHeight),
        visualOffsetTop: Math.round(visualOffsetTop),
        visualBottom: Math.round(visualBottom),
        viewportBottom: Math.round(viewportBottom),
        layoutViewportResized,
        inferredKeyboardInset: Math.round(inferredKeyboardInset),
        keyboardInset,
        keyboardOpen
      });
    }
  };

  let frame = 0;
  const scheduleSync = () => {
    captureBottomDistance();
    if (frame) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      frame = 0;
      syncViewport();
      restoreBottomDistance();
    });
  };

  syncViewport();
  const resizeObserver = window.ResizeObserver
    ? new ResizeObserver(scheduleSync)
    : null;
  resizeObserver?.observe(els.composer);
  resizeObserver?.observe(els.chatPane.querySelector(".topbar"));
  window.addEventListener("resize", scheduleSync);
  window.addEventListener("orientationchange", scheduleSync);
  window.visualViewport?.addEventListener("resize", scheduleSync);
  window.visualViewport?.addEventListener("scroll", scheduleSync);
  els.promptInput.addEventListener("focus", () => {
    document.documentElement.classList.add("input-focused");
    scheduleSync();
    window.setTimeout(scheduleSync, 120);
    window.setTimeout(scheduleSync, 360);
  });
  els.promptInput.addEventListener("blur", () => {
    window.setTimeout(() => {
      document.documentElement.classList.remove("input-focused");
      scheduleSync();
    }, 120);
    window.setTimeout(scheduleSync, 360);
  });
}

function updateMobileChromeMetrics() {
  const topbarHeight = Math.ceil(els.chatPane?.querySelector(".topbar")?.getBoundingClientRect().height || 78);
  const composerHeight = Math.ceil(els.composer?.getBoundingClientRect().height || 70);
  const target = els.chatPane || document.documentElement;
  target.style.setProperty("--mobile-topbar-height", `${topbarHeight}px`);
  target.style.setProperty("--mobile-composer-height", `${composerHeight}px`);
  target.style.setProperty("--workflow-status-height", `${Math.ceil(document.querySelector(".workflow-status-area")?.getBoundingClientRect().height || 0)}px`);
}

function setupTheme() {
  const saved = localStorage.getItem(THEME_STORAGE_KEY) || "system";
  els.themeSelect.value = ["system", "light", "dark"].includes(saved) ? saved : "system";
  applyThemePreference(els.themeSelect.value);
}

function setThemePreference(value) {
  const next = ["system", "light", "dark"].includes(value) ? value : "system";
  localStorage.setItem(THEME_STORAGE_KEY, next);
  applyThemePreference(next);
}

function applyThemePreference(value) {
  if (value === "system") {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.dataset.theme = value;
  }
}

function setupBackButtonGuard() {
  if (!window.history?.pushState || window.__codexWebUIBackGuard) return;
  window.__codexWebUIBackGuard = true;
  setupBackSentinel();
  backGuardBaseUrl = cleanBackGuardUrl(window.location.href);
  window.history.replaceState({ ...(window.history.state || {}), codexWebUIPage: true }, "", backGuardBaseUrl);
  armBackButtonGuard();
  window.addEventListener("popstate", handleBackNavigation);
  window.addEventListener("hashchange", handleBackNavigation);
  window.addEventListener("pointerdown", armBackButtonGuardFromUserGesture, { capture: true, passive: true });
  window.addEventListener("touchstart", armBackButtonGuardFromUserGesture, { capture: true, passive: true });
  window.addEventListener("keydown", armBackButtonGuardFromUserGesture, { capture: true });
}

function setupBackSentinel() {
  if (!HTMLElement.prototype.showPopover || backSentinels.length) return;
  backSentinels = Array.from({ length: BACK_SENTINEL_COUNT }, () => {
    const sentinel = document.createElement("div");
    sentinel.className = "back-sentinel";
    sentinel.popover = "manual";
    sentinel.setAttribute("aria-hidden", "true");
    sentinel.addEventListener("beforetoggle", (event) => {
      if (event.newState !== "closed" || backSentinelReopening) return;
      if (event.cancelable) event.preventDefault();
      handleBackButton();
      window.setTimeout(openBackSentinels, 0);
    });
    sentinel.addEventListener("toggle", (event) => {
      if (event.newState !== "closed" || backSentinelReopening) return;
      handleBackButton();
      window.setTimeout(openBackSentinels, 0);
    });
    document.body.append(sentinel);
    return sentinel;
  });
  openBackSentinels();
}

function openBackSentinels() {
  if (!backSentinels.length) return;
  try {
    backSentinelReopening = true;
    for (const sentinel of backSentinels) {
      if (!sentinel.matches(":popover-open")) sentinel.showPopover();
    }
  } catch {
    // Older browsers may expose partial Popover API support.
  } finally {
    backSentinelReopening = false;
  }
}

function handleBackNavigation() {
  if (backGuardHandling) return;
  backGuardHandling = true;
  handleBackButton();
  window.setTimeout(() => {
    armBackButtonGuard();
    backGuardHandling = false;
  }, 0);
}

function armBackButtonGuardFromUserGesture() {
  const now = Date.now();
  if (now - backGuardArmedAt < 1200) return;
  armBackButtonGuard();
}

function armBackButtonGuard() {
  if (!backGuardBaseUrl) backGuardBaseUrl = cleanBackGuardUrl(window.location.href);
  backGuardArmedAt = Date.now();
  pushBackGuardState();
  pushBackGuardState();
}

function cleanBackGuardUrl(url) {
  const next = new URL(url);
  if (next.hash.startsWith(`#${BACK_GUARD_HASH_PREFIX}`)) {
    next.hash = "";
  }
  return next.toString();
}

function pushBackGuardState() {
  const url = new URL(backGuardBaseUrl || window.location.href);
  backGuardSerial += 1;
  url.hash = `${BACK_GUARD_HASH_PREFIX}${backGuardSerial}`;
  window.history.pushState({ codexWebUIGuard: true, serial: backGuardSerial }, "", url.toString());
}

function handleBackButton() {
  if (closeImageViewer()) return;
  if (document.fullscreenElement || document.webkitFullscreenElement) {
    exitFullscreen();
    return;
  }
  if (els.sidebar?.classList.contains("open")) {
    els.sidebar.classList.remove("open");
    return;
  }
  if (els.setupBand?.classList.contains("open")) {
    setSetupBandOpen(false);
    return;
  }
  if (document.activeElement === els.promptInput) {
    els.promptInput.blur();
  }
}

async function exitFullscreen() {
  try {
    if (document.exitFullscreen) await document.exitFullscreen();
    else if (document.webkitExitFullscreen) await document.webkitExitFullscreen();
  } catch (error) {
    addSystemMessage(error.message || t("fullscreen.exitError"));
  } finally {
    updateFullscreenToggle();
  }
}

function setSetupBandOpen(open) {
  els.setupBand?.classList.toggle("open", open);
  els.settingsToggle?.classList.toggle("active", open);
  els.settingsToggle?.setAttribute("aria-expanded", String(open));
  els.settingsToggle?.setAttribute("aria-label", t(open ? "settings.collapse" : "settings.expand"));
}

async function refreshAll() {
  if (state.pendingImages.length || state.sendingThreadId) { workflowNotice(t("draft.attachments-or-send")); return; }
  const currentThread = state.currentThread;
  const currentId = currentThread?.id;
  state.lastLoadStats = null;
  state.threadLoadStats = null;
  updateTrafficSummary();
  if (currentId) {
    const loadSeq = ++state.threadLoadSeq;
    state.loadingThreadId = currentId;
    state.currentThread = currentThread;
    state.messages = [];
    resetTurnPaging();
    els.sendButton.disabled = true;
    updateThreadHeader();
    renderThreadLoading(currentThread, createThreadLoadStats(currentId, currentThread, loadSeq));
    renderThreads();
  }
  await Promise.all([loadConfig(), loadThreads(), loadRateLimits()]);
  applyConfigDefaults();
  if (currentId) {
    const thread = state.threads.find((entry) => entry.id === currentId) || currentId;
    await openThread(thread);
  }
}

function setupImageComposer() {
  const settingsButton = document.createElement("button");
  settingsButton.className = "settings-toggle";
  settingsButton.type = "button";
  settingsButton.innerHTML = settingsIcon();
  settingsButton.title = t("settings.panel");
  settingsButton.setAttribute("aria-label", t("settings.expand"));
  settingsButton.setAttribute("aria-expanded", "false");

  const attachButton = document.createElement("label");
  attachButton.className = "attach-button";
  attachButton.textContent = "+";
  attachButton.title = t("image.add");

  const imageInput = document.createElement("input");
  imageInput.id = "imageInput";
  imageInput.type = "file";
  imageInput.accept = "image/*";
  imageInput.multiple = true;
  imageInput.hidden = true;
  attachButton.htmlFor = imageInput.id;

  const tray = document.createElement("div");
  tray.className = "image-tray hidden";

  els.composer.prepend(imageInput);
  els.composer.prepend(attachButton);
  els.composer.prepend(settingsButton);
  els.composer.insertBefore(tray, els.promptInput);
  els.settingsToggle = settingsButton;
  els.imageInput = imageInput;
  els.imageTray = tray;

  settingsButton.addEventListener("click", () => {
    setSetupBandOpen(!els.setupBand.classList.contains("open"));
  });

  imageInput.addEventListener("change", async () => {
    const files = [...imageInput.files];
    await addImages(files);
    imageInput.value = "";
  });
}

async function addImages(files) {
  if (state.sendingThreadId) { workflowNotice(t("draft.attachments-or-send")); return; }
  const imageFiles = files.filter(isImageFile);
  if (!imageFiles.length && files.length) {
    addSystemMessage(t("image.noneFound"));
  }
  const uploads = imageFiles.map((file) => {
    const previewUrl = URL.createObjectURL(file);
    const item = {
      id: createClientId(),
      name: file.name,
      previewUrl,
      status: "preparing",
      originalSize: file.size,
      uploadSize: file.size,
      path: null
    };
    state.pendingImages.push(item);
    item.readyPromise = (async () => {
      try {
        const upload = await prepareImageForUpload(file);
        item.uploadSize = upload.size;
        item.compressed = upload.compressed;
        item.detail = imageUploadDetail(file, upload);
        item.status = "uploading";
        renderImageTray();

        const result = await uploadImage(upload, (progress) => {
          item.progress = progress;
          renderImageTray();
        });
        item.path = result.path;
        item.status = "ready";
      } catch (error) {
        item.status = "failed";
        item.error = error.message;
      }
      renderImageTray();
    })();
    return item.readyPromise;
  });

  renderImageTray();
  await Promise.allSettled(uploads);
}

function uploadImage(upload, onProgress = null) {
  const blob = upload.blob || upload;
  const uploadName = upload.name || blob.name || "image";
  const contentType = upload.type || imageMimeForFile(blob) || "application/octet-stream";
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", authenticatedUrl("/api/upload-image", state.token));
    xhr.setRequestHeader("content-type", contentType);
    xhr.setRequestHeader("x-file-name", encodeURIComponent(uploadName));
    xhr.timeout = 90000;
    xhr.upload.addEventListener("progress", (event) => {
      if (!event.lengthComputable || !onProgress) return;
      onProgress(Math.round((event.loaded / event.total) * 100));
    });
    xhr.addEventListener("load", () => {
      const result = parseJson(xhr.responseText);
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(result);
      } else {
        reject(new Error(result?.error || `Image upload failed (${xhr.status})`));
      }
    });
    xhr.addEventListener("error", () => reject(new Error(t("image.networkError"))));
    xhr.addEventListener("timeout", () => reject(new Error(t("image.timeout"))));
    xhr.send(blob);
  });
}

async function prepareImageForUpload(file) {
  const original = originalImageUpload(file);
  if (!canCompressImage(file)) return original;

  try {
    const image = await withTimeout(loadImageElement(file), 10000, "Image decode timed out");
    const scale = Math.min(
      1,
      IMAGE_UPLOAD_MAX_EDGE / Math.max(image.naturalWidth || 1, image.naturalHeight || 1),
      Math.sqrt(IMAGE_UPLOAD_MAX_PIXELS / Math.max(1, (image.naturalWidth || 1) * (image.naturalHeight || 1)))
    );

    if (scale >= 1 && file.size <= IMAGE_UPLOAD_TARGET_BYTES) {
      return original;
    }

    const width = Math.max(1, Math.round((image.naturalWidth || 1) * scale));
    const height = Math.max(1, Math.round((image.naturalHeight || 1) * scale));
    const blob = await withTimeout(drawImageToJpegBlob(image, width, height), 12000, "Image compression timed out");
    if (!blob || (blob.size >= file.size && scale >= 1)) return original;

    return {
      blob,
      name: fileNameWithExtension(file.name, "jpg"),
      type: blob.type || "image/jpeg",
      size: blob.size,
      originalSize: file.size,
      compressed: blob.size < file.size || scale < 1
    };
  } catch {
    return original;
  }
}

function originalImageUpload(file) {
  return {
    blob: file,
    name: file.name || "image",
    type: imageMimeForFile(file) || file.type || "application/octet-stream",
    size: file.size || 0,
    originalSize: file.size || 0,
    compressed: false
  };
}

function canCompressImage(file) {
  const mime = imageMimeForFile(file);
  return mime.startsWith("image/") && mime !== "image/gif" && mime !== "image/svg+xml";
}

function loadImageElement(file) {
  const url = URL.createObjectURL(file);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(t("image.decodeFailed")));
    };
    img.src = url;
  });
}

function withTimeout(promise, ms, message) {
  let timer = 0;
  const timeout = new Promise((_, reject) => {
    timer = window.setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => window.clearTimeout(timer));
}

async function drawImageToJpegBlob(image, width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) return null;

  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);

  let best = null;
  for (const quality of IMAGE_UPLOAD_JPEG_QUALITIES) {
    const blob = await canvasToBlob(canvas, "image/jpeg", quality);
    if (!blob) continue;
    best = blob;
    if (blob.size <= IMAGE_UPLOAD_TARGET_BYTES) break;
  }
  return best;
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve) => {
    if (!canvas.toBlob) {
      resolve(null);
      return;
    }
    canvas.toBlob(resolve, type, quality);
  });
}

function fileNameWithExtension(name, extension) {
  const fallback = "image";
  const base = String(name || fallback).replace(/\.[^./\\]+$/, "") || fallback;
  return `${base}.${extension}`;
}

function imageUploadDetail(original, upload) {
  if (!upload.compressed) return `${original.name || t("image.defaultName")} · ${formatBytes(upload.size)}`;
  return `${original.name || t("image.defaultName")} · ${formatBytes(original.size)} -> ${formatBytes(upload.size)}`;
}

function parseJson(text) {
  try {
    return JSON.parse(text || "{}");
  } catch {
    return {};
  }
}

function createClientId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  const random = window.crypto?.getRandomValues
    ? Array.from(window.crypto.getRandomValues(new Uint32Array(2)), (value) => value.toString(36)).join("")
    : Math.random().toString(36).slice(2);
  return `${Date.now().toString(36)}-${random}`;
}

function isImageFile(file) {
  return Boolean(imageMimeForFile(file));
}

function imageMimeForFile(file) {
  const type = String(file?.type || "").toLowerCase();
  if (type.startsWith("image/")) return type;
  const name = String(file?.name || "").toLowerCase();
  if (name.endsWith(".png")) return "image/png";
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return "image/jpeg";
  if (name.endsWith(".webp")) return "image/webp";
  if (name.endsWith(".gif")) return "image/gif";
  return "";
}

function renderImageTray() {
  if (!els.imageTray) return;
  els.imageTray.innerHTML = "";
  const hasImages = Boolean(state.pendingImages.length);
  els.imageTray.classList.toggle("hidden", !hasImages);
  els.composer?.classList.toggle("has-image-tray", hasImages);

  for (const image of state.pendingImages) {
    const item = document.createElement("div");
    item.className = `image-chip ${image.status}`;
    const label = imageTrayLabel(image);
    if (image.detail) item.title = image.detail;
    item.innerHTML = `
      <img src="${image.previewUrl}" alt="">
      <span>${escapeHtml(label)}</span>
      <button type="button" aria-label="${escapeHtml(t("image.remove"))}">×</button>
    `;
    item.querySelector("button").addEventListener("click", () => {
      URL.revokeObjectURL(image.previewUrl);
      state.pendingImages = state.pendingImages.filter((entry) => entry.id !== image.id);
      renderImageTray();
    });
    els.imageTray.append(item);
  }
  updateFollowUpOptions();
  updateMobileChromeMetrics();
}

function imageTrayLabel(image) {
  if (image.status === "preparing") return t("image.preparing");
  if (image.status === "uploading") return t("image.uploading", { progress: image.progress ? ` ${image.progress}%` : "" });
  if (image.status === "failed") return image.error || t("image.failed");
  if (image.compressed) return `${formatBytes(image.originalSize)} -> ${formatBytes(image.uploadSize)}`;
  return image.name;
}

function revokeImagePreviews(images) {
  for (const image of images || []) {
    if (image.previewUrl) URL.revokeObjectURL(image.previewUrl);
  }
}

async function loadModels() {
  const result = await rpc("model/list", { limit: 50, includeHidden: false });
  state.models = result?.data || [];
  els.modelSelect.innerHTML = "";
  for (const model of state.models) {
    const option = document.createElement("option");
    option.value = model.model || model.id;
    option.textContent = model.displayName || model.model || model.id;
    if (model.isDefault) option.selected = true;
    els.modelSelect.append(option);
  }
  if (!state.models.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = t("model.default");
    els.modelSelect.append(option);
  }
  updateReasoningOptions("", { useModelDefault: true });
}

async function loadPermissionModes(cwd = "") {
  const selectionSeq=state.threadLoadSeq;
  if (!state.threadSettingsAvailable) {
    applyPermissionModeFallback();
    return;
  }
  try {
    const [profileResult, requirementsResult] = await Promise.all([
      rpc("permissionProfile/list", { limit: 50, cwd: cwd || els.projectSelect.value || preferredScopedCwd() || null }),
      rpc("configRequirements/read", {})
    ]);
    if(selectionSeq!==state.threadLoadSeq)return;
    state.permissionProfiles = profileResult?.data || [];
    state.configRequirements = requirementsResult?.requirements || null;
    state.permissionModes = availablePermissionModes(state.permissionProfiles, state.configRequirements);
    renderPermissionModes();
  } catch {
    if(selectionSeq!==state.threadLoadSeq)return;
    state.threadSettingsAvailable = false;
    applyPermissionModeFallback();
    applyBridgeModeUi();
  }
}

function builtInPermissionProfiles() {
  return [":read-only", ":workspace", ":danger-full-access"]
    .map((id) => ({ id, allowed: true, description: null }));
}

function applyPermissionModeFallback() {
  state.permissionProfiles = builtInPermissionProfiles();
  state.configRequirements = null;
  state.permissionModes = availablePermissionModes(state.permissionProfiles, null);
  renderPermissionModes();
}

function renderPermissionModes(preferredValue = "") {
  const previous = preferredValue || els.permissionSelect.value;
  els.permissionSelect.innerHTML = "";
  for (const mode of state.permissionModes) {
    const option = document.createElement("option");
    option.value = mode.id;
    option.textContent = mode.label || t(mode.labelKey);
    option.title = mode.description || t(mode.descriptionKey);
    els.permissionSelect.append(option);
  }
  if (previous && [...els.permissionSelect.options].some((option) => option.value === previous)) {
    els.permissionSelect.value = previous;
  } else if (state.permissionModes.length) {
    els.permissionSelect.value = state.permissionModes.some((mode) => mode.id === "request-approval")
      ? "request-approval"
      : state.permissionModes[0].id;
  }
}

async function loadConfig() {
  const result = await rpc("config/read", {});
  state.config = result?.config || null;
}

function applyConfigDefaults() {
  const config = state.config || {};
  const effort = configReasoningEffort(config);
  if (config.model) {
    setModelValue(config.model, effort);
  } else {
    updateReasoningOptions(effort, { useModelDefault: true });
  }
}

async function loadAccount() {
  const result = await rpc("account/read", { refreshToken: false });
  state.account = result;
  if (result?.requiresOpenaiAuth && !result?.account) {
    els.authPanel.classList.remove("hidden");
    els.authText.textContent = t("auth.notLoggedIn");
  } else {
    els.authPanel.classList.add("hidden");
  }
}

function storedCollapsedProjects() {
  try {
    const value = JSON.parse(localStorage.getItem(COLLAPSED_PROJECTS_STORAGE_KEY) || "[]");
    return new Set(Array.isArray(value) ? value.map(String) : []);
  } catch {
    return new Set();
  }
}

function persistCollapsedProjects() {
  try {
    localStorage.setItem(COLLAPSED_PROJECTS_STORAGE_KEY, JSON.stringify([...state.collapsedProjects]));
  } catch {
    // Private browsing can disable localStorage; collapsing still works for this page lifetime.
  }
}

async function loadRateLimits() {
  if (!els.usageWindows) return;
  els.usageCard?.classList.add("loading");
  try {
    const result = await rpc("account/rateLimits/read", {});
    state.rateLimits = normalizeRateLimits(result);
    state.rateLimitsError = "";
  } catch (error) {
    state.rateLimits = { windows: [], planType: "", credits: null };
    state.rateLimitsError = error?.message || t("usage.unavailable");
  } finally {
    els.usageCard?.classList.remove("loading");
    renderRateLimits();
  }
}

function renderRateLimits() {
  if (!els.usageWindows) return;
  const { windows, planType } = state.rateLimits || {};
  els.usagePlan.textContent = planType ? String(planType).toUpperCase() : "";
  els.usageWindows.innerHTML = "";

  if (!windows?.length) {
    const empty = document.createElement("div");
    empty.className = "usage-empty";
    empty.textContent = state.rateLimitsError || t("usage.unavailable");
    els.usageWindows.append(empty);
    return;
  }

  for (const window of windows) {
    const item = document.createElement("div");
    item.className = `usage-window ${window.remainingPercent <= 15 ? "critical" : window.remainingPercent <= 35 ? "warning" : ""}`;
    const durationLabel = rateLimitWindowLabel(window, t);
    const scopeLabel = window.limitName || (window.limitId && window.limitId !== "codex" ? window.limitId : "Codex");
    const label = `${scopeLabel} · ${durationLabel}`;
    const reset = formatResetTime(window.resetsAt, currentLocale());
    item.innerHTML = `
      <div class="usage-row">
        <span>${escapeHtml(label)}</span>
        <strong>${escapeHtml(t("usage.remaining", { percent: Math.round(window.remainingPercent) }))}</strong>
      </div>
      <div class="usage-track" role="progressbar" aria-label="${escapeHtml(label)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(window.usedPercent)}">
        <span style="width:${window.usedPercent}%"></span>
      </div>
      <div class="usage-reset">${escapeHtml(reset ? t("usage.resets", { time: reset }) : t("usage.resetUnknown"))}</div>
    `;
    els.usageWindows.append(item);
  }
}

async function startDeviceLogin() {
  const result = await rpc("account/login/start", { type: "chatgptDeviceCode" });
  if (result?.verificationUrl && result?.userCode) {
    els.authPanel.classList.remove("hidden");
    const url = escapeHtml(result.verificationUrl);
    const code = escapeHtml(result.userCode);
    els.authText.innerHTML = t("auth.instructions", {
      url: `<a href="${url}" target="_blank" rel="noreferrer">${url}</a>`,
      code: `<strong>${code}</strong>`
    });
  }
}

async function loadThreads() {
  if (state.threadListSyncInFlight) return;
  state.threadListSyncInFlight = true;
  try {
    const result = await rpc("thread/list", {
      limit: 100,
      archived: false,
      sortKey: "recency_at",
      sortDirection: "desc"
    });
    state.threads = mergeCurrentThreadIntoList(result?.data || []);
    for (const thread of state.threads) {
      if (!thread?.id) continue;
      const activity = setThreadActivity(thread.id, {
        type: "thread-snapshot",
        status: thread.status,
        updatedAt: thread.updatedAt || thread.createdAt
      }, false);
      const cached = state.recentThreadCache.get(thread.id);
      const cacheIsStale = Boolean(
        cached
        && thread.id !== state.currentThread?.id
        && ![THREAD_ACTIVITY.RUNNING, THREAD_ACTIVITY.WAITING].includes(activity.state)
        && shouldRefreshCachedThread({
          cachedTimestamp: cached.latestAt,
          threadTimestamp: threadTimestamp(thread),
          working: false
        })
      );
      if (cacheIsStale) {
        setThreadActivity(thread.id, {
          type: "thread-updated",
          status: thread.status,
          updatedAt: thread.updatedAt || thread.createdAt
        }, false);
      }
    }
    state.lastThreadListSyncAt = Date.now();
    renderProjectOptions();
    renderThreads();
    prewarmThreadCaches();
  } finally {
    state.threadListSyncInFlight = false;
  }
}

function refreshThreadManifestIfDue() {
  if (!state.connected || state.threadListSyncInFlight) return;
  if (Date.now() - state.lastThreadListSyncAt < MANIFEST_REFRESH_MS) return;
  loadThreads().catch(() => {});
}

function prewarmThreadCaches() {
  const ids = selectThreadCachePrewarmIds({
    threads: state.threads,
    activityByThread: state.threadActivity,
    currentThreadId: state.currentThread?.id,
    limit: PREWARM_THREAD_LIMIT
  });
  ids.forEach((threadId) => enqueueBackgroundThreadCache(threadId));
}

function scheduleBackgroundThreadCache(threadId, delay = 180) {
  if(document.hidden||!state.connected)return;
  const id = String(threadId || "");
  if (!id || id === state.currentThread?.id) return;
  const existing = state.backgroundCacheTimers.get(id);
  if (existing) window.clearTimeout(existing);
  const timer = window.setTimeout(() => {
    state.backgroundCacheTimers.delete(id);
    enqueueBackgroundThreadCache(id);
  }, Math.max(0, Number(delay) || 0));
  state.backgroundCacheTimers.set(id, timer);
}

function enqueueBackgroundThreadCache(threadId) {
  if(document.hidden||!state.connected)return;
  const id = String(threadId || "");
  if (!id || id === state.currentThread?.id) return;
  if (state.backgroundCacheQueued.has(id) || state.backgroundCacheInFlight.has(id)) return;
  const elapsed=Date.now()-(state.backgroundCacheLastReadAt.get(id)||0);
  if(elapsed<BACKGROUND_REFRESH_MS){scheduleBackgroundThreadCache(id,BACKGROUND_REFRESH_MS-elapsed);return;}

  const thread = state.threads.find((entry) => entry.id === id);
  if (!thread || thread.ephemeral) return;
  const activity = activityForThread(id);
  const working = [THREAD_ACTIVITY.RUNNING, THREAD_ACTIVITY.WAITING].includes(activity.state);
  const cached = state.recentThreadCache.get(id);
  if (cached && !shouldRefreshCachedThread({
    cachedTimestamp: cached.latestAt,
    threadTimestamp: threadTimestamp(thread),
    working
  })) return;

  state.backgroundCacheQueued.add(id);
  state.backgroundCacheQueue.push(id);
  pumpBackgroundThreadCache();
}

function pumpBackgroundThreadCache() {
  if(document.hidden||state.loadingThreadId||!state.connected)return;
  while (
    state.backgroundCacheInFlight.size < BACKGROUND_CACHE_CONCURRENCY
    && state.backgroundCacheQueue.length
  ) {
    const threadId = state.backgroundCacheQueue.shift();
    state.backgroundCacheQueued.delete(threadId);
    if (!threadId || threadId === state.currentThread?.id) continue;
    state.backgroundCacheInFlight.add(threadId);
    refreshBackgroundThreadCache(threadId)
      .catch(() => {})
      .finally(() => {
        state.backgroundCacheInFlight.delete(threadId);
        pumpBackgroundThreadCache();
      });
  }
}

async function refreshBackgroundThreadCache(threadId) {
  state.backgroundCacheLastReadAt.set(threadId,Date.now());
  if(state.backgroundCacheLastReadAt.size>64)state.backgroundCacheLastReadAt.delete(state.backgroundCacheLastReadAt.keys().next().value);
  const page = await rpc("thread/turns/list", {
    threadId,
    limit: 1,
    sortDirection: "desc",
    itemsView: TURN_ITEMS_VIEW
  });
  if (threadId === state.currentThread?.id) return;
  const turns = page?.data || [];
  const latestAt = latestTurnTimestamp(turns) || threadTimestamp(
    state.threads.find((entry) => entry.id === threadId)
  );
  cacheRecentThreadPage(threadId, turns, page?.nextCursor, latestAt, true);
  if (turnLifecycle(turns[0]?.status) === "active") {
    scheduleBackgroundThreadCache(threadId, BACKGROUND_REFRESH_MS);
  }
}

function cancelBackgroundThreadCache(threadId) {
  const id = String(threadId || "");
  const timer = state.backgroundCacheTimers.get(id);
  if (timer) window.clearTimeout(timer);
  state.backgroundCacheTimers.delete(id);
  state.backgroundCacheQueued.delete(id);
  state.backgroundCacheQueue = state.backgroundCacheQueue.filter((entry) => entry !== id);
}

function mergeCurrentThreadIntoList(threads) {
  const current = state.currentThread;
  if (!current?.id || !current?.cwd || current?.draft) return threads;
  const index = threads.findIndex((thread) => thread.id === current.id);
  if (index < 0) return [current, ...threads];
  const merged = [...threads];
  merged[index] = { ...current, ...merged[index] };
  return merged;
}

function renderProjectOptions() {
  const previous = els.projectSelect.value;
  const groupsByKey = new Map(
    groupThreadsByProject(state.threads)
      .filter(isProjectGroup)
      .map((group) => [group.key, group])
  );
  for (const cwd of state.threadFilterCwds) {
    const project = projectFromCwd(cwd);
    if (!groupsByKey.has(project.key)) groupsByKey.set(project.key, { ...project, threads: [] });
  }
  const groups = sortProjectGroupsByActivity([...groupsByKey.values()], state.threadActivity);

  els.projectSelect.innerHTML = "";
  if (!hasScopedToken()) {
    const none = document.createElement("option");
    none.value = "";
    none.textContent = t("project.none");
    els.projectSelect.append(none);
  }

  for (const group of groups) {
    const option = document.createElement("option");
    option.value = group.cwd;
    option.textContent = group.name;
    els.projectSelect.append(option);
  }

  if (previous && [...els.projectSelect.options].some((option) => option.value === previous)) {
    els.projectSelect.value = previous;
  } else if (state.currentThread?.cwd) {
    setProjectSelection(state.currentThread.cwd);
  } else if (hasScopedToken()) {
    setProjectSelection(preferredScopedCwd());
  }
}

function setProjectSelection(cwd) {
  let value = cwd || preferredScopedCwd();
  const isScopeRoot = state.threadFilterCwds.some((root) => samePath(root, value));
  if (value && !isScopeRoot && !isProjectGroup(projectFromCwd(value))) {
    els.projectSelect.value = preferredScopedCwd();
    return;
  }
  if (value && ![...els.projectSelect.options].some((option) => option.value === value)) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = projectFromCwd(value).name;
    els.projectSelect.append(option);
  }
  els.projectSelect.value = value;
}

function renderThreads() {
  const term = els.searchThreads.value.trim().toLowerCase();
  els.threadList.innerHTML = "";
  const filtered = state.threads.filter((thread) => threadMatchesSearch(thread, term));

  if (!filtered.length) {
    const empty = document.createElement("div");
    empty.className = "thread-item";
    empty.innerHTML = `<span class="thread-name">${escapeHtml(t("thread.noThreads"))}</span><span class="thread-time">${escapeHtml(t("thread.new"))}</span>`;
    els.threadList.append(empty);
    return;
  }

  const attentionThreads = filtered
    .filter((thread) => activityPriority(activityForThread(thread.id)) < 4)
    .sort((left, right) => {
      const priority = activityPriority(activityForThread(left.id)) - activityPriority(activityForThread(right.id));
      return priority || threadTimestamp(right) - threadTimestamp(left);
    });
  const regularThreads = filtered.filter((thread) => !attentionThreads.some((active) => active.id === thread.id));

  if (attentionThreads.length) {
    els.threadList.append(renderSectionTitle(t("thread.active")));
    const section = document.createElement("section");
    section.className = "active-thread-group";
    for (const thread of attentionThreads) section.append(renderThreadButton(thread));
    els.threadList.append(section);
  }

  const { projects, directThreads } = splitThreadGroups(groupThreadsByProject(regularThreads, filtered));

  if (projects.length) {
    els.threadList.append(renderSectionTitle(t("thread.recentProjects")));
    for (const group of projects) {
      els.threadList.append(renderProjectGroup(group, { forceExpanded: Boolean(term) }));
    }
  }

  if (directThreads.length) {
    els.threadList.append(renderSectionTitle(t("thread.conversations")));
    const section = document.createElement("section");
    section.className = "direct-thread-group";
    for (const thread of directThreads) {
      section.append(renderThreadButton(thread));
    }
    els.threadList.append(section);
  }
}

function threadMatchesSearch(thread, term) {
  if (!term) return true;
  const project = projectFromCwd(thread.cwd);
  const text = `${thread.name || ""} ${thread.preview || ""} ${thread.cwd || ""} ${project.name}`.toLowerCase();
  return text.includes(term);
}

function renderSectionTitle(title) {
  const node = document.createElement("div");
  node.className = "sidebar-section-title";
  node.textContent = title;
  return node;
}

function renderProjectGroup(group, options = {}) {
  const section = document.createElement("section");
  const isCollapsed = !options.forceExpanded && state.collapsedProjects.has(group.key);
  const showAll = state.expandedProjects.has(group.key);
  const visibleThreads = isCollapsed ? [] : showAll ? group.threads : group.threads.slice(0, 6);
  section.className = `project-group ${isCollapsed ? "collapsed" : ""}`;
  section.innerHTML = `
    <button class="project-heading" type="button" title="${escapeHtml(group.cwd)}" aria-expanded="${String(!isCollapsed)}">
      <span class="project-chevron" aria-hidden="true">›</span>
      ${folderIcon()}
      <span class="project-name">${escapeHtml(group.name)}</span>
      <span class="project-badge">${group.totalCount || group.threads.length}</span>
    </button>
  `;

  section.querySelector(".project-heading").addEventListener("click", () => {
    if (state.collapsedProjects.has(group.key)) state.collapsedProjects.delete(group.key);
    else state.collapsedProjects.add(group.key);
    persistCollapsedProjects();
    renderThreads();
  });

  for (const thread of visibleThreads) {
    section.append(renderThreadButton(thread));
  }

  const overflowAction = projectOverflowAction({
    collapsed: isCollapsed,
    totalCount: group.threads.length,
    visibleCount: visibleThreads.length,
    expanded: showAll
  });
  if (overflowAction === "expand") {
    const expand = document.createElement("button");
    expand.className = "expand-project";
    expand.type = "button";
    expand.textContent = t("thread.showMore");
    expand.addEventListener("click", () => {
      state.expandedProjects.add(group.key);
      renderThreads();
    });
    section.append(expand);
  } else if (overflowAction === "collapse") {
    const collapse = document.createElement("button");
    collapse.className = "expand-project";
    collapse.type = "button";
    collapse.textContent = t("thread.collapse");
    collapse.addEventListener("click", () => {
      state.expandedProjects.delete(group.key);
      renderThreads();
    });
    section.append(collapse);
  }

  return section;
}

function renderThreadButton(thread) {
  const link = document.createElement("a");
  const isActive = state.currentThread?.id === thread.id;
  const isLoading = state.loadingThreadId === thread.id;
  const activity = activityForThread(thread.id);
  const activityState = activity.state || THREAD_ACTIVITY.IDLE;
  link.className = `thread-item activity-${activityState} ${activity.unread ? "unread" : ""} ${isActive ? "active" : ""} ${isLoading ? "loading" : ""}`;
  link.href = threadUrl(thread.id);
  link.title = t("thread.openNewTab");
  if (isActive) link.setAttribute("aria-current", "page");
  link.innerHTML = `
    <span class="thread-activity-dot" data-state="${escapeHtml(activityState)}" title="${escapeHtml(activityLabel(activity))}" aria-label="${escapeHtml(activityLabel(activity))}"></span>
    <span class="thread-copy">
      <span class="thread-name">${escapeHtml(thread.name || thread.preview || t("thread.untitled"))}</span>
      <span class="thread-status">${escapeHtml(activityLabel(activity))}</span>
    </span>
    <span class="thread-time">${formatRelativeTime(thread.updatedAt || thread.createdAt)}</span>
  `;
  link.addEventListener("click", (event) => {
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    openThread(thread);
  });
  return link;
}

function activityForThread(threadId) {
  return state.threadActivity.get(threadId) || createThreadActivity();
}

function setThreadActivity(threadId, event, render = true) {
  if (!threadId) return createThreadActivity();
  const next = reduceThreadActivity(state.threadActivity.get(threadId), event);
  state.threadActivity.set(threadId, next);
  if (render) renderThreads();
  return next;
}

function activityLabel(activity) {
  if (activity?.state === THREAD_ACTIVITY.RUNNING) return t("activity.running");
  if (activity?.state === THREAD_ACTIVITY.WAITING) return t("activity.waiting");
  if (activity?.state === THREAD_ACTIVITY.COMPLETED) return t(activity.unread ? "activity.completedUnread" : "activity.completed");
  if (activity?.state === THREAD_ACTIVITY.FAILED) return t(activity.unread ? "activity.failedUnread" : "activity.failed");
  return t("activity.idle");
}

function threadUrl(threadId) {
  const url = new URL(cleanBackGuardUrl(window.location.href));
  url.hash = "";
  url.searchParams.set(THREAD_URL_PARAM, threadId);
  if (state.token) url.searchParams.set("token", state.token);
  return url.toString();
}

function splitThreadGroups(groups) {
  const projects = [];
  const directThreads = [];
  for (const group of groups) {
    if (isProjectGroup(group)) projects.push(group);
    else directThreads.push(...group.threads);
  }
  directThreads.sort((a, b) => threadTimestamp(b) - threadTimestamp(a));
  return { projects, directThreads };
}

function groupThreadsByProject(threads, rankingThreads = threads) {
  const groups = new Map();
  for (const thread of threads) {
    const project = projectFromCwd(thread.cwd);
    if (!groups.has(project.key)) {
      groups.set(project.key, { ...project, threads: [] });
    }
    groups.get(project.key).threads.push(thread);
  }

  for (const group of groups.values()) {
    group.threads.sort((a, b) => threadTimestamp(b) - threadTimestamp(a));
  }

  const rankingGroups = new Map();
  for (const thread of rankingThreads) {
    const project = projectFromCwd(thread.cwd);
    if (!rankingGroups.has(project.key)) rankingGroups.set(project.key, { ...project, threads: [] });
    rankingGroups.get(project.key).threads.push(thread);
  }

  const projectGroups = Array.from(groups.values());
  for (const group of projectGroups) {
    group.totalCount = (rankingGroups.get(group.key) || group).threads.length;
  }

  return projectGroups.sort((a, b) => {
    const aRankingGroup = rankingGroups.get(a.key) || a;
    const bRankingGroup = rankingGroups.get(b.key) || b;
    const aRank = projectGroupRank(aRankingGroup, state.threadActivity);
    const bRank = projectGroupRank(bRankingGroup, state.threadActivity);
    if (aRank.attention !== bRank.attention) return aRank.attention - bRank.attention;
    if (aRank.updatedAt !== bRank.updatedAt) return bRank.updatedAt - aRank.updatedAt;
    return a.name.localeCompare(b.name, currentLocale());
  });
}

function threadTimestamp(thread) {
  return thread?.recencyAt || thread?.updatedAt || thread?.createdAt || 0;
}

function latestTurnTimestamp(turns) {
  return Math.max(0, ...(turns || []).map(turnTimestamp));
}

function turnTimestamp(turn) {
  return normalizeUnixSeconds(turn?.completedAt || turn?.updatedAt || turn?.startedAt || turn?.createdAt || turn?.timestamp);
}

function itemTimestamp(item) {
  return normalizeUnixSeconds(item?.completedAt || item?.updatedAt || item?.createdAt || item?.timestamp);
}

function currentUnixSeconds() {
  return Math.floor(Date.now() / 1000);
}

function normalizeUnixSeconds(value) {
  if (!value) return 0;
  if (typeof value === "number") return value > 100000000000 ? Math.floor(value / 1000) : value;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : Math.floor(parsed / 1000);
}

function createThread() {
  const key = `draft-${workflowDraftSerial + 1}`;
  if (composerDrafts && !composerDrafts.switchThread(key)) return false;
  workflowDraftSerial++;
  state.threadLoadSeq++;
  state.threadContentGate?.gate.resolve();state.threadContentGate=null;state.loadingThreadId=null;stopCurrentThreadSync();
  const cwd = els.projectSelect.value || preferredScopedCwd();
  if (cwd) setProjectSelection(cwd);
  updateThreadUrl("");
  state.currentThread = {
    draft: true,
    name: t("thread.new"),
    preview: t("thread.new"),
    cwd,
    status: "draft"
  };
  state.initialThreadRestorePending = false;
  state.messages = [];
  state.currentThreadSettings = null;
  state.lastMessageAt = null;
  state.lastLoadStats = null;
  state.threadLoadStats = null;
  resetTurnPaging();
  updateThreadHeader();
  updateProjectSelectState();
  updateTrafficSummary();
  renderEmpty(
    t("thread.new"),
    cwd ? t("empty.newThreadProject", { project: projectFromCwd(cwd).name }) : t("empty.noProject")
  );
  renderThreads();
  els.sidebar.classList.remove("open");
  applyBridgeModeUi();
  els.promptInput.focus();
  refreshWorkflow();
  return true;
}

async function createThreadOnServer() {
  const cwd = state.currentThread?.cwd || els.projectSelect.value || preferredScopedCwd();
  const params = buildSharedThreadStart({
    cwd,
    model: els.modelSelect.value,
    effort: els.reasoningSelect.value,
    permissionMode: els.permissionSelect.value,
    modes: state.permissionModes
  });
  const result = await rpc("thread/start", params);
  state.currentThread = result.thread;
  composerDrafts?.adoptThread(result.thread.id);
  const createdSettings = threadSettingsFromResume(result);
  applyThreadSettings(createdSettings);
  cacheThreadSettings(state.currentThread?.id, createdSettings);
  rememberLastThread(state.currentThread?.id);
  updateThreadUrl(state.currentThread?.id || "");
  state.lastMessageAt = threadTimestamp(state.currentThread) || null;
  setProjectSelection(state.currentThread?.cwd || "");
  state.lastLoadStats = null;
  resetTurnPaging();
  updateThreadHeader();
  updateProjectSelectState();
  updateTrafficSummary();
  await loadThreads();
  els.sidebar.classList.remove("open");
  return state.currentThread;
}

async function ensureThread() {
  if (!state.currentThread?.id) {
    await createThreadOnServer();
  }
}

async function openThread(threadOrId, { showFailure = true } = {}) {
  const threadId = typeof threadOrId === "string" ? threadOrId : threadOrId?.id;
  if (!threadId) return;
  if (composerDrafts && !composerDrafts.switchThread(threadId)) return false;
  const workflowLoadStarted = performance.now();
  let workflowLoadFailed = false;
  cancelBackgroundThreadCache(threadId);
  const loadSeq = ++state.threadLoadSeq;
  state.initialThreadRestorePending = false;
  const contentGate = createReadinessGate();
  const previewThread = typeof threadOrId === "string"
    ? state.threads.find((thread) => thread.id === threadId)
    : threadOrId;
  const cachedPage = state.recentThreadCache.get(threadId);
  const cachedSettings = state.threadSettingsCache.get(threadId);
  let restoredCachedPage = false;
  let fetchedLatestPage = false;
  let opened = false;

  streamingRenderBatcher.cancel();
  state.loadingThreadId = threadId;
  applyBridgeModeUi();
  state.threadContentGate = { threadId, loadSeq, gate: contentGate };
  setThreadActivity(threadId, { type: "opened" }, false);
  state.threadLoadStats = createThreadLoadStats(threadId, previewThread, loadSeq);
  state.lastLoadStats = null;
  state.currentThread = previewThread || { id: threadId };
  state.currentThreadSettings = null;
  const restoredCachedSettings = !needsResume(previewThread)
    && restoreThreadSettingsCache(cachedSettings);
  state.lastMessageAt = threadTimestamp(state.currentThread) || null;
  setProjectSelection(state.currentThread.cwd || "");
  updateProjectSelectState();
  state.messages = [];
  resetTurnPaging();
  if (cachedPage?.turns?.length) {
    const cachedTurns = cachedPage.turns;
    reconcileLatestTurnState(threadId, cachedTurns[0]);
    rememberLoadedTurns(cachedTurns);
    state.turnCursor = cachedPage.nextCursor || null;
    state.hasOlderTurns = Boolean(cachedPage.nextCursor);
    state.messages = flattenTurns(newestFirstToDisplayOrder(cachedTurns));
    state.lastMessageAt = cachedPage.latestAt || state.lastMessageAt;
    restoredCachedPage = true;
    opened = true;
    contentGate.resolve();
  }
  state.threadLoadStats.showLoading = !restoredCachedPage;
  els.sendButton.disabled = isSendBlocked();
  updateThreadHeader();
  updateTrafficSummary();
  if (restoredCachedPage) renderMessages(true);
  else renderThreadLoading(state.currentThread, state.threadLoadStats);
  renderThreads();
  els.sendButton.disabled = isSendBlocked();
  els.sidebar.classList.remove("open");

  let latestPagePromise = null;
  let latestPageError = null;
  const applyLatestPage = (page) => {
    if (loadSeq !== state.threadLoadSeq || state.currentThread?.id !== threadId) return;
    const stats = state.threadLoadStats;
    const flattenStartedAt = performance.now();
    const turns = page?.data || [];
    reconcileLatestTurnState(threadId, turns[0]);
    fetchedLatestPage = true;
    opened = true;
    rememberLoadedTurns(turns);
    state.turnCursor = page?.nextCursor || null;
    state.hasOlderTurns = Boolean(page?.nextCursor);
    state.messages = flattenTurns(newestFirstToDisplayOrder(turns));
    state.lastMessageAt = latestTurnTimestamp(turns) || threadTimestamp(state.currentThread) || null;
    cacheRecentThreadPage(threadId, turns, page?.nextCursor, state.lastMessageAt);
    if (stats) {
      stats.showLoading = false;
      stats.messageCount = state.messages.length;
      stats.itemCount = countTurnItems(turns);
      stats.renderMs = performance.now() - flattenStartedAt;
      stats.finishedAt = performance.now();
      stats.phase = t("load.done");
      state.lastLoadStats = stats;
    }
    renderMessages(true);
    contentGate.resolve();
  };
  const beginLatestPageRefresh = () => {
    if (latestPagePromise) return latestPagePromise;
    latestPagePromise = rpc(
      "thread/turns/list",
      {
        threadId,
        limit: TURN_PAGE_LIMIT,
        sortDirection: "desc",
        itemsView: TURN_ITEMS_VIEW
      },
      { traffic: state.threadLoadStats, label: t("load.readLatest") }
    )
      .then((page) => {
        applyLatestPage(page);
        return page;
      })
      .catch((error) => {
        latestPageError = error;
        return null;
      });
    return latestPagePromise;
  };
  const previewNeedsRefresh = !restoredCachedPage || cachedPage?.shallow || shouldRefreshCachedThread({
    cachedTimestamp: cachedPage?.latestAt,
    threadTimestamp: threadTimestamp(previewThread),
    working: state.replyProgressThreadIds.has(threadId) || state.activeTurns.has(threadId) || [THREAD_ACTIVITY.RUNNING,THREAD_ACTIVITY.WAITING].includes(activityForThread(threadId).state)
  });
  if (previewNeedsRefresh) beginLatestPageRefresh();

  try {
    await state.initialSettingsBarrier;
    if(loadSeq!==state.threadLoadSeq)return;
    if (!restoredCachedSettings) {
      updateThreadLoadPhase(state.threadLoadStats, t("load.readSettings"));
      const readResult = await rpc(
        "thread/read",
        { threadId },
        { traffic: state.threadLoadStats, label: t("load.readSettings") }
      );
      if (loadSeq !== state.threadLoadSeq) return;
      if (readResult?.thread) {
        state.currentThread = { ...state.currentThread, ...readResult.thread };
        state.threads = mergeCurrentThreadIntoList(state.threads);
        setProjectSelection(state.currentThread.cwd || "");
        updateThreadHeader();
        updateProjectSelectState();
      }

      await loadPermissionModes(state.currentThread?.cwd || "");
      const resumeResult = await rpc(
        "thread/resume",
        { threadId },
        { traffic: state.threadLoadStats, label: t("load.readSettings") }
      );
      if (loadSeq !== state.threadLoadSeq) return;
      if (resumeResult?.thread) state.currentThread = { ...state.currentThread, ...resumeResult.thread };
      const resumedSettings = threadSettingsFromResume(resumeResult);
      applyThreadSettings(resumedSettings);
      cacheThreadSettings(threadId, resumedSettings);
    }

    const cachedPageNeedsRefresh = !restoredCachedPage || cachedPage?.shallow || shouldRefreshCachedThread({
      cachedTimestamp: cachedPage?.latestAt,
      threadTimestamp: threadTimestamp(state.currentThread),
      working: state.replyProgressThreadIds.has(threadId) || state.activeTurns.has(threadId) || [THREAD_ACTIVITY.RUNNING,THREAD_ACTIVITY.WAITING].includes(activityForThread(threadId).state)
    });
    if (cachedPageNeedsRefresh && !latestPagePromise) beginLatestPageRefresh();
    if (latestPagePromise) await latestPagePromise;
    if (latestPageError) throw latestPageError;
    if (!latestPagePromise) {
      state.threadLoadStats.messageCount = state.messages.length;
      state.threadLoadStats.itemCount = countTurnItems(cachedPage.turns);
      state.threadLoadStats.finishedAt = performance.now();
      state.threadLoadStats.phase = t("load.done");
      state.lastLoadStats = state.threadLoadStats;
      updateTrafficSummary();
    }
  } catch (error) {
    workflowLoadFailed = true;
    if (loadSeq === state.threadLoadSeq) recordWorkflowMetric("load-failure", workflowLoadStarted);
    if (latestPagePromise && !fetchedLatestPage) await latestPagePromise;
    opened = opened || restoredCachedPage || fetchedLatestPage;
    if (loadSeq === state.threadLoadSeq) {
      if (showFailure && opened) addSystemMessage(error.message || t("load.retry"), false);
      else if (showFailure) renderEmpty(t("load.failedTitle"), error.message || t("load.retry"));
    }
  } finally {
    contentGate.resolve();
    if (loadSeq === state.threadLoadSeq) {
      state.loadingThreadId = null;
      applyBridgeModeUi();
      if (state.threadContentGate?.loadSeq === loadSeq) state.threadContentGate = null;
      state.threadLoadStats = null;
      els.sendButton.disabled = isSendBlocked();
      updateTrafficSummary();
      renderThreads();
      if (restoredCachedPage && !fetchedLatestPage) scheduleCurrentThreadSync();
      else scheduleCurrentThreadSync();
      pumpBackgroundThreadCache();
    }
  }
  if (opened && loadSeq === state.threadLoadSeq && state.currentThread?.id === threadId) {
    if (!workflowLoadFailed) recordWorkflowMetric("load-complete", workflowLoadStarted, state.messages.length);
    rememberLastThread(threadId);
    updateThreadUrl(threadId);
  }
  return opened;
}

function stopCurrentThreadSync() {
  if (state.threadSyncTimer) window.clearTimeout(state.threadSyncTimer);
  state.threadSyncTimer = null;
}

function scheduleCurrentThreadSync(delay = null) {
  stopCurrentThreadSync();
  if (!state.connected || !state.currentThread?.id || document.hidden) return;
  const nextDelay = delay ?? threadSyncDelay({
    visible: !document.hidden,
    working: state.replyProgressThreadIds.has(state.currentThread.id)
  });
  if (nextDelay == null) return;
  state.threadSyncTimer = window.setTimeout(runCurrentThreadSync, Math.max(0, nextDelay));
}

async function runCurrentThreadSync() {
  state.threadSyncTimer = null;
  if (state.threadSyncInFlight || state.loadingThreadId || !state.connected || document.hidden) {
    scheduleCurrentThreadSync();
    return;
  }
  const threadId = state.currentThread?.id;
  if (!threadId) return;
  const working=state.replyProgressThreadIds.has(threadId)||state.activeTurns.has(threadId);
  if(!shouldRecoverThread({working,lastPushAt:state.lastThreadPushAt.get(threadId),lastRecoveryAt:state.lastThreadRecoveryAt.get(threadId)})){scheduleCurrentThreadSync();return;}
  state.threadSyncInFlight = true;
  const workflowSyncStarted = performance.now();
  try {
    const recoverySeq=state.threadLoadSeq,isCurrent=()=>state.currentThread?.id===threadId&&state.threadLoadSeq===recoverySeq;
    const recovery=await recoverThreadPage({working,knownTurnIds:state.loadedTurnIds,stillCurrent:isCurrent,read:limit=>rpc("thread/turns/list",{threadId,limit,sortDirection:"desc",itemsView:TURN_ITEMS_VIEW})});
    if(!recovery||!isCurrent())return;const page=recovery.page;
    state.lastThreadRecoveryAt.set(threadId,Date.now());
    const turns = page?.data || [];
    const latestTurn = turns[0];
    const hadReplyProgress = state.replyProgressThreadIds.has(threadId);
    const lifecycle = reconcileLatestTurnState(threadId, latestTurn);
    if(recovery.resetWindow)resetTurnPaging();
    rememberLoadedTurns(turns);
    if(recovery.backfill){state.turnCursor=page?.nextCursor||null;state.hasOlderTurns=Boolean(page?.nextCursor);}
    const recent = flattenTurns(newestFirstToDisplayOrder(turns));
    const preserveLiveState = lifecycle === "active" || (lifecycle === "unknown" && hadReplyProgress);
    const recentIds=new Set(turns.map(turn=>turn.id));
    const current=recovery.resetWindow?state.messages.filter(message=>recentIds.has(message.turnId)):state.messages;
    const reconciled = mergeRecentMessages(current, recent, { preserveLiveState });
    const replyProgressChanged = hadReplyProgress !== state.replyProgressThreadIds.has(threadId);
    const latestAt = latestTurnTimestamp(turns) || state.lastMessageAt;
    cacheRecentThreadPage(threadId, turns, page?.nextCursor, latestAt, recovery.latestOnly);
    if (recovery.resetWindow || reconciled.changed || replyProgressChanged) {
      const shouldStickToBottom = recovery.resetWindow || shouldStickToLiveOutput();
      streamingRenderBatcher.cancel();
      state.messages = reconciled.messages;
      state.lastMessageAt = latestAt;
      renderMessages(shouldStickToBottom);
    }
    refreshThreadManifestIfDue();
    recordWorkflowMetric("sync-success", workflowSyncStarted, recent.length);
  } catch {
    recordWorkflowMetric("sync-failure", workflowSyncStarted);
    // Live notifications remain primary; the next bounded sync retries silently.
  } finally {
    state.threadSyncInFlight = false;
    scheduleCurrentThreadSync();
  }
}

function reconcileLatestTurnState(threadId, latestTurn) {
  const lifecycle = turnLifecycle(latestTurn?.status);
  const currentTurnId = state.activeTurns.get(threadId) || null;
  const activeTurnId = activeTurnIdFromLatest(currentTurnId, latestTurn);
  if (activeTurnId) state.activeTurns.set(threadId, activeTurnId);
  else if (lifecycle === "terminal") state.activeTurns.delete(threadId);

  if (lifecycle === "active") startReplyProgress(threadId);
  else if (lifecycle === "terminal") stopReplyProgress(threadId);
  if (threadId === state.currentThread?.id) updateSendMode();
  return lifecycle;
}

async function restoreInitialThread() {
  if (state.currentThread?.id || state.currentThread?.draft) return false;
  const candidates = initialThreadCandidates({
    threads: state.threads,
    urlThreadId: state.urlThreadId,
    lastThreadId: storedLastThreadId()
  });
  const restored = await restoreOwnedThread(
    candidates,
    (thread) => openThread(thread, { showFailure: false }),
    () => state.threadLoadSeq
  );
  if (restored.opened) return true;
  if (restored.cancelled) return false;
  clearRememberedThread();
  updateThreadUrl("");
  return false;
}

function rememberLastThread(threadId) {
  if (!threadId) return;
  try {
    localStorage.setItem(LAST_THREAD_STORAGE_KEY, threadId);
  } catch {
    // Private browsing can disable localStorage.
  }
}

function storedLastThreadId() {
  try {
    return localStorage.getItem(LAST_THREAD_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

function clearRememberedThread() {
  try {
    localStorage.removeItem(LAST_THREAD_STORAGE_KEY);
  } catch {
    // Private browsing can disable localStorage.
  }
}

function updateThreadUrl(threadId) {
  if (!window.history?.replaceState) return;
  const url = new URL(cleanBackGuardUrl(window.location.href));
  url.searchParams.delete("token");
  if (threadId) {
    url.searchParams.set(THREAD_URL_PARAM, threadId);
    state.urlThreadId = threadId;
  } else {
    url.searchParams.delete(THREAD_URL_PARAM);
    state.urlThreadId = "";
  }
  const nextUrl = url.toString();
  backGuardBaseUrl = nextUrl;
  window.history.replaceState({ ...(window.history.state || {}), codexWebUIPage: true }, "", nextUrl);
  if (window.__codexWebUIBackGuard) window.setTimeout(armBackButtonGuard, 0);
}


async function resumeCurrentThread(options = {}) {
  const showError = options.showError !== false;
  const thread = state.currentThread;
  if (!thread?.id || !needsResume(thread) || state.resumingThreadId) return false;

  const threadId = thread.id;
  state.resumingThreadId = threadId;
  updateResumeStatus(thread);
  els.threadMeta.textContent = `${shortPath(thread.cwd)} · ${t("status.resuming")}`;

  try {
    const result = await rpc("thread/resume", { threadId });
    if (state.currentThread?.id === threadId) {
      state.currentThread = result.thread || state.currentThread;
      applyThreadSettings(threadSettingsFromResume(result));
      updateThreadHeader();
    }
    renderThreads();
    return true;
  } catch (error) {
    if (showError) addSystemMessage(error.message || t("error.resume"));
    throw error;
  } finally {
    if (state.resumingThreadId === threadId) {
      state.resumingThreadId = null;
    }
    updateResumeStatus(state.currentThread);
  }
}

async function sendTurn(text, { queue = false, expectedActiveTurnId = null } = {}) {
  if (state.sendingThreadId) return;
  const draftTicket = composerDrafts?.beginSend();
  let sendConfirmed = false;
  const intendedThreadId = state.currentThread?.id || "";
  const sendKey = intendedThreadId || `draft:${Date.now()}`;
  const contentGate = state.threadContentGate?.threadId === intendedThreadId
    ? state.threadContentGate.gate
    : null;
  state.sendingThreadId = sendKey;
  asyncQuestionCards.refresh();
  els.sendButton.disabled = true;
  setFollowUpMenuOpen(false);
  try {
    if (contentGate && !contentGate.ready) {
      els.sendButton.textContent = t("composer.waiting");
      await contentGate.promise;
      if (state.currentThread?.id !== intendedThreadId) {
        throw new Error(t("error.threadChangedDuringSend"));
      }
    }

    const wasDraft = !state.currentThread?.id;
    const sendStartedAt = performance.now();
    await ensureThread();
    const threadId = state.currentThread.id;
    const turnDebugId = `${threadId}:${Date.now()}`;
    state.turnDiagnostics.set(threadId, {
      id: turnDebugId,
      threadId,
      startedAt: sendStartedAt,
      textChars: String(text || "").length,
      imageCount: state.pendingImages.length,
      firstDeltaAt: 0,
      turnStartedAt: 0,
      turnStartRpcDoneAt: 0
    });
    logTurnDebug("send-begin", threadId);
    const hasPendingUploads = state.pendingImages.some(
      (image) => image.status === "preparing" || image.status === "uploading"
    );
    if (hasPendingUploads) {
      els.sendButton.textContent = t("composer.waitingImages");
      els.sendButton.setAttribute("aria-label", t("composer.waitingImages"));
      await waitForPendingImageUploads(state.pendingImages);
      if (state.currentThread?.id !== threadId) throw new Error(t("error.threadChangedDuringSend"));
    }
    const images = state.pendingImages.filter((image) => image.status === "ready" && image.path);
    if (state.pendingImages.some((image) => image.status === "preparing" || image.status === "uploading")) {
      addSystemMessage(t("image.pending"));
      logTurnDebug("blocked-images-uploading", threadId);
      return;
    }
    if (state.pendingImages.some((image) => image.status === "failed")) {
      addSystemMessage(t("image.uploadFailed"));
      logTurnDebug("blocked-images-failed", threadId);
      return;
    }
    const activeTurnId = state.activeTurns.get(threadId) || null;
    if (expectedActiveTurnId && activeTurnId !== expectedActiveTurnId) {
      throw new Error(t("error.followUpTurnEnded"));
    }

    state.followLiveOutput = true;
    state.lastMessageAt = currentUnixSeconds();
    const queued = Boolean(queue && activeTurnId);
    const clientUserMessageId = crypto.randomUUID();
    if (!activeTurnId) startReplyProgress(threadId);
    const automationHeartbeat = parseAutomationHeartbeat(text);
    if (!queued) {
      addMessage({
        role: "user",
        kind: automationHeartbeat ? "automationHeartbeat" : undefined,
        text,
        automationHeartbeat,
        images: images.map((image) => ({ kind: "source", source: image.path })),
        clientUserMessageId,
        pendingLocal: true
      });
      if (!activeTurnId) addPendingReplyMessage(threadId, true);
    }

    if (needsResume(state.currentThread)) {
      await resumeCurrentThread({ showError: false });
    }

    const input = [
      ...(text ? [{ type: "text", text, text_elements: [] }] : []),
      ...images.map((image) => ({ type: "localImage", path: image.path }))
    ];
    const request = buildPromptRequest({
      threadId,
      activeTurnId,
      input,
      clientUserMessageId,
      queue: queued
    });
    const result = await rpc(request.method, request.params);
    sendConfirmed = true;
    // The pending snapshot stays visible until the RPC actually succeeds.
    state.pendingImages = state.pendingImages.filter(image => !images.includes(image));
    renderImageTray(); revokeImagePreviews(images);
    composerDrafts?.finishSend(draftTicket, true);
    if (request.mode === "queue") {
      addSystemMessage(t("composer.queued"));
      return;
    }
    const resultTurnId = result?.turn?.id || result?.turnId;
    if (resultTurnId) state.activeTurns.set(threadId, resultTurnId);
    const diagnostics = state.turnDiagnostics.get(threadId);
    if (diagnostics) diagnostics.turnStartRpcDoneAt = performance.now();
    logTurnDebug(request.mode === "steer" ? "turn-steer-rpc-done" : "turn-start-rpc-done", threadId);
    if (wasDraft) {
      await loadThreads();
      renderThreads();
    }
  } finally {
    if (!sendConfirmed) composerDrafts?.finishSend(draftTicket, false);
    if (state.sendingThreadId === sendKey) state.sendingThreadId = null;
    asyncQuestionCards.refresh();
    els.sendButton.disabled = isSendBlocked();
    updateSendMode();
  }
}

async function loadOlderTurns() {
  if (!state.currentThread?.id || !state.turnCursor || state.loadingOlderTurns) return;

  const threadId = state.currentThread.id;
  const workflowLoadStarted = performance.now();
  const previousHeight = els.messages.scrollHeight;
  const previousTop = els.messages.scrollTop;
  state.loadingOlderTurns = true;
  renderMessages(false);
  els.messages.scrollTop = previousTop;
  const cursor = state.turnCursor;
  let rendered = false;

  try {
    const page = await rpc(
      "thread/turns/list",
      {
        threadId,
        cursor,
        limit: TURN_PAGE_LIMIT,
        sortDirection: "desc",
        itemsView: TURN_ITEMS_VIEW
      },
      { traffic: state.lastLoadStats, label: t("load.older") }
    );

    if (cursor !== state.turnCursor || threadId !== state.currentThread?.id) return;

    const turns = filterUnloadedTurns(page.data || []);
    rememberLoadedTurns(turns);
    state.turnCursor = page.nextCursor || null;
    state.hasOlderTurns = Boolean(page.nextCursor);
    state.messages = [...flattenTurns(newestFirstToDisplayOrder(turns)), ...state.messages];
    if (state.lastLoadStats) {
      state.lastLoadStats.messageCount = state.messages.length;
      state.lastLoadStats.itemCount += countTurnItems(turns);
      state.lastLoadStats.finishedAt = performance.now();
    }

    state.loadingOlderTurns = false;
    renderMessages(false);
    updateTrafficSummary();
    rendered = true;
    recordWorkflowMetric("load-complete", workflowLoadStarted, turns.length);
    els.messages.scrollTop = anchoredHistoryScrollTop({
      beforeHeight: previousHeight,
      beforeTop: previousTop,
      afterHeight: els.messages.scrollHeight
    });
  } catch (error) {
    recordWorkflowMetric("load-failure", workflowLoadStarted);
    state.loadingOlderTurns = false;
    renderMessages(false);
    els.messages.scrollTop = previousTop;
    updateTrafficSummary();
    rendered = true;
    addSystemMessage(error.message || t("load.olderError"), false);
    els.messages.scrollTop = previousTop;
  } finally {
    if (threadId === state.currentThread?.id) {
      state.loadingOlderTurns = false;
      if (!rendered) renderMessages(false);
    }
  }
}

function applyThreadSettings(settings) {
  if (!settings) return;
  state.currentThreadSettings = settings;
  if (state.pendingSettingsSelection?.threadId === state.currentThread?.id) return;
  state.applyingThreadSettings = true;
  renderPermissionModes();
  const effort = settings.effort || "";
  if (settings.model) {
    setModelValue(settings.model, effort);
  } else {
    updateReasoningOptions(effort, { useModelDefault: true });
  }
  const permissionMode = permissionModeFromSettings(settings, state.permissionModes);
  if (permissionMode === "custom") {
    const option = document.createElement("option");
    option.value = "custom";
    option.textContent = t("permission.custom");
    option.disabled = true;
    els.permissionSelect.append(option);
  }
  setSelectValueIfPresent(els.permissionSelect, permissionMode);
  state.applyingThreadSettings = false;
  applyBridgeModeUi();
}

function applyAuthoritativeThreadSettings() {
  applyThreadSettings(state.currentThreadSettings);
}

async function persistSelectedThreadSettings() {
  if (!state.threadSettingsAvailable || state.applyingThreadSettings || !state.currentThread?.id) return;
  state.pendingSettingsSelection = {
    threadId: state.currentThread.id,
    model: els.modelSelect.value,
    effort: els.reasoningSelect.value,
    permissionMode: els.permissionSelect.value
  };
  if (state.settingsSaving) return;
  await flushSelectedThreadSettings();
}

async function flushSelectedThreadSettings() {
  const selection = state.pendingSettingsSelection;
  if (!selection || state.settingsSaving) return;
  state.pendingSettingsSelection = null;
  const previous = state.currentThreadSettings;
  state.settingsSaving = true;
  applyBridgeModeUi();
  try {
    const params = buildThreadSettingsUpdate({
      ...selection,
      modes: state.permissionModes
    });
    await rpc("thread/settings/update", params);
    if (state.currentThread?.id !== selection.threadId) return;
    if (state.activeTurns.has(selection.threadId)) {
      els.threadMeta.textContent = t("settings.nextTurn");
    } else {
      els.threadMeta.textContent = t("settings.saved");
    }
  } catch (error) {
    if (state.currentThread?.id === selection.threadId) {
      state.currentThreadSettings = previous;
      applyAuthoritativeThreadSettings();
    }
    if (state.currentThread?.id === selection.threadId) {
      addSystemMessage(error.message || t("error.request"));
    }
  } finally {
    state.settingsSaving = false;
    applyBridgeModeUi();
    if (state.pendingSettingsSelection) queueMicrotask(flushSelectedThreadSettings);
  }
}

function setSelectValueIfPresent(select, value) {
  if (!select || !value) return;
  if ([...select.options].some((option) => option.value === value)) {
    select.value = value;
  }
}

function setModelValue(value, preferredEffort = "") {
  if (!els.modelSelect || !value) return;
  if (![...els.modelSelect.options].some((option) => option.value === value)) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    els.modelSelect.append(option);
  }
  els.modelSelect.value = value;
  updateReasoningOptions(preferredEffort, { useModelDefault: true });
}

function updateReasoningOptions(preferredValue = "", { useModelDefault = false } = {}) {
  if (!els.reasoningSelect) return;
  const model = state.models.find((entry) => (entry.model || entry.id) === els.modelSelect.value);
  const supported = model?.supportedReasoningEfforts?.length
    ? model.supportedReasoningEfforts
    : ["low", "medium", "high", "xhigh"].map((reasoningEffort) => ({ reasoningEffort }));
  const previousValue = useModelDefault ? "" : els.reasoningSelect.value;
  const requestedValue = preferredValue || previousValue;

  els.reasoningSelect.innerHTML = "";
  for (const entry of supported) {
    const value = entry.reasoningEffort || entry.effort || entry.id;
    if (!value) continue;
    const option = document.createElement("option");
    option.value = value;
    option.textContent = reasoningEffortLabel(value);
    if (entry.description) option.title = entry.description;
    els.reasoningSelect.append(option);
  }

  const available = [...els.reasoningSelect.options].map((option) => option.value);
  const modelDefault = model?.defaultReasoningEffort || "medium";
  els.reasoningSelect.value = available.includes(requestedValue)
    ? requestedValue
    : available.includes(modelDefault)
      ? modelDefault
      : available[0] || "";
}

function reasoningEffortLabel(value) {
  const key = `reasoning.${value}`;
  const label = t(key);
  return label === key ? value : label;
}

function configReasoningEffort(config) {
  return config?.model_reasoning_effort
    || config?.modelReasoningEffort
    || config?.reasoningEffort
    || config?.effort
    || "";
}

function flattenThread(thread) {
  return flattenTurns(thread?.turns || []);
}

function flattenTurns(turns) {
  const messages = [];
  for (const turn of turns || []) {
    for (const item of turn.items || []) {
      const message = messageFromItem(item);
      if (message) messages.push({ ...message, turnId: turn?.id || "" });
    }
  }
  return messages;
}

function countThreadItems(thread) {
  return countTurnItems(thread?.turns || []);
}

function countTurnItems(turns) {
  return (turns || []).reduce((total, turn) => total + (turn.items?.length || 0), 0);
}

function newestFirstToDisplayOrder(turns) {
  return [...(turns || [])].reverse();
}

function resetTurnPaging() {
  state.turnCursor = null;
  state.hasOlderTurns = false;
  state.loadingOlderTurns = false;
  state.historyAutoLoadArmed = false;
  state.followLiveOutput = true;
  state.openDisclosures = new Set();
  state.loadedTurnIds = new Set();
}

function rememberLoadedTurns(turns) {
  for (const turn of turns || []) {
    if (turn?.id) state.loadedTurnIds.add(turn.id);
  }
}

function cacheRecentThreadPage(threadId, turns, nextCursor, latestAt = null, latestOnly = false) {
  if (!threadId) return;
  state.recentThreadCache.set(threadId, {
    ...(latestOnly?latestCachedPage(state.recentThreadCache.get(threadId),{data:turns,nextCursor}):{turns:Array.isArray(turns)?turns:[],nextCursor:nextCursor||null,shallow:false}),
    latestAt: latestAt || latestTurnTimestamp(turns) || null
  });
}

function cacheThreadSettings(threadId, settings, { preservePermissions = false } = {}) {
  if (!threadId || !settings) return;
  const existing = state.threadSettingsCache.get(threadId) || {};
  state.threadSettingsCache.set(threadId, {
    ...existing,
    settings,
    complete: preservePermissions ? Boolean(existing.complete) : true,
    permissionProfiles: preservePermissions
      ? [...(existing.permissionProfiles || [])]
      : [...(state.permissionProfiles || [])],
    permissionModes: preservePermissions
      ? [...(existing.permissionModes || [])]
      : [...(state.permissionModes || [])],
    configRequirements: preservePermissions
      ? existing.configRequirements
      : state.configRequirements
  });
}

function restoreThreadSettingsCache(cached) {
  if (!cached?.complete || !cached?.settings) return false;
  state.permissionProfiles = [...(cached.permissionProfiles || state.permissionProfiles || [])];
  state.permissionModes = [...(cached.permissionModes || state.permissionModes || [])];
  state.configRequirements = cached.configRequirements ?? state.configRequirements;
  renderPermissionModes();
  applyThreadSettings(cached.settings);
  return true;
}

function filterUnloadedTurns(turns) {
  return (turns || []).filter((turn) => !turn?.id || !state.loadedTurnIds.has(turn.id));
}

function needsResume(thread) {
  return formatStatus(thread?.status) === "notLoaded";
}

function messageFromItem(item) {
  if (item.type === "userMessage") {
    const content = item.content || [];
    const text = cleanUserText(content.map(inputToText).filter(Boolean).join("\n"));
    const automationHeartbeat = parseAutomationHeartbeat(text);
    return {
      role: "user",
      id: item.id,
      clientUserMessageId: item.clientId || undefined,
      kind: automationHeartbeat ? "automationHeartbeat" : undefined,
      text,
      questionReplies: parseQuestionReply(text),
      automationHeartbeat,
      images: content
        .filter((entry) => entry.type === "localImage" || entry.type === "image")
        .map(normalizeImageReference)
        .filter(Boolean)
    };
  }
  if (item.type === "agentMessage") {
    return { role: "assistant", id: item.id, text: cleanAssistantText(item.text), phase:item.phase, delivery:item.delivery, questions:asyncQuestions(item), classificationPending: !["final", "final_answer", "commentary"].includes(item.phase) };
  }
  if (item.type === "imageGeneration") {
    const image = normalizeImageReference(item);
    const state = imageGenerationState(item, image);
    return {
      role: "assistant",
      id: item.id,
      text: "",
      images: image ? [image] : [],
      imageGeneration: state
    };
  }
  if (item.type === "plan") {
    return { role: "system", id: item.id, text: item.text || "" };
  }
  if (item.type === "commandExecution") {
    const output = item.aggregatedOutput ? `\n\n${item.aggregatedOutput}` : "";
    return { role: "tool", id: item.id, text: `$ ${item.command}${output}` };
  }
  if (item.type === "fileChange") {
    const changes = item.changes || [];
    const paths = changes.map((change) => change.path).filter(Boolean);
    const detail = paths.length ? `\n${paths.join("\n")}` : "";
    return {
      role: "tool",
      id: item.id,
      text: t("tool.fileChange", { status: formatStatusLabel(item.status || "completed"), detail })
    };
  }
  if (item.type === "mcpToolCall") {
    const name = [item.server, item.tool].filter(Boolean).join("/");
    const output = toolResultText(item.result);
    return {
      role: "tool",
      id: item.id,
      text: t("tool.call", {
        name: name || "tool",
        status: formatStatusLabel(item.status || "completed"),
        output: output ? `\n\n${output}` : ""
      })
    };
  }
  if (item.type === "contextCompaction") {
    return { role: "tool", kind: "contextCompaction", id: item.id, text: t("tool.compacted") };
  }
  if (item.type === "reasoning") {
    const reasoningParts = cleanReasoningParts(item);
    const text = reasoningParts.join("\n\n");
    return text ? { role: "system", kind: "reasoning", id: item.id, text, reasoningParts } : null;
  }
  return null;
}

function cleanReasoningParts(item) {
  return [...(item?.summary || []), ...(item?.content || [])]
    .map((entry) => typeof entry === "string" ? entry : entry?.text || entry?.content || "")
    .map((text) => text
      .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim())
    .filter(Boolean);
}

function normalizeImageReference(entry) {
  if (entry.inlineImageId) {
    return {
      kind: "inline",
      id: entry.inlineImageId,
      bytes: entry.omittedBytes || 0,
      mimeType: entry.mimeType || "image/*"
    };
  }
  const source = entry.path || entry.savedPath || entry.url;
  return source ? { kind: "source", source } : null;
}

function imageGenerationState(item, image) {
  const rawStatus = String(item?.status || item?.state || "").toLowerCase();
  const rawError = item?.error?.message || item?.error || item?.failureReason || "";
  const failed = Boolean(
    rawError
    || rawStatus.includes("fail")
    || rawStatus.includes("error")
    || rawStatus.includes("cancel")
  );
  const complete = Boolean(
    image
    || rawStatus.includes("complete")
    || rawStatus.includes("done")
    || rawStatus === "succeeded"
  );
  return {
    pending: !complete && !failed,
    failed,
    status: rawStatus || (image ? "completed" : "running"),
    detail: String(rawError || "").trim()
  };
}

function toolResultText(result) {
  const content = result?.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((entry) => entry?.type === "text" ? entry.text : "")
    .filter(Boolean)
    .join("\n")
    .slice(0, 1200);
}

function cleanUserText(text) {
  let next = String(text || "").trim();
  next = next.replace(/# Files mentioned by the user:[\s\S]*?(?=\n## My request for Codex:|$)/g, "").trim();
  next = next.replace(/# Browser comments:[\s\S]*?(?=\n# In app browser:|\n## My request for Codex:|$)/g, "").trim();
  next = next.replace(/# In app browser:\s*(?:\n- .*)*\s*/g, "").trim();
  next = next.replace(/^## My request for Codex:\s*/m, "").trim();
  next = next
    .split(/\r?\n/)
    .filter((line) => {
      const value = line.trim();
      return value !== "In app browser:"
        && !value.startsWith("- The user has the in-app browser open.")
        && !value.startsWith("- Current URL:")
        && !value.startsWith("The user has the in-app browser open.")
        && !value.startsWith("Current URL:")
        && value !== "My request for Codex:";
    })
    .join("\n")
    .trim();
  return next;
}

function cleanAssistantText(text) {
  const source = String(text || "").trim();
  const heartbeatResult = parseAutomationHeartbeatResult(source);
  if (!heartbeatResult) return source;
  return heartbeatResult.visibleText || heartbeatResult.message;
}

function parseAutomationHeartbeatResult(text) {
  const source = String(text || "").trim();
  const match = source.match(/(?:^|\n)[ \t]*(<heartbeat(?:\s[^>]*)?>[\s\S]*?<\/heartbeat>)[ \t]*$/i);
  if (!match) return null;

  const documentNode = new DOMParser().parseFromString(match[1], "application/xml");
  if (documentNode.querySelector("parsererror")) return null;
  const root = documentNode.documentElement;
  if (root?.localName?.toLowerCase() !== "heartbeat") return null;

  const children = [...root.children];
  const childText = (name) => children
    .find((child) => child.localName?.toLowerCase() === name)
    ?.textContent?.trim() || "";
  const automationId = childText("automation_id");
  const decision = childText("decision");
  if (!automationId || !decision) return null;

  return {
    automationId,
    decision,
    message: childText("message"),
    visibleText: source.slice(0, match.index).trim()
  };
}

function parseAutomationHeartbeat(text) {
  const source = String(text || "").trim();
  if (!/^<heartbeat[>\s]/i.test(source)) return null;

  const documentNode = new DOMParser().parseFromString(source, "application/xml");
  if (documentNode.querySelector("parsererror")) return null;
  const root = documentNode.documentElement;
  if (root?.localName?.toLowerCase() !== "heartbeat") return null;

  const automationId = root.querySelector("automation_id")?.textContent?.trim() || "";
  const currentTimeIso = root.querySelector("current_time_iso")?.textContent?.trim() || "";
  const instructions = root.querySelector("instructions")?.textContent?.trim() || "";
  if (!automationId && !currentTimeIso && !instructions) return null;
  return { automationId, currentTimeIso, instructions };
}

function inputToText(item) {
  if (item.type === "text") return item.text;
  if (item.type === "image" || item.type === "localImage") return "";
  if (item.type === "skill") return `$${item.name}`;
  if (item.type === "mention") return `$${item.name}`;
  return "";
}

function handleMessage(message, rawBytes = 0) {
  if (message.type === "hello") {
    state.threadSettingsAvailable = Boolean(message.capabilities?.threadSettings);
    state.workspaceBrowserAvailable = Boolean(message.capabilities?.workspaceBrowser);
    setDesktopBridgeStatus(Boolean(message.desktopBridgeConnected));
    state.threadFilterCwds = scopeCwdsFrom(message);
    if (!els.cwdInput.value) els.cwdInput.value = message.defaultCwd || "";
    renderProjectOptions();
    if (message.interactionsAuthoritative) reconcileRequestActivities(message.pendingServerRequests || []);
    interactionController.reconcile(message.pendingServerRequests || [], { authoritative: Boolean(message.interactionsAuthoritative), epoch: message.interactionEpoch, states: message.interactionStates || [], connected: Boolean(message.desktopBridgeConnected) && state.connected });
    return;
  }
  if (message.type === "rpc-result") {
    settleRequest(message.requestId, null, message.result, rawBytes || encodedJsonBytes(message));
    return;
  }
  if (message.type === "rpc-error") {
    settleRequest(
      message.requestId,
      Object.assign(new Error(message.error || t("error.request")), { code: message.code }),
      null,
      rawBytes || encodedJsonBytes(message)
    );
    return;
  }
  if (message.type === "codex-notification") {
    handleNotification(message.notification);
    return;
  }
  if (message.type === "server-request") {
    trackServerRequest(message.request);
    renderApprovals([message.request]);
    return;
  }
  if (message.type === "server-request-resolved") {
    resolveServerRequestActivity(message.id);
    removeApproval(message.id);
    return;
  }
  if (message.type === "server-request-snapshot") {
    if (message.authoritative) reconcileRequestActivities(message.requests || []);
    interactionController.reconcile(message.requests || [], { authoritative: Boolean(message.authoritative), epoch: message.epoch, states: message.states || [], connected: Boolean(state.desktopBridgeConnected) && state.connected });
    return;
  }
  if (message.type === "server-request-state") {
    interactionController.updateState(message.id, message.status);
    return;
  }
  if (message.type === "desktop-bridge-status") {
    interactionController.setConnected(Boolean(message.connected) && state.connected);
    setDesktopBridgeStatus(Boolean(message.connected));
    return;
  }
  if (message.type === "bridge-error") {
    setDesktopBridgeStatus(false);
    return;
  }
}

function handleNotification(notification) {
  const { method, params } = notification || {};
  if (!method) return;
  const notificationThreadId = String(params?.threadId || params?.thread_id || "");
  if(notificationThreadId&&BACKGROUND_CACHE_NOTIFICATION_METHODS.has(method)){state.lastThreadPushAt.set(notificationThreadId,Date.now());if(state.lastThreadPushAt.size>128)state.lastThreadPushAt.delete(state.lastThreadPushAt.keys().next().value);}
  if (
    notificationThreadId
    && notificationThreadId !== state.currentThread?.id
    && BACKGROUND_CACHE_NOTIFICATION_METHODS.has(method)
  ) {
    scheduleBackgroundThreadCache(
      notificationThreadId,
      method === "item/agentMessage/delta" ? 220 : 0
    );
  }

  if (method === "error") {
    if (params.threadId !== state.currentThread?.id) {
      if (!params.willRetry && params.threadId) {
        setThreadActivity(params.threadId, {
          type: "turn-completed",
          status: "failed",
          unread: true
        });
      }
      return;
    }
    const shouldStickToBottom = shouldStickToLiveOutput();
    const message = retryErrorText(params.error);
    const willRetry = Boolean(params.willRetry);
    replaceOrAppendMessage({
      role: "tool",
      kind: willRetry ? "retrying" : "retryFailed",
      id: retryStatusId(params.turnId),
      text: t(willRetry ? "retry.retrying" : "retry.failed", { message })
    });
    if (willRetry) ensureReplyProgressIndicator(params.threadId, shouldStickToBottom);
    renderMessages(shouldStickToBottom);
    return;
  }

  if (method === "thread/started") {
    loadThreads();
    return;
  }

  if (method === "thread/settings/updated") {
    const settings = threadSettingsFromNotification(params);
    if (params.threadId && settings) {
      cacheThreadSettings(params.threadId, settings, { preservePermissions: true });
    }
    if (params.threadId !== state.currentThread?.id) return;
    applyThreadSettings(settings);
    if (state.activeTurns.has(params.threadId)) {
      els.threadMeta.textContent = t("settings.nextTurn");
    }
    return;
  }

  if (method === "item/agentMessage/delta") {
    if (params.threadId !== state.currentThread?.id) return;
    markRetryRecovered(params.turnId);
    const diagnostics = state.turnDiagnostics.get(params.threadId);
    if (diagnostics && !diagnostics.firstDeltaAt) {
      diagnostics.firstDeltaAt = performance.now();
      logTurnDebug("first-delta", params.threadId, { itemId: params.itemId });
    }
    const shouldStickToBottom = shouldStickToLiveOutput();
    let message = state.messages.find((entry) => entry.id === params.itemId);
    if (!message) {
      message = takePendingReplyMessage(params.threadId, params.itemId)
        || { role: "assistant", id: params.itemId, text: "" };
      message.classificationPending = true;
      message.liveNotification = true;
      state.messages.push(message);
    }
    if (!message.turnId) message.turnId = params.turnId || "";
    message.text += params.delta || "";
    message.pendingReply = false;
    message.streamingReply = true;
    invalidateWorkflow();
    state.lastMessageAt = currentUnixSeconds();
    streamingRenderBatcher.schedule({
      threadId: params.threadId,
      itemId: params.itemId,
      scroll: shouldStickToBottom
    });
    return;
  }

  if (method === "item/started") {
    if (params.threadId !== state.currentThread?.id) return;
    markRetryRecovered(params.turnId);
    const shouldStickToBottom = shouldStickToLiveOutput();
    const item = params.item;
    if (item?.type === "agentMessage") {
      const existing = state.messages.find(message => message.id === item.id);
      const message = messageFromItem(item);
      if (existing?.text) message.text = existing.text; // A reordered start must not erase deltas.
      message.turnId = params.turnId || "";
      message.liveNotification = true; message.streamingReply = true;
      removePendingReplyMessages(params.threadId);
      replaceOrAppendMessage(message);
      renderMessages(shouldStickToBottom);
    } else if (item?.type === "commandExecution") {
      ensureReplyProgressIndicator(params.threadId, shouldStickToBottom);
      addMessage({ role: "tool", id: item.id, text: `$ ${item.command}` }, shouldStickToBottom);
    } else if (item?.type === "fileChange") {
      ensureReplyProgressIndicator(params.threadId, shouldStickToBottom);
      addMessage({ role: "tool", id: item.id, text: t("tool.preparingFileChange") }, shouldStickToBottom);
    } else if (item?.type === "contextCompaction") {
      ensureReplyProgressIndicator(params.threadId, shouldStickToBottom);
      addMessage({
        role: "tool",
        kind: "contextCompaction",
        id: item.id,
        text: t("tool.compacting")
      }, shouldStickToBottom);
    } else if (item?.type === "imageGeneration") {
      removePendingReplyMessages(params.threadId);
      const message = messageFromItem(item);
      if (message) {
        replaceOrAppendMessage(message);
        state.lastMessageAt = currentUnixSeconds();
        renderMessages(shouldStickToBottom);
      }
    }
    return;
  }

  if (method === "item/completed") {
    if (params.threadId !== state.currentThread?.id) return;
    streamingRenderBatcher.cancel();
    const shouldStickToBottom = shouldStickToLiveOutput();
    const message = messageFromItem(params.item);
    if (!message) return;
    message.turnId = params.turnId || "";
    message.liveNotification = true;
    if (message.role === "user") {
      clearMatchingPendingUserMessage(message.text, message.images || []);
    } else if (message.role === "assistant") {
      removePendingReplyMessages(params.threadId);
      clearStreamingReply(message.id);
    } else {
      ensureReplyProgressIndicator(params.threadId, shouldStickToBottom);
    }
    replaceOrAppendMessage(message);
    state.lastMessageAt = itemTimestamp(params.item) || currentUnixSeconds();
    renderMessages(shouldStickToBottom);
    scheduleCurrentThreadSync(0);
    return;
  }

  if (method === "turn/started") {
    const turnId = params.turn?.id || params.turnId;
    if (params.threadId) {
      if (turnId) state.activeTurns.set(params.threadId, turnId);
      setThreadActivity(params.threadId, { type: "turn-started", turnId });
    }
    if (params.threadId === state.currentThread?.id) {
      streamingRenderBatcher.cancel();
      updateSendMode();
      const diagnostics = state.turnDiagnostics.get(params.threadId);
      if (diagnostics && !diagnostics.turnStartedAt) {
        diagnostics.turnStartedAt = performance.now();
        logTurnDebug("turn-started", params.threadId);
      }
      startReplyProgress(params.threadId);
      els.threadMeta.textContent = t("turn.working");
      addPendingReplyMessage(params.threadId, shouldStickToLiveOutput());
    }
    return;
  }

  if (method === "turn/completed") {
    const turnId = params.turn?.id || params.turnId;
    const status = params.turn?.status || "completed";
    if (
      params.threadId === state.currentThread?.id
      && state.interruptingTurnId
      && (!turnId || state.interruptingTurnId === turnId)
    ) {
      state.interruptingTurnId = null;
    }
    if (params.threadId) {
      state.activeTurns.delete(params.threadId);
      setThreadActivity(params.threadId, {
        type: "turn-completed",
        status,
        turnId,
        unread: params.threadId !== state.currentThread?.id,
        updatedAt: turnTimestamp(params.turn)
      });
      notifyTurnCompletion(params.threadId, turnId, status);
    }
    if (params.threadId === state.currentThread?.id) {
      streamingRenderBatcher.cancel();
      updateSendMode();
      if (formatStatus(params.turn?.status) === "completed") markRetryRecovered(params.turnId);
      logTurnDebug("turn-completed", params.threadId, {
        status: params.turn?.status || "done",
        turnTimestamp: turnTimestamp(params.turn)
      });
      stopReplyProgress(params.threadId);
      removePendingReplyMessages(params.threadId);
      clearStreamingReplies();
      els.threadMeta.textContent = t("turn.completed", {
        status: formatStatusLabel(params.turn?.status || "done")
      });
      state.lastMessageAt = turnTimestamp(params.turn) || state.lastMessageAt || currentUnixSeconds();
      renderMessages(shouldStickToLiveOutput());
    }
    loadThreads();
    if (params.threadId && shouldAdvanceQueueAfterTurn(status)) {
      startNextQueuedSubmission(params.threadId).catch(() => {});
    }
    return;
  }

  if (method === "account/updated" || method === "account/login/completed") {
    Promise.all([loadAccount(), loadRateLimits()]);
    return;
  }

  if (method === "account/rateLimits/updated") {
    if (params?.rateLimits || params?.rate_limits) {
      state.rateLimits = normalizeRateLimits(params);
      state.rateLimitsError = "";
      renderRateLimits();
    } else {
      loadRateLimits();
    }
    return;
  }

  if (method === "serverRequest/resolved") {
    resolveServerRequestActivity(params?.requestId);
    removeApproval(params?.requestId);
  }
}

function trackServerRequest(request, render = true) {
  if (request?.id == null || !isWebUserApproval(request?.method)) return;
  const threadId = requestThreadId(request); if (!threadId) return;
  const key = interactionKey(request.id); if (state.pendingRequestThreads.has(key)) return;
  state.pendingRequestThreads.set(key, { id: request.id, threadId });
  setThreadActivity(threadId, { type: "waiting-started" }, render);
}
function resolveServerRequestActivity(requestId, render = true) {
  if (requestId == null) return;
  const key = interactionKey(requestId); const entry = state.pendingRequestThreads.get(key); if (!entry) return;
  state.pendingRequestThreads.delete(key); setThreadActivity(entry.threadId, { type: "waiting-resolved" }, render);
}
function reconcileRequestActivities(requests) {
  const incoming = new Map();
  for (const request of requests || []) {
    if (request?.id == null || !isWebUserApproval(request?.method)) continue;
    const threadId = requestThreadId(request);
    if (threadId) incoming.set(interactionKey(request.id), { id: request.id, threadId });
  }
  for (const [key, entry] of [...state.pendingRequestThreads]) if (!incoming.has(key)) resolveServerRequestActivity(entry.id, false);
  for (const [key, entry] of incoming) {
    if (state.pendingRequestThreads.has(key)) continue;
    state.pendingRequestThreads.set(key, entry); setThreadActivity(entry.threadId, { type: "waiting-started" }, false);
  }
  renderThreads();
}

function requestThreadId(request) {
  return String(
    request?.params?.threadId
    || request?.params?.thread_id
    || request?.params?.conversationId
    || request?.threadId
    || ""
  );
}

function notifyTurnCompletion(threadId, turnId, status) {
  if (!shouldNotifyCompletion({
    threadId,
    currentThreadId: state.currentThread?.id,
    turnId,
    status,
    seenKeys: state.notificationKeys
  })) return;

  const key = completionNotificationKey(threadId, turnId, status);
  state.notificationKeys.add(key);
  if (state.notificationKeys.size > 200) {
    state.notificationKeys.delete(state.notificationKeys.values().next().value);
  }
  const thread = state.threads.find((entry) => entry.id === threadId) || { id: threadId };
  const failed = !["completed", "complete", "done", "success", "succeeded"]
    .includes(String(status || "").toLowerCase());
  showToast({
    thread,
    kind: failed ? "failed" : "completed",
    title: thread.name || thread.preview || t("thread.untitled")
  });
}

let toastTimer = null;

function showToast({ thread, kind, title }) {
  if (!els.toastRegion) return;
  if (toastTimer) clearTimeout(toastTimer);
  els.toastRegion.innerHTML = "";
  const button = document.createElement("button");
  button.className = `toast-card ${kind}`;
  button.type = "button";
  button.innerHTML = `
    <span class="toast-icon" aria-hidden="true">${kind === "failed" ? "!" : "✓"}</span>
    <span class="toast-copy">
      <strong>${escapeHtml(t(kind === "failed" ? "notification.failed" : "notification.completed"))}</strong>
      <span>${escapeHtml(title)}</span>
    </span>
    <span class="toast-action">${escapeHtml(t("notification.open"))}</span>
  `;
  button.addEventListener("click", () => {
    els.toastRegion.innerHTML = "";
    openThread(thread);
  });
  els.toastRegion.append(button);
  toastTimer = setTimeout(() => {
    button.classList.add("leaving");
    setTimeout(() => button.remove(), 220);
  }, 6000);
}

function retryStatusId(turnId) {
  return `retry-status:${turnId || "current"}`;
}

function retryErrorText(error) {
  const value = String(error?.message || error?.additionalDetails || t("retry.unknown"))
    .replace(/\s+/g, " ")
    .trim();
  return value.length > 160 ? `${value.slice(0, 157)}...` : value;
}

function markRetryRecovered(turnId) {
  const message = state.messages.find((entry) => entry.id === retryStatusId(turnId));
  if (!message || message.kind !== "retrying") return false;
  message.kind = "retryRecovered";
  message.text = t("retry.recovered");
  return true;
}

function renderApprovals(requests) {
  for (const request of requests || []) interactionController.receive(request);
}

function removeApproval(id) { interactionController.resolve(id); }

function rpc(method, params, options = {}) {
  return new Promise((resolve, reject) => {
    const requestId = state.nextRequestId++;
    const payload = { type: "rpc", requestId, method, params };
    const data = JSON.stringify(payload);
    const startedAt = performance.now();
    state.pending.set(requestId, {
      resolve,
      reject,
      method,
      label: options.label || method,
      traffic: options.traffic || null,
      startedAt,
      bytesOut: byteLengthText(data)
    });
    logRpcDebug("send", { requestId, method, bytesOut: byteLengthText(data), params });
    state.ws.send(data);
  });
}

function sendServerResponse(id, result) {
  return new Promise((resolve, reject) => {
    if (!state.connected || state.ws?.readyState !== WebSocket.OPEN) { reject(Object.assign(new Error("Web connection is unavailable"), { code: "BRIDGE_UNAVAILABLE" })); return; }
    const requestId = state.nextRequestId++;
    const timer = window.setTimeout(() => { if (!state.pending.has(requestId)) return; state.pending.delete(requestId); reject(Object.assign(new Error("Response delivery could not be confirmed"), { code: "INTERACTION_UNCERTAIN" })); }, 15000);
    state.pending.set(requestId, { resolve, reject, timer, method: "server-response", startedAt: performance.now(), bytesOut: 0 });
    try { state.ws.send(JSON.stringify({ type: "server-response", requestId, id, result })); }
    catch (error) { window.clearTimeout(timer); state.pending.delete(requestId); reject(error); }
  });
}

function createThreadLoadStats(threadId, thread, seq) {
  return {
    threadId,
    seq,
    phase: t("load.openThread"),
    startedAt: performance.now(),
    finishedAt: null,
    totalIn: 0,
    totalOut: 0,
    steps: [],
    messageCount: 0,
    itemCount: 0,
    renderMs: 0,
    title: thread?.name || thread?.preview || t("load.currentThread")
  };
}

function updateThreadLoadPhase(stats, phase) {
  if (!stats) return;
  stats.phase = phase;
  if (shouldRenderThreadLoadOverlay(stats) && stats.seq === state.threadLoadSeq) {
    renderThreadLoading(state.currentThread, stats);
  }
}

function recordTrafficStep(pending, bytesIn, error) {
  const stats = pending.traffic;
  if (!stats) return;

  const elapsedMs = performance.now() - pending.startedAt;
  stats.totalOut += pending.bytesOut;
  stats.totalIn += bytesIn;
  stats.steps.push({
    label: pending.label,
    out: pending.bytesOut,
    in: bytesIn,
    ms: elapsedMs,
    failed: Boolean(error)
  });
  updateTrafficSummary(stats);

  if (shouldRenderThreadLoadOverlay(stats) && stats.seq === state.threadLoadSeq && state.loadingThreadId === stats.threadId) {
    renderThreadLoading(state.currentThread, stats);
  }
}

function logRpcDebug(event, detail) {
  const elapsedMs = Number(detail.elapsedMs || 0);
  const slow = event !== "send" && elapsedMs > slowRpcThresholdMs(detail.method);
  const logger = slow || event === "error" ? console.warn : console.debug;
  logger.call(console, "[codex-webui:rpc]", {
    event,
    requestId: detail.requestId,
    method: detail.method,
    elapsedMs: event === "send" ? undefined : Math.round(elapsedMs),
    bytesOut: detail.bytesOut,
    bytesIn: detail.bytesIn,
    slow,
    error: detail.error || undefined,
    params: event === "send" ? summarizeRpcPayload(detail.params) : undefined,
    result: event === "send" ? undefined : summarizeRpcPayload(detail.result)
  });
}

function slowRpcThresholdMs(method) {
  if (["turn/start", "turn/steer", "thread/read", "thread/turns/list"].includes(method)) return 5000;
  return 2000;
}

function summarizeRpcPayload(value) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return { type: "array", length: value.length };
  const summary = {};
  for (const [key, raw] of Object.entries(value)) {
    if (/token/i.test(key)) {
      summary[key] = "[redacted]";
    } else if (key === "input" && Array.isArray(raw)) {
      summary[key] = raw.map((item) => summarizeInputItem(item));
    } else if (key === "data" && Array.isArray(raw)) {
      summary[key] = { type: "array", length: raw.length };
    } else if (key === "thread" && raw && typeof raw === "object") {
      summary[key] = summarizeThread(raw);
    } else if (typeof raw === "string") {
      summary[key] = raw.length > 160 ? `${raw.slice(0, 160)}...(${raw.length})` : raw;
    } else if (Array.isArray(raw)) {
      summary[key] = { type: "array", length: raw.length };
    } else if (raw && typeof raw === "object") {
      summary[key] = Object.fromEntries(Object.entries(raw).slice(0, 8));
    } else {
      summary[key] = raw;
    }
  }
  return summary;
}

function summarizeInputItem(item) {
  if (!item || typeof item !== "object") return item;
  if (item.type === "text") {
    const text = String(item.text || "");
    return { type: "text", chars: text.length, preview: text.slice(0, 80) };
  }
  if (item.type === "localImage") return { type: "localImage", path: shortPath(item.path) };
  return { type: item.type || "unknown" };
}

function summarizeThread(thread) {
  return {
    id: thread.id,
    cwd: thread.cwd,
    name: thread.name,
    status: formatStatus(thread.status)
  };
}

function logTurnDebug(event, threadId, extra = {}) {
  const diagnostics = state.turnDiagnostics.get(threadId);
  if (!diagnostics) {
    console.debug("[codex-webui:turn]", { event, threadId, ...extra });
    return;
  }

  const now = performance.now();
  const elapsedMs = Math.round(now - diagnostics.startedAt);
  const firstDeltaMs = diagnostics.firstDeltaAt
    ? Math.round(diagnostics.firstDeltaAt - diagnostics.startedAt)
    : null;
  const turnStartedMs = diagnostics.turnStartedAt
    ? Math.round(diagnostics.turnStartedAt - diagnostics.startedAt)
    : null;
  const turnStartRpcDoneMs = diagnostics.turnStartRpcDoneAt
    ? Math.round(diagnostics.turnStartRpcDoneAt - diagnostics.startedAt)
    : null;

  const payload = {
    event,
    id: diagnostics.id,
    threadId,
    elapsedMs,
    turnStartedMs,
    turnStartRpcDoneMs,
    firstDeltaMs,
    textChars: diagnostics.textChars,
    imageCount: diagnostics.imageCount,
    ...extra
  };
  const logger = elapsedMs > 10000 && event !== "send-begin" ? console.warn : console.info;
  logger.call(console, "[codex-webui:turn]", payload);

  if (event === "turn-completed") {
    state.turnDiagnostics.delete(threadId);
  }
}

function settleRequest(requestId, error, result, bytesIn = 0) {
  const pending = state.pending.get(requestId);
  if (!pending) return;
  state.pending.delete(requestId);
  if (pending.timer) window.clearTimeout(pending.timer);
  recordTrafficStep(pending, bytesIn, error);
  logRpcDebug(error ? "error" : "result", {
    requestId,
    method: pending.method,
    elapsedMs: performance.now() - pending.startedAt,
    bytesOut: pending.bytesOut,
    bytesIn,
    error: error?.message || "",
    result
  });
  if (error) pending.reject(error);
  else pending.resolve(result);
}

function rejectPendingRequests(error) {
  for (const [requestId, pending] of state.pending.entries()) {
    state.pending.delete(requestId);
    if (pending.timer) window.clearTimeout(pending.timer);
    recordTrafficStep(pending, 0, error);
    pending.reject(error);
  }
}

function addMessage(message, scroll = true) {
  state.messages.push(message);
  renderMessages(scroll);
}

function replaceOrAppendMessage(message) {
  const index = state.messages.findIndex((entry) => entry.id && entry.id === message.id);
  if (index >= 0) {
    state.messages[index] = mergeMessageClassification(state.messages[index], message);
    return;
  }
  const aliasIndex = findTransientMessageAliasIndex(state.messages, message);
  if (aliasIndex >= 0) {
    state.messages[aliasIndex] = mergeMessageClassification(state.messages[aliasIndex], message);
    return;
  }
  state.messages.push(message);
}

function addPendingReplyMessage(threadId, scroll = true) {
  if (!threadId) return;
  startReplyProgress(threadId);
  if (state.messages.some((message) => message.pendingReply && message.threadId === threadId)) return;
  addMessage({
    role: "assistant",
    id: `pending-reply-${threadId}-${Date.now()}`,
    threadId,
    text: "",
    pendingReply: true
  }, scroll);
}

function ensureReplyProgressIndicator(threadId, scroll = true) {
  if (!threadId) return;
  startReplyProgress(threadId);
  const hasStreamingReply = state.messages.some((message) =>
    message.role === "assistant" && message.streamingReply
  );
  if (hasStreamingReply) return;
  addPendingReplyMessage(threadId, scroll);
}

function startReplyProgress(threadId) {
  if (threadId) state.replyProgressThreadIds.add(threadId);
  updateSendMode();
  if (threadId === state.currentThread?.id) scheduleCurrentThreadSync(0);
}


function stopReplyProgress(threadId) {
  if (threadId) state.replyProgressThreadIds.delete(threadId);
  updateSendMode();
  if (threadId === state.currentThread?.id) scheduleCurrentThreadSync(0);
}

function takePendingReplyMessage(threadId, id) {
  const index = state.messages.findIndex((message) =>
    message.pendingReply && (!threadId || message.threadId === threadId)
  );
  if (index < 0) return null;
  const [message] = state.messages.splice(index, 1);
  return {
    ...message,
    id,
    text: "",
    pendingReply: false
  };
}

function removePendingReplyMessages(threadId) {
  state.messages = state.messages.filter((message) =>
    !message.pendingReply || (threadId && message.threadId !== threadId)
  );
}

function clearStreamingReply(id) {
  if (!id) return;
  const message = state.messages.find((entry) => entry.id === id);
  if (message) message.streamingReply = false;
}

function clearStreamingReplies() {
  for (const message of state.messages) {
    message.streamingReply = false;
  }
}

function clearMatchingPendingUserMessage(text, images = []) {
  const normalizedText = normalizeMessageText(text);
  const normalizedImages = normalizeMessageImages(images);
  const index = state.messages.findIndex((message) =>
    message.pendingLocal
    && message.role === "user"
    && normalizeMessageText(message.text) === normalizedText
    && normalizeMessageImages(message.images || []) === normalizedImages
  );
  if (index >= 0) {
    state.messages.splice(index, 1);
  }
}

function normalizeMessageText(text) {
  return String(text || "").trim();
}

function normalizeMessageImages(images) {
  return (images || [])
    .map((image) => typeof image === "string" ? image : image?.source || image?.id || "")
    .filter(Boolean)
    .join("\n");
}

function addSystemMessage(text, scroll = true) {
  addMessage({ role: "system", text }, scroll);
}

function isMessagesNearBottom(threshold = 96) {
  if (!els.messages) return true;
  const remaining = els.messages.scrollHeight - els.messages.scrollTop - els.messages.clientHeight;
  return remaining <= threshold;
}

function shouldStickToLiveOutput() {
  return state.followLiveOutput && isMessagesNearBottom();
}

function scrollMessagesToBottom() {
  if (!els.messages) return;
  els.messages.scrollTop = els.messages.scrollHeight;
  requestAnimationFrame(() => {
    els.messages.scrollTop = els.messages.scrollHeight;
  });
}

function renderMessages(scroll = true) {
  invalidateWorkflow();
  if (!state.messages.length) {
    updateTrafficSummary();
    renderEmpty(t("empty.newTitle"), t("empty.newDescription"));
    return;
  }

  const preservedTop = els.messages.scrollTop;
  const activeField=document.activeElement?.dataset?.asyncField;
  const selection=activeField?[document.activeElement.selectionStart,document.activeElement.selectionEnd]:null;
  els.messages.innerHTML = "";
  const historyLoader = renderHistoryLoader();
  if (historyLoader) {
    els.messages.append(historyLoader);
  }
  const stream = document.createElement("div");
  stream.className = "message-stream";
  for (const entry of groupTimeline(state.messages,state.compactActivity)) {
    if (entry.type === "activity") {
      stream.append(renderActivityGroup(entry.messages));
    } else {
      stream.append(renderMessage(entry.message));
    }
  }
  const progressFooter = renderReplyProgressFooter();
  if (progressFooter) stream.append(progressFooter);
  els.messages.append(stream);
  const lastMessageTime = renderLastMessageTime();
  if (lastMessageTime) {
    els.messages.append(lastMessageTime);
  }
  if (scroll) {
    scrollMessagesToBottom();
  } else {
    els.messages.scrollTop = preservedTop;
  }
  updateTrafficSummary();
  conversationTools?.update();
  if(activeField){const field=document.getElementById(activeField);if(field&&!field.disabled){field.focus({preventScroll:true});field.setSelectionRange(...selection);}}
}

const asyncQuestionCards=createAsyncQuestionCards({t,getScope:()=>({threadId:state.currentThread?.id,connected:state.connected&&state.desktopBridgeConnected&&!state.desktopBridgeReconnecting,ready:!isSendBlocked()}),send:answer=>sendQuestionAnswer({state,rpc,onStateChange:()=>{els.sendButton.disabled=isSendBlocked();asyncQuestionCards.refresh();},onSynced:threadId=>{if(state.currentThread?.id===threadId)scheduleCurrentThreadSync(0);}},answer)});

function renderActivityGroup(messages){
  const item=document.createElement("article");item.className="message activity-group";
  const details=document.createElement("details"),summary=document.createElement("summary");
  const heading=document.createElement("span");heading.textContent=t("activity.summary",{count:messages.length});
  const preview=document.createElement("small");preview.textContent=messages.findLast(m=>m.role==="assistant"&&m.phase==="commentary")?.text?.replace(/\s+/g," ").slice(0,140)||t("activity.hint");
  summary.append(heading,preview);details.append(summary);
  const body=document.createElement("div");body.className="activity-body";
  let rendered=false;
  const populate=()=>{if(rendered||!details.open)return;rendered=true;for(const message of messages)body.append(message.role==="tool"?renderToolGroup([message]):renderMessage(message));};
  details.append(body);item.append(details);bindDisclosureState(details,disclosureKey("activity",messages[0],messages[0]?.turnId));populate();details.addEventListener("toggle",populate);return item;
}

function renderLastMessageTime() {
  if (!state.lastMessageAt) return null;
  const node = document.createElement("div");
  node.className = "last-message-time";
  node.textContent = t("lastMessage", { time: formatDateTime(state.lastMessageAt) });
  return node;
}

function renderReplyProgressFooter() {
  if (!state.currentThread?.id || !state.replyProgressThreadIds.has(state.currentThread.id)) return null;
  const item = document.createElement("article");
  item.className = "message assistant reply-progress-footer";
  item.innerHTML = `
    <div class="message-label">${labelFor("assistant")}</div>
    <div class="bubble markdown"><span class="reply-dots" aria-label="${escapeHtml(t("turn.replying"))}"></span></div>
  `;
  return item;
}

function renderMessage(message) {
  if(message.questions)return asyncQuestionCards.render(message,state.messages);
  if(message.questionReplies)return asyncQuestionCards.renderReply(message);
  if (message.kind === "reasoning") return renderReasoningMessage(message);
  if (message.kind === "automationHeartbeat") return renderAutomationHeartbeat(message);
  const item = document.createElement("article");
  const hasImages = Boolean(message.images?.length);
  const generationClass = message.imageGeneration?.pending ? " image-generation-pending" : "";
  const pendingClass = message.pendingReply ? " pending-reply" : "";
  const streamingClass = message.streamingReply ? " streaming-reply" : "";
  item.className = `message ${message.role}${hasImages ? " has-images" : ""}${generationClass}${pendingClass}${streamingClass}`;
  if (message.id) item.dataset.messageId = String(message.id);
  const bubbleClass = message.role === "tool" ? "bubble plain" : "bubble markdown";
  const hasText = Boolean(String(message.text || "").trim());
  const body = message.role === "tool"
    ? escapeHtml(message.text || "")
    : renderMarkdown(message.text || "");
  const generation = renderImageGenerationStatus(message.imageGeneration);
  const images = renderMessageImages(message.images || []);
  const bubble = hasText ? `<div class="${bubbleClass}">${body}</div>` : "";
  item.innerHTML = `
    <div class="message-label">${labelFor(message.role)}</div>
    ${generation}
    ${images}
    ${bubble}
  `;
  bindImagePlaceholders(item);
  bindMarkdownImages(item);
  conversationTools?.decorateMessage(item, message);
  return item;
}

function patchStreamingMessage(message, scroll) {
  if (!message?.id || message.role !== "assistant" || message.kind) return false;
  const item = Array.from(els.messages.querySelectorAll("[data-message-id]"))
    .find((node) => node.dataset.messageId === String(message.id));
  const bubble = item?.querySelector(".bubble.markdown");
  if (!item || !bubble) return false;

  invalidateWorkflow();
  bubble.innerHTML = renderMarkdown(message.text || "");
  item.classList.toggle("streaming-reply", Boolean(message.streamingReply));
  bindImagePlaceholders(item);
  bindMarkdownImages(item);
  conversationTools?.decorateMessage(item, message);
  conversationTools?.update();
  if (scroll) scrollMessagesToBottom();
  return true;
}

function renderAutomationHeartbeat(message) {
  const heartbeat = message.automationHeartbeat || parseAutomationHeartbeat(message.text);
  if (!heartbeat) return renderMessage({ ...message, kind: undefined });

  const item = document.createElement("article");
  item.className = "message system automation-heartbeat-message";
  const time = formatAutomationTime(heartbeat.currentTimeIso);
  const fullTime = formatAutomationDateTime(heartbeat.currentTimeIso);
  const instructions = heartbeat.instructions
    ? `<pre>${escapeHtml(heartbeat.instructions)}</pre>`
    : `<p>${escapeHtml(t("automation.noInstructions"))}</p>`;
  item.innerHTML = `
    <details>
      <summary>
        <span class="automation-heartbeat-pulse" aria-hidden="true"></span>
        <span class="automation-heartbeat-heading">
          <strong>${escapeHtml(t("automation.heartbeat"))}</strong>
          ${heartbeat.automationId ? `<small>${escapeHtml(heartbeat.automationId)}</small>` : ""}
        </span>
        ${time ? `<time datetime="${escapeHtml(heartbeat.currentTimeIso)}" title="${escapeHtml(fullTime)}">${escapeHtml(time)}</time>` : ""}
        <span class="automation-heartbeat-chevron" aria-hidden="true">›</span>
      </summary>
      <div class="automation-heartbeat-body">${instructions}</div>
    </details>
  `;
  bindDisclosureState(
    item.querySelector("details"),
    disclosureKey("automation", message, heartbeat.automationId || heartbeat.currentTimeIso)
  );
  return item;
}

function renderReasoningMessage(message) {
  const item = document.createElement("article");
  item.className = "message system reasoning-message";
  const parts = message.reasoningParts?.length ? message.reasoningParts : [message.text || ""].filter(Boolean);
  const countText = t("reasoning.count", { count: parts.length });
  const title = t("reasoning.process");
  const renderedParts = parts.map((part) => `<li>${renderMarkdown(part)}</li>`).join("");
  item.innerHTML = `
    <details>
      <summary title="${escapeHtml(t("reasoning.explainer"))}">
        <span class="reasoning-chevron" aria-hidden="true">›</span>
        <span class="reasoning-summary-title">${escapeHtml(title)}</span>
        <span class="reasoning-summary-count">${escapeHtml(countText)}</span>
      </summary>
      <div class="bubble markdown reasoning-body">
        <p class="reasoning-explainer">${escapeHtml(t("reasoning.explainer"))}</p>
        <ol class="reasoning-parts">${renderedParts}</ol>
      </div>
    </details>
  `;
  bindDisclosureState(item.querySelector("details"), disclosureKey("reasoning", message, title));
  bindImagePlaceholders(item);
  bindMarkdownImages(item);
  return item;
}

function renderImageGenerationStatus(state) {
  if (!state || (!state.pending && !state.failed)) return "";
  if (state.failed) {
    const detail = state.detail ? `<small>${escapeHtml(state.detail)}</small>` : "";
    return `
      <div class="image-generation-status failed" role="status">
        <span class="image-generation-mark" aria-hidden="true">!</span>
        <div>
          <strong>${escapeHtml(t("image.generationFailed"))}</strong>
          ${detail}
        </div>
      </div>
    `;
  }
  return `
    <div class="image-generation-status" role="status" aria-live="polite">
      <span class="mini-spinner" aria-hidden="true"></span>
      <div>
        <strong>${escapeHtml(t("image.generating"))}</strong>
        <small>${escapeHtml(t("image.generationDescription"))}</small>
      </div>
    </div>
  `;
}

function renderToolGroup(messages) {
  const item = document.createElement("article");
  item.className = "message tool compact-tool-group";
  const title = toolGroupTitle(messages);
  const details = messages.map((message, index) => {
    const text = String(message.text || "").trim();
    return `<pre>${escapeHtml(`${index + 1}. ${text}`)}</pre>`;
  }).join("");
  item.innerHTML = `
    <details>
      <summary>
        <span class="tool-summary-icon">▣</span>
        <span>${escapeHtml(title)}</span>
      </summary>
      <div class="tool-group-details">${details}</div>
    </details>
  `;
  bindDisclosureState(
    item.querySelector("details"),
    disclosureKey("tools", messages[0], messages[0]?.kind || title)
  );
  return item;
}

function disclosureKey(prefix, message, fallback = "") {
  return disclosureIdentity({
    threadId: state.currentThread?.id,
    prefix,
    messageId: message?.id,
    fallback: fallback || String(message?.text || "").slice(0, 80)
  });
}

function bindDisclosureState(details, key) {
  if (!details || !key) return;
  details.open = state.openDisclosures.has(key);
  details.addEventListener("toggle", () => {
    state.openDisclosures = updateDisclosureState(state.openDisclosures, key, details.open);
  });
}

function toolGroupTitle(messages) {
  const count = messages.length;
  const texts = messages.map((message) => String(message.text || "").trim());
  if (count === 1 && messages[0].kind === "retrying") return t("retry.retryingTitle");
  if (count === 1 && messages[0].kind === "retryRecovered") return t("retry.recovered");
  if (count === 1 && messages[0].kind === "retryFailed") return t("retry.failedTitle");
  if (count === 1 && [t("tool.compacting"), t("tool.compacted")].includes(texts[0])) return texts[0];
  if (texts.every((text) => text.startsWith("$ "))) return t("tool.commands", { count });
  if (texts.every((text) => text.includes("文件改动") || text.toLowerCase().includes("file"))) {
    return t("tool.fileChanges", { count });
  }
  return t("tool.records", { count });
}

function renderHistoryLoader() {
  if (!state.currentThread || (!state.hasOlderTurns && !state.loadingOlderTurns)) return null;

  const wrap = document.createElement("div");
  wrap.className = "history-loader";
  if (state.loadingOlderTurns) {
    wrap.innerHTML = `<span class="mini-spinner" aria-hidden="true"></span><span>${escapeHtml(t("load.loadingOlder"))}</span>`;
    return wrap;
  }

  const button = document.createElement("button");
  button.type = "button";
  button.textContent = t("load.older");
  button.addEventListener("click", loadOlderTurns);
  wrap.append(button);
  return wrap;
}

function renderEmpty(title, text) {
  els.messages.innerHTML = `
    <div class="empty-state">
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(text)}</p>
    </div>
  `;
  refreshWorkflow();
}

function renderThreadLoading(thread, stats = null) {
  updateTrafficSummary(stats);
  const title = thread?.name || thread?.preview || t("load.currentThread");
  const lines = stats ? renderTrafficLines(stats) : [];
  els.messages.innerHTML = `
    <div class="loading-state" aria-live="polite">
      <div class="loading-spinner" aria-hidden="true"></div>
      <div>
        <h1>${escapeHtml(stats?.phase ? t("load.phase", { phase: stats.phase }) : t("load.opening"))}</h1>
        <p>${escapeHtml(title)}</p>
        ${lines.length ? `<div class="loading-traffic">${lines.join("")}</div>` : ""}
      </div>
    </div>
  `;
}

function updateTrafficSummary(activeStats = null) {
  if (!els.trafficSummary) return;
  const stats = activeStats || state.threadLoadStats || state.lastLoadStats;
  if (!stats || stats.threadId !== state.currentThread?.id) {
    els.trafficSummary.classList.add("hidden");
    els.trafficSummary.innerHTML = "";
    return;
  }

  const elapsed = (stats.finishedAt || performance.now()) - stats.startedAt;
  els.trafficSummary.classList.remove("hidden");
  els.trafficSummary.innerHTML = `
    <strong>${escapeHtml(t("traffic.title"))}</strong>
    <span>↓ ${formatBytes(stats.totalIn)}</span>
    <span>↑ ${formatBytes(stats.totalOut)}</span>
    <span>${formatDuration(elapsed)}</span>
    ${stats.messageCount ? `<span>${escapeHtml(t("traffic.count", { count: stats.messageCount }))}</span>` : ""}
  `;
}

function renderTrafficLines(stats) {
  const elapsed = (stats.finishedAt || performance.now()) - stats.startedAt;
  const lines = [
    `<span>${escapeHtml(t("traffic.total", {
      down: formatBytes(stats.totalIn),
      up: formatBytes(stats.totalOut),
      duration: formatDuration(elapsed)
    }))}</span>`
  ];

  for (const step of stats.steps) {
    const status = t(step.failed ? "common.failed" : "common.completed");
    lines.push(
      `<span>${escapeHtml(t("traffic.step", {
        label: step.label,
        status,
        down: formatBytes(step.in),
        up: formatBytes(step.out),
        duration: formatDuration(step.ms)
      }))}</span>`
    );
  }

  if (stats.messageCount) {
    lines.push(`<span>${escapeHtml(t("traffic.messages", {
      messages: stats.messageCount,
      items: stats.itemCount
    }))}</span>`);
  }

  return lines;
}

function renderMessageImages(images) {
  if (!images.length) return "";
  return `
    <div class="message-images">
      ${images.map((image, index) => {
        const src = image.kind === "inline"
          ? authenticatedUrl(`/api/inline-image?id=${encodeURIComponent(image.id)}`, state.token)
          : safeUrl(image.source, "image");
        if (!src) return "";
        const label = image.kind === "inline" && image.bytes
          ? `${t("image.defaultName")} · ${formatBytes(image.bytes)}`
          : t("image.defaultName");
        return `
          <button class="image-placeholder image-preview-placeholder" type="button" data-image-src="${escapeHtml(src)}" data-image-index="${index}" title="${escapeHtml(t("image.fullscreen"))}">
            <img class="message-image-preview" src="${escapeHtml(src)}" alt="" loading="lazy" decoding="async" fetchpriority="low" referrerpolicy="no-referrer">
            <span class="image-preview-caption">
              <strong>${escapeHtml(label)}</strong>
              <small>${escapeHtml(t("image.fullscreen"))}</small>
            </span>
          </button>
        `;
      }).join("")}
    </div>
  `;
}

function bindImagePlaceholders(root) {
  for (const placeholder of root.querySelectorAll(".image-placeholder")) {
    const preview = placeholder.querySelector(".message-image-preview");
    if (preview) {
      const src = placeholder.dataset.imageSrc;
      preview.addEventListener("load", () => placeholder.classList.add("preview-ready"));
      preview.addEventListener("error", () => placeholder.classList.add("preview-failed"));
      if (preview.complete && preview.naturalWidth > 0) placeholder.classList.add("preview-ready");
      placeholder.addEventListener("click", () => {
        if (src) openImageViewer(preview.currentSrc || preview.src || src);
      });
      continue;
    }
    const loadImage = () => {
      const src = placeholder.dataset.imageSrc;
      if (!src || placeholder.classList.contains("loading")) return;
      const shouldStickToBottom = shouldStickToLiveOutput();
      placeholder.classList.add("loading");
      const loadingText = placeholder.querySelector("small");
      if (loadingText) loadingText.textContent = t("image.loading");
      const viewerButton = document.createElement("button");
      viewerButton.className = "loaded-message-image-button";
      viewerButton.type = "button";
      viewerButton.title = t("image.fullscreen");
      const img = document.createElement("img");
      img.loading = "eager";
      img.fetchPriority = "high";
      img.decoding = "async";
      img.referrerPolicy = "no-referrer";
      img.alt = "";
      img.className = "loaded-message-image";
      const startedAt = performance.now();
      let attempt = 1;
      logImageDebug("start", { src, attempt });
      const imageLoadTimer = window.setTimeout(() => {
        if (!placeholder.isConnected) return;
        logImageDebug("timeout", {
          src: img.currentSrc || img.src || src,
          attempt,
          elapsedMs: Math.round(performance.now() - startedAt),
          complete: img.complete,
          naturalWidth: img.naturalWidth,
          naturalHeight: img.naturalHeight
        });
        placeholder.replaceWith(renderImageLoadError(src));
        if (shouldStickToBottom) scrollMessagesToBottom();
      }, 90000);
      let retried = false;
      img.addEventListener("load", () => {
        window.clearTimeout(imageLoadTimer);
        logImageDebug("loaded", {
          src: img.currentSrc || img.src || src,
          attempt,
          elapsedMs: Math.round(performance.now() - startedAt),
          naturalWidth: img.naturalWidth,
          naturalHeight: img.naturalHeight,
          complete: img.complete
        });
        placeholder.replaceWith(viewerButton);
        if (shouldStickToBottom) scrollMessagesToBottom();
      });
      img.addEventListener("error", () => {
        logImageDebug("error", {
          src: img.currentSrc || img.src || src,
          attempt,
          elapsedMs: Math.round(performance.now() - startedAt),
          complete: img.complete,
          naturalWidth: img.naturalWidth,
          naturalHeight: img.naturalHeight
        });
        if (!retried) {
          retried = true;
          attempt += 1;
          const retrySrc = cacheBustedImageUrl(src);
          logImageDebug("retry", { src: retrySrc, attempt });
          img.src = retrySrc;
          return;
        }
        window.clearTimeout(imageLoadTimer);
        placeholder.replaceWith(renderImageLoadError(src));
        if (shouldStickToBottom) scrollMessagesToBottom();
      });
      viewerButton.append(img);
      viewerButton.addEventListener("click", () => openImageViewer(img.currentSrc || img.src || src));
      img.src = src;
    };
    placeholder.addEventListener("click", loadImage);
    placeholder.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      loadImage();
    });
  }
}

function cacheBustedImageUrl(src) {
  try {
    const url = new URL(src, window.location.href);
    url.searchParams.set("_retry", Date.now().toString(36));
    return url.toString();
  } catch {
    const separator = src.includes("?") ? "&" : "?";
    return `${src}${separator}_retry=${Date.now().toString(36)}`;
  }
}

function logImageDebug(event, detail = {}) {
  const payload = {
    event,
    id: imageIdFromUrl(detail.src),
    src: redactImageUrl(detail.src),
    attempt: detail.attempt,
    elapsedMs: detail.elapsedMs,
    complete: detail.complete,
    naturalWidth: detail.naturalWidth,
    naturalHeight: detail.naturalHeight,
    online: navigator.onLine,
    page: window.location.href
  };
  if (event === "error" || event === "timeout") {
    console.warn("[CodexWebUI image]", payload);
  } else {
    console.info("[CodexWebUI image]", payload);
  }
}

function imageIdFromUrl(src) {
  try {
    return new URL(src, window.location.href).searchParams.get("id") || "";
  } catch {
    return "";
  }
}

function redactImageUrl(src) {
  try {
    const url = new URL(src, window.location.href);
    if (url.searchParams.has("token")) url.searchParams.set("token", "[redacted]");
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return String(src || "").replace(/token=([^&]+)/, "token=[redacted]");
  }
}

function bindMarkdownImages(root) {
  for (const img of root.querySelectorAll(".bubble.markdown img")) {
    const shouldStickToBottom = shouldStickToLiveOutput();
    img.classList.add("loaded-message-image");
    img.title = t("image.fullscreen");
    img.addEventListener("click", () => openImageViewer(img.currentSrc || img.src));
    img.addEventListener("load", () => {
      if (shouldStickToBottom) scrollMessagesToBottom();
    }, { once: true });
  }
}

function renderImageLoadError(src) {
  const error = document.createElement("div");
  error.className = "image-load-error";
  error.innerHTML = `
    <strong>${escapeHtml(t("image.loadFailed"))}</strong>
    <small>${escapeHtml(imageErrorLabel(src))}</small>
  `;
  return error;
}

function imageErrorLabel(src) {
  try {
    const url = new URL(src, window.location.href);
    return url.searchParams.get("path") || redactImageUrl(src);
  } catch {
    return redactImageUrl(src);
  }
}

function openImageViewer(src) {
  if (!els.imageViewer || !els.imageViewerImg || !src) return;
  els.imageViewerImg.src = src;
  els.imageViewer.classList.remove("hidden");
  document.body.classList.add("viewer-open");
}

function closeImageViewer() {
  if (!els.imageViewer || els.imageViewer.classList.contains("hidden")) return false;
  els.imageViewer.classList.add("hidden");
  document.body.classList.remove("viewer-open");
  if (els.imageViewerImg) els.imageViewerImg.src = "";
  return true;
}

function updateThreadHeader() {
  const thread = state.currentThread;
  interactionController.setContext(thread?.id);
  workspacePanel?.setContext({ threadId: thread?.id, cwdHint: thread?.cwd });
  els.threadTitle.value = thread?.name || thread?.preview || t("thread.untitled");
  els.threadTitle.disabled = !thread;
  els.threadTitle.title = t(thread?.id || thread?.draft ? "thread.editTitle" : "thread.notSelected");
  const metaPath = thread?.cwd ? shortPath(thread.cwd) : t("empty.noProject");
  els.threadMeta.textContent = thread ? `${metaPath} · ${formatStatusLabel(thread.status)}` : t("common.ready");
  updateResumeStatus(thread);
  updateSendMode();
  updateProjectSelectState();
  scrollThreadTitleToEnd();
  refreshWorkflow();
}

function updateSendMode() {
  if (!els.sendButton) return;
  const waitingForContent = Boolean(
    state.sendingThreadId
    && state.threadContentGate?.threadId === state.currentThread?.id
    && !state.threadContentGate.gate.ready
  );
  if (waitingForContent) {
    setFollowUpMenuOpen(false);
    els.sendButton.textContent = t("composer.waiting");
    els.sendButton.setAttribute("aria-label", t("composer.waiting"));
    els.sendButton.title = "";
    return;
  }
  const threadId = state.currentThread?.id;
  const steering = Boolean(threadId && state.activeTurns.has(threadId));
  if (!steering) {
    state.interruptingTurnId = null;
    setFollowUpMenuOpen(false);
  }
  const interrupting = Boolean(state.interruptingTurnId);
  const label = t(interrupting ? "composer.stopping" : steering ? "composer.chooseFollowUp" : "composer.send");
  els.sendButton.textContent = label;
  els.sendButton.setAttribute("aria-label", label);
  els.sendButton.title = steering && !interrupting ? t("composer.chooseFollowUpTitle") : "";
  els.sendButton.setAttribute("aria-haspopup", steering ? "menu" : "false");
  if (!steering) els.sendButton.setAttribute("aria-expanded", "false");
  els.sendButton.disabled = isSendBlocked();
  updateFollowUpOptions();
}

function setFollowUpMenuOpen(open) {
  if (!els.followUpMenu || !els.sendButton) return;
  const threadId = state.currentThread?.id;
  const canChoose = Boolean(threadId && state.activeTurns.has(threadId));
  const visible = Boolean(open && canChoose);
  els.followUpMenu.classList.toggle("hidden", !visible);
  els.sendButton.setAttribute("aria-expanded", String(visible));
  updateFollowUpOptions();
}

function updateFollowUpOptions() {
  if (!els.followUpMenu) return;
  const hasPrompt = Boolean(els.promptInput.value.trim() || state.pendingImages.length);
  for (const option of els.followUpMenu.querySelectorAll("[data-follow-up-mode]")) {
    const needsPrompt = option.dataset.followUpMode !== "stop";
    option.disabled = Boolean(state.interruptingTurnId) || (needsPrompt && !hasPrompt);
  }
}

async function interruptActiveTurn() {
  const threadId = state.currentThread?.id;
  const activeTurnId = threadId ? state.activeTurns.get(threadId) : null;
  if (!threadId || !activeTurnId || state.interruptingTurnId) return;
  const request = buildInterruptRequest({ threadId, activeTurnId });
  state.interruptingTurnId = activeTurnId;
  updateSendMode();
  try {
    await rpc(request.method, request.params);
    scheduleCurrentThreadSync(0);
  } catch (error) {
    if (state.interruptingTurnId === activeTurnId) state.interruptingTurnId = null;
    addSystemMessage(error.message || t("error.interrupt"));
    updateSendMode();
  }
}

async function startNextQueuedSubmission(threadId) {
  if (!threadId || state.activeTurns.has(threadId) || state.queueStartingThreadIds.has(threadId)) return false;
  state.queueStartingThreadIds.add(threadId);
  try {
    const page = await rpc("thread/queue/list", { threadId, limit: 1 });
    const next = page?.data?.[0];
    if (!next || state.activeTurns.has(threadId)) return false;
    await rpc("thread/queue/start", { threadId, queuedSubmissionId: next.id });
    return true;
  } finally {
    state.queueStartingThreadIds.delete(threadId);
  }
}

function isSendBlocked() {
  return state.initialThreadRestorePending || Boolean(state.sendingThreadId) || Boolean(state.interruptingTurnId);
}

async function commitThreadTitle() {
  if (threadTitleSaving || !state.currentThread || !els.threadTitle) return;
  const previous = threadTitleBeforeEdit || state.currentThread.name || state.currentThread.preview || "";
  const name = els.threadTitle.value.trim();

  if (!name) {
    els.threadTitle.value = previous || state.currentThread.name || state.currentThread.preview || t("thread.untitled");
    return;
  }
  if (name === previous || name === state.currentThread.name) return;

  if (state.currentThread.draft || !state.currentThread.id) {
    state.currentThread.name = name;
    state.currentThread.preview = name;
    updateThreadHeader();
    renderThreads();
    return;
  }

  threadTitleSaving = true;
  const threadId = state.currentThread.id;
  const oldName = state.currentThread.name;
  const oldPreview = state.currentThread.preview;
  state.currentThread.name = name;
  state.currentThread.preview = name;
  updateThreadHeader();
  renderThreads();

  try {
    await rpc("thread/name/set", { threadId, name });
    await loadThreads();
    const updated = state.threads.find((thread) => thread.id === threadId);
    if (updated && state.currentThread?.id === threadId) {
      state.currentThread = { ...state.currentThread, ...updated };
      const term = els.searchThreads.value.trim().toLowerCase();
      if (term && !threadMatchesSearch(state.currentThread, term)) {
        els.searchThreads.value = "";
        renderThreads();
      }
      threadTitleBeforeEdit = state.currentThread.name || name;
      updateThreadHeader();
    }
  } catch (error) {
    if (state.currentThread?.id === threadId) {
      state.currentThread.name = oldName;
      state.currentThread.preview = oldPreview;
      threadTitleBeforeEdit = oldName || oldPreview || "";
      updateThreadHeader();
    }
    addSystemMessage(error.message || t("thread.titleError"));
  } finally {
    threadTitleSaving = false;
  }
}

function cancelThreadTitleEdit() {
  if (!els.threadTitle) return;
  els.threadTitle.value = threadTitleBeforeEdit || state.currentThread?.name || state.currentThread?.preview || t("thread.untitled");
}

function scrollThreadTitleToEnd() {
  stopThreadTitleMarquee(false);
  if (!els.threadTitle || document.activeElement === els.threadTitle) return;
  requestAnimationFrame(() => {
    const maxScroll = els.threadTitle.scrollWidth - els.threadTitle.clientWidth;
    if (maxScroll <= 1) {
      els.threadTitle.scrollLeft = 0;
      return;
    }
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      els.threadTitle.scrollLeft = maxScroll;
      return;
    }
    runThreadTitleMarquee(maxScroll);
  });
}

function runThreadTitleMarquee(maxScroll) {
  if (!els.threadTitle || document.activeElement === els.threadTitle) return;
  const startDelay = 450;
  const endDelay = 650;
  const duration = Math.max(1400, (maxScroll / 125) * 1000);

  const cycle = () => {
    if (!els.threadTitle || document.activeElement === els.threadTitle) return;
    els.threadTitle.scrollLeft = 0;
    threadTitleScrollTimer = window.setTimeout(() => {
      const startedAt = performance.now();
      const step = (now) => {
        if (!els.threadTitle || document.activeElement === els.threadTitle) {
          stopThreadTitleMarquee(true);
          return;
        }
        const progress = Math.min(1, (now - startedAt) / duration);
        els.threadTitle.scrollLeft = maxScroll * easeInOut(progress);
        if (progress < 1) {
          threadTitleScrollFrame = requestAnimationFrame(step);
          return;
        }
        threadTitleScrollTimer = window.setTimeout(cycle, endDelay);
      };
      threadTitleScrollFrame = requestAnimationFrame(step);
    }, startDelay);
  };

  cycle();
}

function stopThreadTitleMarquee(resetScroll) {
  if (threadTitleScrollFrame) {
    cancelAnimationFrame(threadTitleScrollFrame);
    threadTitleScrollFrame = null;
  }
  if (threadTitleScrollTimer) {
    clearTimeout(threadTitleScrollTimer);
    threadTitleScrollTimer = null;
  }
  if (resetScroll && els.threadTitle) {
    els.threadTitle.scrollLeft = 0;
  }
}

function easeInOut(value) {
  return value < 0.5 ? 2 * value * value : 1 - Math.pow(-2 * value + 2, 2) / 2;
}

function updateProjectSelectState() {
  const choosingWorkspace = Boolean(state.currentThread?.draft || !state.currentThread?.id);
  els.projectSelect.disabled = !choosingWorkspace;
  els.workspaceSettingControls?.classList.toggle("hidden", !choosingWorkspace);
  els.currentConversationSummary?.classList.toggle("hidden", choosingWorkspace);
  if (els.contextSettingLabel) {
    els.contextSettingLabel.textContent = t(choosingWorkspace ? "settings.workspace" : "settings.currentConversation");
  }
  if (!choosingWorkspace && els.currentConversationSummary) {
    const thread = state.currentThread;
    const name = thread?.name || thread?.preview || t("thread.untitled");
    const context = thread?.cwd ? `${projectFromCwd(thread.cwd).name} · ${shortPath(thread.cwd)}` : t("empty.noProject");
    els.currentConversationSummary.innerHTML = `
      <strong>${escapeHtml(name)}</strong>
      <small>${escapeHtml(context)}</small>
    `;
  }
}

function applyBridgeModeUi() {
  const disabled = state.desktopBridgeConnected !== true
    || state.initialSettingsLoading || Boolean(state.loadingThreadId)
    || state.settingsSaving
    || !state.threadSettingsAvailable;
  document.documentElement.classList.add("desktop-bridge-mode");
  for (const select of [els.modelSelect, els.reasoningSelect, els.permissionSelect]) {
    if (!select) continue;
    select.disabled = disabled;
    select.title = "";
  }
  els.browseWorkspace.disabled = state.desktopBridgeConnected !== true
    || !state.workspaceBrowserAvailable
    || (Boolean(state.currentThread?.id) && !state.currentThread?.draft);
  els.chatPane?.classList.toggle(
    "desktop-bridge-offline",
    state.desktopBridgeConnected !== true
  );
  updateResumeStatus(state.currentThread);
}

function setDesktopBridgeStatus(connected) {
  const wasConnected = state.desktopBridgeConnected === true;
  state.desktopBridgeConnected = Boolean(connected);
  asyncQuestionCards.refresh();
  workspacePanel?.setConnected(Boolean(connected) && state.connected);
  if (wasConnected && !state.desktopBridgeConnected) {
    state.threadSettingsCache.clear();
  }
  applyBridgeModeUi();
  if (!state.connected) return;
  setConnection(connected ? "connection.connected" : "connection.desktopBridgeOffline");
}

async function reconnectDesktopBridge() {
  if (state.desktopBridgeReconnecting) return;
  state.desktopBridgeReconnecting = true;
  updateResumeStatus(state.currentThread);
  try {
    await rpc("config/read", {});
    setDesktopBridgeStatus(true);
    scheduleCurrentThreadSync(0);
  } catch (error) {
    setDesktopBridgeStatus(false);
    throw error;
  } finally {
    state.desktopBridgeReconnecting = false;
    updateResumeStatus(state.currentThread);
  }
}

function updateResumeStatus(thread) {
  asyncQuestionCards.refresh();
  if (!els.resumeStatus) return;
  if (state.desktopBridgeConnected !== true) {
    const reconnecting = state.desktopBridgeReconnecting;
    els.resumeStatus.classList.remove("hidden", "resumed");
    els.resumeStatus.classList.add("unresumed");
    els.resumeStatus.textContent = t(reconnecting ? "thread.bridgeReconnecting" : "thread.bridgeReconnect");
    els.resumeStatus.disabled = reconnecting;
    els.resumeStatus.title = t("thread.bridgeReconnectTitle");
    return;
  }
  const status = formatStatus(thread?.status);
  const hasThread = Boolean(thread?.id);
  const resuming = hasThread && state.resumingThreadId === thread.id;
  const resumed = hasThread && status !== "notLoaded" && status !== "draft";
  els.resumeStatus.classList.toggle("hidden", !hasThread || status === "draft");
  els.resumeStatus.classList.toggle("resumed", resumed);
  els.resumeStatus.classList.toggle("unresumed", !resumed);
  els.chatPane?.classList.toggle("resuming-thread", resuming);
  els.chatPane?.classList.toggle("connected-thread", resumed && !resuming);
  const label = resuming ? "thread.bridgeLoading" : resumed ? "thread.bridgeConnected" : "thread.bridgeLoad";
  els.resumeStatus.textContent = t(label);
  els.resumeStatus.disabled = !hasThread || resumed || resuming;
  els.resumeStatus.title = t(resumed ? "thread.bridgeConnectedTitle" : "thread.bridgeLoadTitle");
}

function setConnection(key) {
  refreshWorkflow();
  const text = t(key);
  els.connection.textContent = text;
  if (!els.connectionBanner) return;

  const value = String(text || "");
  const shouldShow = value && key !== "connection.connected";
  els.connectionBanner.textContent = value;
  els.connectionBanner.classList.toggle("hidden", !shouldShow);
  els.connectionBanner.classList.toggle(
    "danger",
    ["connection.invalidToken", "connection.error", "connection.missingToken"].includes(key)
  );
  els.connectionBanner.classList.toggle(
    "connecting",
    ["connection.connecting", "connection.reconnecting"].includes(key)
  );
}

function labelFor(role) {
  if (role === "user") return t("role.user");
  if (role === "assistant") return "Codex";
  if (role === "tool") return t("role.tool");
  return t("role.status");
}

function formatDate(seconds) {
  if (!seconds) return "";
  return new Intl.DateTimeFormat(currentLocale(), {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(seconds * 1000));
}

function formatDateTime(seconds) {
  if (!seconds) return "";
  return new Intl.DateTimeFormat(currentLocale(), {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(seconds * 1000));
}

function formatAutomationTime(value) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(currentLocale(), {
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function formatAutomationDateTime(value) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(currentLocale(), {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(date);
}

function shortPath(value) {
  if (!value) return "";
  const text = String(value);
  const parts = text.split(/[\\/]/).filter(Boolean);
  return parts.length > 2 ? `.../${parts.slice(-2).join("/")}` : text;
}

function projectFromCwd(value) {
  const cwd = String(value || t("project.unspecified"));
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  const fallback = cwd.replace(/[\\/]+$/, "");
  return {
    key: normalizePath(cwd),
    cwd,
    name: parts.at(-1) || fallback || t("project.unspecified")
  };
}

async function openWorkspacePicker() {
  els.workspacePicker.classList.remove("hidden");
  els.workspaceError.classList.add("hidden");
  els.workspaceName.value = "";
  await loadWorkspaceDirectory(els.projectSelect.value || "");
}

function closeWorkspacePicker() {
  els.workspacePicker.classList.add("hidden");
}

async function loadWorkspaceDirectory(directory = "") {
  els.workspaceDirectoryList.textContent = t("workspace.loading");
  els.workspaceError.classList.add("hidden");
  try {
    const url = new URL(authenticatedUrl("/api/workspaces", state.token), window.location.origin);
    if (directory) url.searchParams.set("path", directory);
    const response = await fetch(url);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || t("error.request"));
    renderWorkspaceDirectory(payload);
  } catch (error) {
    showWorkspaceError(error.message || t("error.request"));
  }
}

function renderWorkspaceDirectory(payload) {
  const directory = payload?.path || "";
  els.workspaceCurrentPath.textContent = directory || t("workspace.roots");
  els.workspaceCurrentPath.dataset.path = directory;
  els.workspaceParent.dataset.path = payload?.parent || "";
  els.workspaceParent.disabled = !payload?.parent;
  els.workspaceUseCurrent.disabled = !directory;
  els.workspaceDirectoryList.innerHTML = "";
  const entries = directory ? payload?.directories || [] : payload?.roots || [];
  if (!entries.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state compact-empty";
    empty.textContent = t("workspace.empty");
    els.workspaceDirectoryList.append(empty);
    return;
  }
  for (const entry of entries) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "workspace-directory";
    button.textContent = entry.name;
    button.title = entry.path;
    button.addEventListener("click", () => loadWorkspaceDirectory(entry.path));
    els.workspaceDirectoryList.append(button);
  }
}

async function useCurrentWorkspace() {
  const directory = els.workspaceCurrentPath.dataset.path || "";
  if (!directory) {
    showWorkspaceError(t("workspace.selectDirectory"));
    return;
  }
  await selectWorkspace(directory);
}

async function createAndUseWorkspace(event) {
  event.preventDefault();
  const parent = els.workspaceCurrentPath.dataset.path || "";
  if (!parent) {
    showWorkspaceError(t("workspace.selectDirectory"));
    return;
  }
  try {
    const url = new URL(authenticatedUrl("/api/workspaces/create", state.token), window.location.origin);
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parent, name: els.workspaceName.value })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || t("error.request"));
    await selectWorkspace(payload.workspace.path);
  } catch (error) {
    showWorkspaceError(error.message || t("error.request"));
  }
}

async function selectWorkspace(directory) {
  if (state.pendingImages.length || state.sendingThreadId) { workflowNotice(t("draft.attachments-or-send")); return; }
  if (state.currentThread?.id && !state.currentThread?.draft) return;
  if (!state.currentThread?.draft && createThread() === false) return;
  state.currentThread.cwd = directory;
  setProjectSelection(directory);
  updateThreadHeader();
  renderEmpty(t("thread.new"), t("empty.newThreadProject", { project: projectFromCwd(directory).name }));
  await loadPermissionModes(directory);
  closeWorkspacePicker();
}

function showWorkspaceError(message) {
  els.workspaceError.textContent = message;
  els.workspaceError.classList.remove("hidden");
}

function scopeCwdsFrom(source) {
  const values = Array.isArray(source?.threadFilterCwds)
    ? source.threadFilterCwds
    : source?.threadFilterCwd
      ? [source.threadFilterCwd]
      : [];
  return [...new Map(
    values
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .map((value) => [normalizePath(value), value])
  ).values()];
}

function hasScopedToken() {
  return state.threadFilterCwds.length > 0;
}

function preferredScopedCwd() {
  return state.threadFilterCwds[0] || "";
}

function isProjectGroup(group) {
  const cwd = normalizePath(group.cwd);
  const name = group.name.toLowerCase();
  if (!cwd) return false;
  if (/\/documents\/codex\/\d{4}-\d{2}-\d{2}\//.test(cwd)) return false;
  if (/\/codex\/\d{4}-\d{2}-\d{2}\//.test(cwd)) return false;
  if (name.startsWith("new-chat")) return false;
  return true;
}

function samePath(a, b) {
  return normalizePath(a) === normalizePath(b);
}

function normalizePath(value) {
  return String(value || "")
    .replace(/[\\/]+$/, "")
    .replaceAll("\\", "/")
    .toLowerCase();
}

function formatStatus(status) {
  if (!status) return "ready";
  if (typeof status === "string") return status;
  if (typeof status === "object" && status.type) return status.type;
  return "ready";
}

function formatStatusLabel(status) {
  const value = formatStatus(status);
  const key = `status.${value}`;
  const label = t(key);
  return label === key ? value : label;
}

function formatRelativeTime(seconds) {
  if (!seconds) return "";
  const diffSeconds = Math.max(1, Math.floor(Date.now() / 1000 - seconds));
  const minute = 60;
  const hour = minute * 60;
  const day = hour * 24;
  const week = day * 7;
  if (diffSeconds < hour) return t("relative.minutes", { count: Math.max(1, Math.floor(diffSeconds / minute)) });
  if (diffSeconds < day) return t("relative.hours", { count: Math.floor(diffSeconds / hour) });
  if (diffSeconds < week) return t("relative.days", { count: Math.floor(diffSeconds / day) });
  return t("relative.weeks", { count: Math.floor(diffSeconds / week) });
}

function formatBytes(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
  return `${(value / 1024 / 1024).toFixed(value < 10 * 1024 * 1024 ? 2 : 1)} MB`;
}

function formatDuration(ms) {
  const value = Math.max(0, Number(ms) || 0);
  if (value < 1000) return `${Math.round(value)} ms`;
  return `${(value / 1000).toFixed(value < 10000 ? 1 : 0)} s`;
}

function byteLengthText(text) {
  return byteEncoder.encode(String(text || "")).length;
}

function encodedJsonBytes(value) {
  return byteLengthText(JSON.stringify(value));
}

function folderIcon() {
  return `
    <svg class="folder-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h4.1l2 2H18.5A2.5 2.5 0 0 1 21 9.5v6A3.5 3.5 0 0 1 17.5 19h-11A3.5 3.5 0 0 1 3 15.5v-8Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
    </svg>
  `;
}

function settingsIcon() {
  return `
    <svg class="settings-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 8.2a3.8 3.8 0 1 1 0 7.6 3.8 3.8 0 0 1 0-7.6Z" fill="none" stroke="currentColor" stroke-width="1.8"/>
      <path d="M19.2 13.1c.05-.36.08-.72.08-1.1s-.03-.74-.08-1.1l2-1.52-1.9-3.28-2.35.96a8.1 8.1 0 0 0-1.9-1.1L14.7 3.4h-3.8l-.36 2.56a8.1 8.1 0 0 0-1.9 1.1L6.3 6.1 4.4 9.38l2 1.52c-.05.36-.08.72-.08 1.1s.03.74.08 1.1l-2 1.52 1.9 3.28 2.35-.96c.58.46 1.22.83 1.9 1.1l.36 2.56h3.8l.36-2.56a8.1 8.1 0 0 0 1.9-1.1l2.35.96 1.9-3.28-2-1.52Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>
    </svg>
  `;
}

function resizePromptInput() {
  const minHeight = 40;
  els.promptInput.style.height = `${minHeight}px`;
  const nextHeight = Math.min(160, Math.max(minHeight, els.promptInput.scrollHeight));
  els.promptInput.style.height = `${nextHeight}px`;
  els.promptInput.style.overflowY = els.promptInput.scrollHeight > 160 ? "auto" : "hidden";
  updateMobileChromeMetrics();
}

function submitComposer() {
  if (els.sendButton.disabled) return;
  if (els.composer.requestSubmit) {
    els.composer.requestSubmit();
    return;
  }
  els.composer.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

const markdownRenderer = createMarkdownRenderer();

function createMarkdownRenderer() {
  if (!window.markdownit || !window.DOMPurify) return null;

  const renderer = window.markdownit({
    breaks: true,
    html: false,
    linkify: true,
    typographer: false
  });

  const defaultLinkOpen =
    renderer.renderer.rules.link_open ||
    ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options));
  const defaultImage =
    renderer.renderer.rules.image ||
    ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options));

  renderer.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const hrefIndex = token.attrIndex("href");
    if (hrefIndex >= 0) {
      const href = safeUrl(token.attrs[hrefIndex][1], "link");
      if (href) {
        token.attrs[hrefIndex][1] = href;
        token.attrSet("target", "_blank");
        token.attrSet("rel", "noreferrer");
      } else {
        token.attrs.splice(hrefIndex, 1);
      }
    }
    return defaultLinkOpen(tokens, idx, options, env, self);
  };

  renderer.renderer.rules.image = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const srcIndex = token.attrIndex("src");
    if (srcIndex >= 0) {
      const src = safeUrl(token.attrs[srcIndex][1], "image");
      if (src) {
        const alt = token.content ? ` aria-label="${escapeHtml(token.content)}"` : "";
        return `<button class="image-placeholder markdown-image-placeholder" type="button" data-image-src="${escapeHtml(src)}"${alt}><span>${escapeHtml(t("image.defaultName"))}</span><small>${escapeHtml(t("image.clickLoad"))}</small></button>`;
      }
      token.attrs.splice(srcIndex, 1);
    }
    return defaultImage(tokens, idx, options, env, self);
  };

  return renderer;
}

function renderMarkdown(value) {
  if (!markdownRenderer || !window.DOMPurify) return escapeHtml(value);

  const dirty = markdownRenderer.render(String(value || ""));
  return window.DOMPurify.sanitize(dirty, {
    ADD_ATTR: ["target", "data-image-src"],
    FORBID_TAGS: ["style", "script", "iframe", "object", "embed"],
    ALLOW_DATA_ATTR: true
  });
}

function safeUrl(rawUrl, kind) {
  const value = String(rawUrl || "").trim();
  if (!value) return "";
  if (/^https?:/i.test(value)) return normalizeHttpUrl(value);
  if (/^mailto:/i.test(value)) return kind === "link" ? value : "";
  if (kind === "image" && /^data:image\/[a-zA-Z0-9.+-]+;base64,/i.test(value)) return value;
  const localPath = localPathFromMarkdownUrl(value, kind);
  if (localPath) {
    return authenticatedUrl(`/api/local-file?path=${encodeURIComponent(localPath)}`, state.token);
  }
  if (kind === "image" && /^\/(?![A-Za-z]:)/.test(value)) return value;
  if (kind === "link" && /^(#|\/(?![A-Za-z]:))/.test(value)) return value;
  return "";
}

function normalizeHttpUrl(value) {
  try {
    const url = new URL(value, window.location.href);
    if (isLocalBrowserHost(url.hostname)) {
      return `${url.pathname}${url.search}${url.hash}`;
    }
    return url.toString();
  } catch {
    return value;
  }
}

function isLocalBrowserHost(hostname) {
  const value = String(hostname || "").toLowerCase();
  return value === "localhost" || value === "127.0.0.1" || value === "0.0.0.0" || value === "[::1]" || value === "::1";
}

function localPathFromMarkdownUrl(value, kind = "image") {
  const decoded = decodeMarkdownUrlPath(value);
  const withoutFileScheme = decoded.replace(/^file:\/\//i, "");
  if (/^\/[A-Za-z]:\//.test(withoutFileScheme)) return withoutFileScheme.slice(1);
  if (/^[A-Za-z]:[\\/]/.test(withoutFileScheme)) return withoutFileScheme;
  if (kind === "image" && state.currentThread?.cwd && isRelativeLocalImagePath(withoutFileScheme)) {
    return joinLocalPath(state.currentThread.cwd, withoutFileScheme);
  }
  return "";
}

function decodeMarkdownUrlPath(value) {
  try {
    return decodeURIComponent(String(value || ""));
  } catch {
    return String(value || "");
  }
}

function isRelativeLocalImagePath(value) {
  if (!value || /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("//")) return false;
  return /\.(png|jpe?g|webp|gif|svg)(?:[?#].*)?$/i.test(value);
}

function joinLocalPath(base, relativePath) {
  const slash = base.includes("\\") ? "\\" : "/";
  const cleanBase = base.replace(/[\\/]+$/, "");
  const cleanRelative = relativePath.replace(/[?#].*$/, "").replace(/^[\\/]+/, "").replaceAll("/", slash).replaceAll("\\", slash);
  return `${cleanBase}${slash}${cleanRelative}`;
}
