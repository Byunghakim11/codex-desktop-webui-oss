import {
  CODEX_APP_TOOLS,
  GOAL_VERSION_NONE,
  NATIVE_CAPABILITIES,
  NativeActionError,
  THREAD_GOAL_METHODS,
  USER_GOAL_STATUSES,
  authorizeThreadTarget,
  callCodexAppTool,
  describeActions,
  getActionDefinition,
  isPlainObject,
  nativeFail,
  nativeFailure,
  parseGoalResult,
  parseToolResult,
  requireFunction,
  validateRequestId,
  validateThreadId
} from "./native-capabilities.js";
import { createConfirmationStore, digestParams, digestState, principalFromScope } from "./native-confirmations.js";
import { createHeartbeatService } from "./native-heartbeats.js";
import { createNativeThreadActionsService } from "./native-thread-actions.js";
import { createNativeUtilities } from "./native-utilities.js";

export { NativeActionError, isNativeActionError, NATIVE_CAPABILITIES, GOAL_VERSION_NONE, USER_GOAL_STATUSES } from "./native-capabilities.js";
export { createConfirmationStore, NativeConfirmationError } from "./native-confirmations.js";
export { createHeartbeatService, HeartbeatError, HeartbeatIndexError } from "./native-heartbeats.js";

// Server-side action service. Scope objects come from the authenticated request path; this module
// never reads credentials, config or files other than the private dataDir state written by its
// confirmation/heartbeat stores. `authorizeThread` is mandatory and is re-run before every native
// mutation so a router that resolved scope earlier cannot widen access.
export function createNativeActionsService({
  callNative,
  authorizeThread,
  dataDir,
  now = () => Date.now(),
  confirmations = null,
  heartbeats = null,
  codexHome = process.env.CODEX_HOME || "",
  listHeartbeatRecords = null,
  confirmationTtlMs
} = {}) {
  requireFunction(callNative, "NATIVE_UNAVAILABLE");
  requireFunction(authorizeThread, "AUTHORIZATION_REQUIRED", 403);
  if (typeof dataDir !== "string" || !dataDir) throw nativeFail(500, "DATA_DIR_REQUIRED");

  const confirmationsStore = confirmations || createConfirmationStore({ dataDir, now, ttlMs: confirmationTtlMs });
  const heartbeatService = heartbeats || createHeartbeatService({
    callNative,
    authorizeThread,
    dataDir,
    now,
    codexHome,
    listHeartbeatRecords
  });

  const requireThread = (scope, threadId) => authorizeThreadTarget({ authorizeThread, scope, threadId });
  const threadActions = createNativeThreadActionsService({ callNative, authorizeThread, dataDir, now, confirmations: confirmationsStore });
  const utilities = createNativeUtilities({ callNative, authorizeThread, confirmations: confirmationsStore });

  async function callNativeSafe(method, params) {
    let result;
    try {
      result = await callNative(method, params);
    } catch (error) {
      throw nativeFailure(error);
    }
    return result;
  }

  async function callCodexToolSafe(threadId, tool, args) {
    let result;
    try {
      result = await callCodexAppTool({ callNative, threadId, tool, arguments: args });
    } catch (error) {
      throw nativeFailure(error);
    }
    return parseToolResult(result);
  }

  async function readGoal(thread) {
    const result = await callNativeSafe(THREAD_GOAL_METHODS.get, { threadId: thread.id });
    return parseGoalResult(result);
  }

  async function goalAfterMutation(result, thread) {
    const looksLikeGoal = isPlainObject(result)
      && (Object.hasOwn(result, "goal") || USER_GOAL_STATUSES.concat(["blocked", "usageLimited", "budgetLimited"]).includes(result.status));
    if (looksLikeGoal) {
      try {
        return parseGoalResult(result);
      } catch {
        return readGoal(thread);
      }
    }
    return readGoal(thread);
  }

  function assertVersionForEdit(current, expectedVersion) {
    if (current.goal) {
      if (expectedVersion !== current.version) throw nativeFail(409, "STALE_GOAL");
      return;
    }
    if (expectedVersion !== undefined && expectedVersion !== GOAL_VERSION_NONE) throw nativeFail(409, "STALE_GOAL");
  }

  async function setGoal(scope, threadId, params, confirmationId) {
    const thread = await requireThread(scope, threadId);
    const current = await readGoal(thread);
    assertVersionForEdit(current, params.expectedVersion);

    const payload = { threadId: thread.id };
    if (params.objective !== undefined && params.objective !== current.goal?.objective) payload.objective = params.objective;
    if (params.status !== undefined && params.status !== current.goal?.status) payload.status = params.status;
    if (Object.hasOwn(params, "tokenBudget") && params.tokenBudget !== current.goal?.tokenBudget) payload.tokenBudget = params.tokenBudget;

    const changed = Object.hasOwn(payload, "objective") || Object.hasOwn(payload, "status") || Object.hasOwn(payload, "tokenBudget");
    if (!changed) {
      return { ok: true, action: "goal.set", threadId: thread.id, goal: current.goal, version: current.version, changed: false, usageReset: false };
    }
    // Completing a goal is a terminal intent and requires a single-use confirmation like clear.
    if (payload.status === "complete") {
      await consumeConfirmation({
        scope,
        action: "goal.set",
        threadId: thread.id,
        params,
        confirmationId,
        stateDigest: digestState(current.version)
      });
    }
    payload.origin = "user";
    await requireThread(scope, threadId);
    const result = await callNativeSafe(THREAD_GOAL_METHODS.set, payload);
    const after = await goalAfterMutation(result, thread);
    return { ok: true, action: "goal.set", threadId: thread.id, goal: after.goal, version: after.version, changed: true, usageReset: Object.hasOwn(payload, "objective") };
  }

  async function setGoalStatus(scope, threadId, action, params, target) {
    const thread = await requireThread(scope, threadId);
    const current = await readGoal(thread);
    if (!current.goal) throw nativeFail(409, "NO_GOAL");
    assertVersionForEdit(current, params.expectedVersion);
    if (current.goal.status === target) {
      return { ok: true, action, threadId: thread.id, goal: current.goal, version: current.version, changed: false, usageReset: false };
    }
    await requireThread(scope, threadId);
    // Only status + origin are sent: objective and tokenBudget are omitted so native usage is kept.
    const result = await callNativeSafe(THREAD_GOAL_METHODS.set, { threadId: thread.id, status: target, origin: "user" });
    const after = await goalAfterMutation(result, thread);
    return { ok: true, action, threadId: thread.id, goal: after.goal, version: after.version, changed: true, usageReset: false };
  }

  async function clearGoal(scope, threadId, params, confirmationId) {
    const thread = await requireThread(scope, threadId);
    const current = await readGoal(thread);
    await consumeConfirmation({
      scope,
      action: "goal.clear",
      threadId: thread.id,
      params,
      confirmationId,
      stateDigest: digestState(current.version)
    });
    await requireThread(scope, threadId);
    await callNativeSafe(THREAD_GOAL_METHODS.clear, { threadId: thread.id, origin: "user" });
    return { ok: true, action: "goal.clear", threadId: thread.id, cleared: true, goal: null, version: GOAL_VERSION_NONE };
  }

  function pinnedFlag(summary) {
    if (summary.pinned === true) return true;
    if (summary.pinned === false) return false;
    const section = summary.sectionId ?? summary.section?.id ?? summary.section;
    if (typeof section === "string") return section === "pinned";
    if (Array.isArray(summary.sections)) return summary.sections.includes("pinned");
    return null;
  }

  // Scope-aware: we only look at the authorized target thread inside the list result and emit a
  // single boolean, so unrelated thread metadata from list_threads never leaves this module.
  function locateThread(root, threadId) {
    const seen = new Set();
    let visited = 0;
    const walk = (node, inPinned, depth) => {
      if (!node || typeof node !== "object" || depth > 5 || visited > 2000) return null;
      if (seen.has(node)) return null;
      seen.add(node);
      visited += 1;
      if (Array.isArray(node)) {
        for (const item of node) {
          if (isPlainObject(item) && item.id === threadId) {
            return { pinned: inPinned ? true : pinnedFlag(item) };
          }
          const found = walk(item, inPinned, depth + 1);
          if (found) return found;
        }
        return null;
      }
      if (isPlainObject(node) && node.id === threadId) {
        return { pinned: inPinned ? true : pinnedFlag(node) };
      }
      for (const [key, value] of Object.entries(node)) {
        if (!value || typeof value !== "object") continue;
        const found = walk(value, inPinned || /pinned/i.test(key), depth + 1);
        if (found) return found;
      }
      return null;
    };
    return walk(root, false, 0);
  }

  async function verifyPin(threadId, sectionId) {
    let parsed;
    try {
      parsed = await callCodexToolSafe(threadId, CODEX_APP_TOOLS.listThreads, { mode: "recent", limit: 50 });
    } catch {
      return null;
    }
    if (!parsed.json) return null;
    const located = locateThread(parsed.json, threadId);
    if (!located) return null;
    if (located.pinned === null) return null;
    return sectionId === "pinned" ? located.pinned : !located.pinned;
  }

  async function setPin(scope, threadId, action) {
    const thread = await requireThread(scope, threadId);
    const sectionId = action === "thread.pin" ? "pinned" : null;
    const args = { source: "codex", threadId: thread.id, sectionId };
    await requireThread(scope, threadId);
    const result = await callCodexToolSafe(thread.id, CODEX_APP_TOOLS.moveThreadToSidebarSection, args);
    const verified = result.json || result.text ? await verifyPin(thread.id, sectionId) : null;
    return { ok: true, action, threadId: thread.id, sectionId, verified };
  }

  async function stateDigestFor(scope, action, thread) {
    if (action === "goal.clear" || action === "goal.set") {
      const current = await readGoal(thread);
      return digestState(current.version);
    }
    if (action === "heartbeat.delete") {
      return null; // computed by the caller from validated params
    }
    throw nativeFail(500, "CONFIRMATION_NOT_SUPPORTED");
  }

  async function prepareConfirmation(scope, { action, threadId, params } = {}) {
    if (utilities.supports(action)) return utilities.prepareConfirmation(scope, { action, threadId, params });
    if (threadActions.supports(action)) return threadActions.prepareConfirmation(scope, { action, threadId, params });
    const definition = getActionDefinition(action);
    if (!definition) throw nativeFail(400, "UNKNOWN_ACTION");
    validateThreadId(threadId);
    const normalized = definition.validate(params ?? {});
    const terminalSet = definition.id === "goal.set" && normalized.status === "complete";
    if (!definition.requiresConfirmation && !terminalSet) throw nativeFail(400, "CONFIRMATION_NOT_REQUIRED");
    const thread = await requireThread(scope, threadId);
    const stateDigest = action === "heartbeat.delete"
      ? await heartbeatService.confirmationState(scope, { threadId: thread.id, params: normalized })
      : await stateDigestFor(scope, action, thread);
    const receipt = await confirmationsStore.issue({
      principal: principalFromScope(scope),
      action,
      threadId: thread.id,
      paramsDigest: digestParams(normalized),
      stateDigest
    });
    return { confirmationId: receipt.id, action, threadId: thread.id, expiresAt: receipt.expiresAt };
  }

  async function consumeConfirmation({ scope, action, threadId, params, confirmationId, stateDigest }) {
    if (typeof confirmationId !== "string" || !confirmationId) throw nativeFail(400, "CONFIRMATION_REQUIRED");
    await confirmationsStore.consume({
      id: confirmationId,
      principal: principalFromScope(scope),
      action,
      threadId,
      paramsDigest: digestParams(params),
      stateDigest
    });
  }

  async function describe(scope, { threadId } = {}) {
    const thread = await requireThread(scope, threadId);
    return {
      threadId: thread.id,
      actions: [...describeActions(), ...(await threadActions.describe(scope, { threadId: thread.id })).actions, ...utilities.describe()],
      capabilities: NATIVE_CAPABILITIES
    };
  }

  async function getGoal(scope, { threadId } = {}) {
    const thread = await requireThread(scope, threadId);
    const current = await readGoal(thread);
    return { ok: true, action: "goal.get", threadId: thread.id, goal: current.goal, version: current.version };
  }

  async function execute(scope, { action, threadId, params = {}, requestId, confirmationId } = {}) {
    if (utilities.supports(action)) return utilities.execute(scope, { action, threadId, params, confirmationId });
    if (threadActions.supports(action)) return threadActions.execute(scope, { action, threadId, params, requestId, confirmationId });
    const definition = getActionDefinition(action);
    if (!definition) throw nativeFail(400, "UNKNOWN_ACTION");
    validateThreadId(threadId);
    const normalized = definition.validate(params ?? {});
    if (definition.id === "goal.get") return getGoal(scope, { threadId });

    const thread = await requireThread(scope, threadId);

    switch (definition.id) {
      case "goal.set":
        return setGoal(scope, thread.id, normalized, confirmationId);
      case "goal.pause":
        return setGoalStatus(scope, thread.id, definition.id, normalized, "paused");
      case "goal.resume":
        return setGoalStatus(scope, thread.id, definition.id, normalized, "active");
      case "goal.clear":
        return clearGoal(scope, thread.id, normalized, confirmationId);
      case "thread.pin":
      case "thread.unpin":
        return setPin(scope, thread.id, definition.id);
      case "heartbeat.list": {
        const payload = await heartbeatService.list(scope, { threadId: thread.id });
        return { ok: true, action: definition.id, threadId: thread.id, ...payload };
      }
      case "heartbeat.view": {
        const payload = await heartbeatService.view(scope, { threadId: thread.id, params: normalized });
        return { ok: true, action: definition.id, threadId: thread.id, ...payload };
      }
      case "heartbeat.create": {
        if (requestId === undefined || requestId === null) throw nativeFail(400, "REQUEST_ID_REQUIRED");
        const requestKey = validateRequestId(requestId);
        const payload = await heartbeatService.create(scope, { threadId: thread.id, params: normalized, requestId: requestKey });
        return { ok: true, action: definition.id, threadId: thread.id, ...payload };
      }
      case "heartbeat.update": {
        const payload = await heartbeatService.update(scope, { threadId: thread.id, params: normalized });
        return { ok: true, action: definition.id, threadId: thread.id, ...payload };
      }
      case "heartbeat.pause":
      case "heartbeat.resume": {
        const status = definition.id === "heartbeat.pause" ? "PAUSED" : "ACTIVE";
        const payload = await heartbeatService.setStatus(scope, { threadId: thread.id, params: normalized, status });
        return { ok: true, action: definition.id, threadId: thread.id, ...payload };
      }
      case "heartbeat.delete": {
        const stateDigest = await heartbeatService.confirmationState(scope, { threadId: thread.id, params: normalized });
        await consumeConfirmation({
          scope,
          action: definition.id,
          threadId: thread.id,
          params: normalized,
          confirmationId,
          stateDigest
        });
        const payload = await heartbeatService.remove(scope, { threadId: thread.id, params: normalized, expectedState: stateDigest });
        return { ok: true, action: definition.id, threadId: thread.id, ...payload };
      }
      default:
        throw nativeFail(400, "UNKNOWN_ACTION");
    }
  }

  return Object.freeze({ describe, getGoal, execute, prepareConfirmation });
}
