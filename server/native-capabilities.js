import { createHash } from "node:crypto";

// Static native action surface. Everything in this module is data + pure validation/parsing.
// There is deliberately no raw RPC passthrough: callers can never supply a method name, an MCP
// server id, a tool name, host ids or _meta. Those are constants owned by this module.
//
// Contracts read from .superpowers/sdd/2026-11-10-context-files-editor/native-app-contracts.json
// and native-contracts.json. Runtime evidence (authenticated Desktop bridge): thread/goal/get
// returns the current root goal; mcpServer/tool/call against server codex_app with
// tool=list_projects succeeds with isError=false and {content, isError} result keys.
export const MCP_SERVER_ID = "codex_app";

export const CODEX_APP_TOOLS = Object.freeze({
  automationUpdate: "automation_update",
  listThreads: "list_threads",
  moveThreadToSidebarSection: "move_thread_to_sidebar_section"
});

const ALLOWED_CODEX_APP_TOOLS = new Set(Object.values(CODEX_APP_TOOLS));

export const THREAD_GOAL_METHODS = Object.freeze({
  get: "thread/goal/get",
  set: "thread/goal/set",
  clear: "thread/goal/clear"
});

// Exact native statuses from ThreadGoalStatus.
export const GOAL_STATUSES = Object.freeze([
  "active",
  "paused",
  "blocked",
  "usageLimited",
  "budgetLimited",
  "complete"
]);
// Statuses an operator may set directly without a specific confirmed need.
export const USER_GOAL_STATUSES = Object.freeze(["active", "paused", "complete"]);

export const MAX_OBJECTIVE_CHARS = 4000;
export const MAX_THREAD_ID_CHARS = 200;
export const MAX_AUTOMATION_ID_CHARS = 200;
export const MAX_HEARTBEAT_NAME_CHARS = 200;
export const MAX_HEARTBEAT_PROMPT_CHARS = 8000;
export const MIN_HEARTBEAT_INTERVAL_MINUTES = 1;
export const MAX_HEARTBEAT_INTERVAL_MINUTES = 1440;
export const HEARTBEAT_STATUSES = Object.freeze(["ACTIVE", "PAUSED"]);
export const NOTIFICATION_POLICIES = Object.freeze(["failed_runs_only"]);
export const GOAL_VERSION_NONE = "none";

const SAFE_ID = /^[A-Za-z0-9._:-]{1,200}$/;
const VERSION_TOKEN = /^(?:none|[0-9a-f]{64})$/;

export class NativeActionError extends Error {
  constructor(status, code, { retryable = false, nativeCode = null } = {}) {
    super(code);
    this.name = "NativeActionError";
    this.status = status;
    this.code = code;
    this.retryable = Boolean(retryable);
    if (nativeCode) this.nativeCode = String(nativeCode).slice(0, 64);
  }
}

export const isNativeActionError = value => value instanceof NativeActionError;
export const nativeFail = (status, code, options) => new NativeActionError(status, code, options);
export const invalid = (code = "INVALID_PARAMS") => nativeFail(400, code);

export function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function requirePlainObject(value, code = "INVALID_PARAMS") {
  if (!isPlainObject(value)) throw invalid(code);
  return value;
}

export function requireFunction(value, code, status = 500) {
  if (typeof value !== "function") throw nativeFail(status, code);
  return value;
}

// Own-property based so JSON.parse('{"__proto__":...}') payloads are rejected by allowlists.
export function assertKnownKeys(object, allowed, code = "INVALID_PARAMS") {
  for (const key of Object.getOwnPropertyNames(object)) {
    if (!allowed.includes(key)) throw invalid(code);
  }
  return object;
}

export function canonicalJson(value) {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalid("INVALID_PARAMS");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isPlainObject(value)) {
    const keys = Object.keys(value).sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  throw invalid("INVALID_PARAMS");
}

export function digest(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

// Character count is Unicode code-point based, matching the 4000-char objective contract test.
export const objectiveLength = value => Array.from(value).length;

export function validateThreadId(threadId) {
  if (typeof threadId !== "string" || !threadId || threadId.length > MAX_THREAD_ID_CHARS) throw invalid("INVALID_THREAD_ID");
  if (/[\x00-\x1f\x7f]/.test(threadId)) throw invalid("INVALID_THREAD_ID");
  return threadId;
}

export function validateAutomationId(id) {
  if (typeof id !== "string" || !SAFE_ID.test(id)) throw invalid("INVALID_AUTOMATION_ID");
  return id;
}

export function validateObjective(objective) {
  if (typeof objective !== "string" || objective.length === 0) throw invalid("INVALID_OBJECTIVE");
  if (objectiveLength(objective) > MAX_OBJECTIVE_CHARS) throw invalid("OBJECTIVE_TOO_LONG");
  return objective;
}

// int64 budget is only accepted when it fits exactly in a JS safe integer. No default budget.
export function validateTokenBudget(tokenBudget) {
  if (tokenBudget === null) return null;
  if (typeof tokenBudget !== "number" || !Number.isSafeInteger(tokenBudget) || tokenBudget <= 0) throw invalid("INVALID_TOKEN_BUDGET");
  return tokenBudget;
}

export function validateExpectedVersion(expectedVersion) {
  if (typeof expectedVersion !== "string" || !VERSION_TOKEN.test(expectedVersion)) throw invalid("INVALID_VERSION");
  return expectedVersion;
}

export function validateRequestId(requestId) {
  if (typeof requestId !== "string" || requestId.length > 128 || !/^[A-Za-z0-9._:-]{1,128}$/.test(requestId)) throw invalid("INVALID_REQUEST_ID");
  return requestId;
}

export function validateGoalSetParams(params) {
  requirePlainObject(params);
  assertKnownKeys(params, ["objective", "status", "tokenBudget", "expectedVersion"]);
  const out = {};
  if (Object.hasOwn(params, "objective")) out.objective = validateObjective(params.objective);
  if (Object.hasOwn(params, "status")) {
    if (!USER_GOAL_STATUSES.includes(params.status)) {
      if (GOAL_STATUSES.includes(params.status)) throw nativeFail(400, "STATUS_READ_ONLY");
      throw invalid("INVALID_STATUS");
    }
    out.status = params.status;
  }
  if (Object.hasOwn(params, "tokenBudget")) out.tokenBudget = validateTokenBudget(params.tokenBudget);
  if (Object.hasOwn(params, "expectedVersion")) out.expectedVersion = validateExpectedVersion(params.expectedVersion);
  if (!("objective" in out) && !("status" in out) && !("tokenBudget" in out)) throw invalid("NO_GOAL_CHANGES");
  return out;
}

export function validateGoalStatusParams(params) {
  requirePlainObject(params);
  assertKnownKeys(params, ["expectedVersion"]);
  if (!Object.hasOwn(params, "expectedVersion")) throw invalid("INVALID_VERSION");
  return { expectedVersion: validateExpectedVersion(params.expectedVersion) };
}

export function validateGoalClearParams(params) {
  requirePlainObject(params);
  assertKnownKeys(params, []);
  return {};
}

export function validatePinParams(params) {
  requirePlainObject(params);
  assertKnownKeys(params, []);
  return {};
}

function validateBoundedText(value, max, code) {
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw invalid(code);
  if (!value.trim()) throw invalid(code);
  return value;
}

function validateNotificationPolicy(value) {
  if (value === null) return null;
  if (!NOTIFICATION_POLICIES.includes(value)) throw invalid("INVALID_NOTIFICATION_POLICY");
  return value;
}

function validateIntervalMinutes(value) {
  if (typeof value !== "number" || !Number.isInteger(value)) throw invalid("INVALID_INTERVAL");
  if (value < MIN_HEARTBEAT_INTERVAL_MINUTES || value > MAX_HEARTBEAT_INTERVAL_MINUTES) throw invalid("INVALID_INTERVAL");
  return value;
}

export function validateHeartbeatCreateParams(params) {
  requirePlainObject(params);
  assertKnownKeys(params, ["name", "prompt", "intervalMinutes", "status", "notificationPolicy"]);
  const out = {
    name: validateBoundedText(params.name, MAX_HEARTBEAT_NAME_CHARS, "INVALID_HEARTBEAT_NAME"),
    prompt: validateBoundedText(params.prompt, MAX_HEARTBEAT_PROMPT_CHARS, "INVALID_HEARTBEAT_PROMPT"),
    intervalMinutes: validateIntervalMinutes(params.intervalMinutes)
  };
  if (Object.hasOwn(params, "status")) {
    if (!HEARTBEAT_STATUSES.includes(params.status)) throw invalid("INVALID_HEARTBEAT_STATUS");
    out.status = params.status;
  }
  if (Object.hasOwn(params, "notificationPolicy")) out.notificationPolicy = validateNotificationPolicy(params.notificationPolicy);
  return out;
}

export function validateHeartbeatUpdateParams(params) {
  requirePlainObject(params);
  assertKnownKeys(params, ["id", "name", "prompt", "intervalMinutes", "status", "notificationPolicy"]);
  const out = { id: validateAutomationId(params.id) };
  if (Object.hasOwn(params, "name")) out.name = validateBoundedText(params.name, MAX_HEARTBEAT_NAME_CHARS, "INVALID_HEARTBEAT_NAME");
  if (Object.hasOwn(params, "prompt")) out.prompt = validateBoundedText(params.prompt, MAX_HEARTBEAT_PROMPT_CHARS, "INVALID_HEARTBEAT_PROMPT");
  if (Object.hasOwn(params, "intervalMinutes")) out.intervalMinutes = validateIntervalMinutes(params.intervalMinutes);
  if (Object.hasOwn(params, "status")) {
    if (!HEARTBEAT_STATUSES.includes(params.status)) throw invalid("INVALID_HEARTBEAT_STATUS");
    out.status = params.status;
  }
  if (Object.hasOwn(params, "notificationPolicy")) out.notificationPolicy = validateNotificationPolicy(params.notificationPolicy);
  if (Object.keys(out).length === 1) throw invalid("NO_HEARTBEAT_CHANGES");
  return out;
}

export function validateHeartbeatIdParams(params) {
  requirePlainObject(params);
  assertKnownKeys(params, ["id"]);
  return { id: validateAutomationId(params.id) };
}

export function validateHeartbeatListParams(params) {
  requirePlainObject(params);
  assertKnownKeys(params, []);
  return {};
}

const READ_ACTIONS = new Set(["goal.get", "heartbeat.list", "heartbeat.view"]);

// Static, allowlisted action registry. `validate` is always a per-action function; `execute` in
// native-actions.js has no generic fallthrough to native RPC.
export const ACTION_DEFINITIONS = Object.freeze([
  Object.freeze({ id: "goal.get", kind: "goal", mutating: false, destructive: false, requiresConfirmation: false, validate: validateGoalClearParams }),
  Object.freeze({ id: "goal.set", kind: "goal", mutating: true, destructive: false, requiresConfirmation: false, validate: validateGoalSetParams }),
  Object.freeze({ id: "goal.pause", kind: "goal", mutating: true, destructive: false, requiresConfirmation: false, validate: validateGoalStatusParams }),
  Object.freeze({ id: "goal.resume", kind: "goal", mutating: true, destructive: false, requiresConfirmation: false, validate: validateGoalStatusParams }),
  Object.freeze({ id: "goal.clear", kind: "goal", mutating: true, destructive: true, requiresConfirmation: true, validate: validateGoalClearParams }),
  Object.freeze({ id: "thread.pin", kind: "pin", mutating: true, destructive: false, requiresConfirmation: false, validate: validatePinParams }),
  Object.freeze({ id: "thread.unpin", kind: "pin", mutating: true, destructive: false, requiresConfirmation: false, validate: validatePinParams }),
  Object.freeze({ id: "heartbeat.list", kind: "heartbeat", mutating: false, destructive: false, requiresConfirmation: false, validate: validateHeartbeatListParams }),
  Object.freeze({ id: "heartbeat.view", kind: "heartbeat", mutating: false, destructive: false, requiresConfirmation: false, validate: validateHeartbeatIdParams }),
  Object.freeze({ id: "heartbeat.create", kind: "heartbeat", mutating: true, destructive: false, requiresConfirmation: false, validate: validateHeartbeatCreateParams }),
  Object.freeze({ id: "heartbeat.update", kind: "heartbeat", mutating: true, destructive: false, requiresConfirmation: false, validate: validateHeartbeatUpdateParams }),
  Object.freeze({ id: "heartbeat.pause", kind: "heartbeat", mutating: true, destructive: false, requiresConfirmation: false, validate: validateHeartbeatIdParams }),
  Object.freeze({ id: "heartbeat.resume", kind: "heartbeat", mutating: true, destructive: false, requiresConfirmation: false, validate: validateHeartbeatIdParams }),
  Object.freeze({ id: "heartbeat.delete", kind: "heartbeat", mutating: true, destructive: true, requiresConfirmation: true, validate: validateHeartbeatIdParams })
]);

const ACTION_MAP = new Map(ACTION_DEFINITIONS.map(definition => [definition.id, definition]));

export function getActionDefinition(action) {
  return typeof action === "string" ? ACTION_MAP.get(action) || null : null;
}

// Safe metadata only: no RRULE, prompts, ids or native raw data.
export function describeActions() {
  return ACTION_DEFINITIONS.map(definition => ({
    id: definition.id,
    kind: definition.kind,
    mutating: definition.mutating,
    destructive: definition.destructive,
    requiresConfirmation: definition.requiresConfirmation
  }));
}

export const isReadAction = action => READ_ACTIONS.has(action);

// Capability matrix backed by the contracts above. `unsupported` items are intentionally not
// exposed as executable actions; a future module must prove them before adding registry entries.
export const NATIVE_CAPABILITIES = Object.freeze({
  goal: Object.freeze({
    supported: true,
    methods: Object.freeze(Object.values(THREAD_GOAL_METHODS)),
    userStatuses: USER_GOAL_STATUSES,
    maxObjectiveChars: MAX_OBJECTIVE_CHARS
  }),
  pin: Object.freeze({
    supported: true,
    tool: CODEX_APP_TOOLS.moveThreadToSidebarSection,
    sections: Object.freeze(["pinned", null])
  }),
  heartbeat: Object.freeze({
    supported: true,
    tool: CODEX_APP_TOOLS.automationUpdate,
    modes: Object.freeze(["create", "view", "update", "delete"]),
    statuses: HEARTBEAT_STATUSES,
    scheduler: "native-automation-only"
  }),
  unsupported: Object.freeze(["loop-scheduler"])
});

export async function authorizeThreadTarget({ authorizeThread, scope, threadId }) {
  validateThreadId(threadId);
  if (typeof authorizeThread !== "function") throw nativeFail(403, "AUTHORIZATION_REQUIRED");
  let thread;
  try {
    thread = await authorizeThread(scope, threadId);
  } catch (error) {
    if (isNativeActionError(error)) throw error;
    throw nativeFail(403, "THREAD_FORBIDDEN");
  }
  if (!isPlainObject(thread) || thread.id !== threadId) throw nativeFail(403, "THREAD_FORBIDDEN");
  if (typeof thread.cwd !== "string" || !thread.cwd) throw nativeFail(403, "THREAD_FORBIDDEN");
  return thread;
}

// Builds the only allowed MCP call shape. Server id and tool name come from module constants;
// client-supplied server/tool/_meta/hostId can never reach the bridge through this helper.
export function callCodexAppTool({ callNative, threadId, tool, arguments: args }) {
  if (typeof callNative !== "function") throw nativeFail(500, "NATIVE_UNAVAILABLE");
  if (!ALLOWED_CODEX_APP_TOOLS.has(tool)) throw nativeFail(500, "TOOL_NOT_ALLOWED");
  requirePlainObject(args, "INVALID_ARGUMENTS");
  return callNative("mcpServer/tool/call", {
    server: MCP_SERVER_ID,
    threadId,
    tool,
    arguments: args
  });
}

export function nativeFailure(error) {
  if (isNativeActionError(error)) return error;
  const code = String(error?.code ?? "");
  const message = String(error?.message ?? "");
  if (code === "-32601" || code === "METHOD_NOT_FOUND" || /method\s*not\s*found|not\s*supported|unsupported/i.test(message)) {
    return nativeFail(501, "NATIVE_UNSUPPORTED", { nativeCode: code || null });
  }
  return nativeFail(502, "NATIVE_FAILURE", { nativeCode: code || null });
}

// MCP result is {content, isError}. Anything else, or isError!==false, is a typed safe failure.
export function parseToolResult(result) {
  if (!isPlainObject(result)) throw nativeFail(502, "NATIVE_INVALID_RESULT");
  if (result.isError !== false) {
    if (result.isError === true) throw nativeFail(502, "NATIVE_TOOL_ERROR");
    throw nativeFail(502, "NATIVE_INVALID_RESULT");
  }
  const content = Array.isArray(result.content) ? result.content : [];
  const texts = [];
  for (const entry of content) {
    if (isPlainObject(entry) && entry.type === "text" && typeof entry.text === "string") texts.push(entry.text);
  }
  if (!texts.length) throw nativeFail(502, "NATIVE_INVALID_RESULT");
  const text = texts.join("\n");
  let json = null;
  if (text.length <= 2 * 1048576) {
    try {
      const parsed = JSON.parse(text);
      if (isPlainObject(parsed) || Array.isArray(parsed)) json = parsed;
    } catch {
      json = null;
    }
  }
  return { json, text };
}

// Human-facing ack text is never proxied; only used to classify a first-party tool result.
export function isSafeAckText(text) {
  return typeof text === "string"
    && text.length > 0
    && text.length <= 200
    && !/[\x00-\x1f\x7f]/.test(text)
    && !/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.test(text);
}

const GOAL_USAGE_KEYS = Object.freeze([
  "tokensUsed",
  "tokensRemaining",
  "timeUsedSeconds",
  "timeUsedMs",
  "elapsedSeconds",
  "elapsedMs",
  "turnCount"
]);

function safeTimestamp(value) {
  if (typeof value === "string" && value.length > 0 && value.length <= 64) return value;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  return null;
}

function safeUsageValue(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

// Returns only safe, allowlisted goal fields plus a UI state version. Usage counters are excluded
// from the version on purpose: they increment on their own and must not invalidate user edits.
export function parseGoalResult(result) {
  if (result === null || result === undefined) return { goal: null, version: GOAL_VERSION_NONE };
  if (!isPlainObject(result)) throw nativeFail(502, "INVALID_NATIVE_RESULT");
  const raw = Object.hasOwn(result, "goal") ? result.goal : result;
  if (raw === null || raw === undefined) return { goal: null, version: GOAL_VERSION_NONE };
  if (!isPlainObject(raw)) throw nativeFail(502, "INVALID_NATIVE_RESULT");
  if (!GOAL_STATUSES.includes(raw.status)) throw nativeFail(502, "INVALID_NATIVE_RESULT");

  let objective = null;
  if (raw.objective !== undefined && raw.objective !== null) {
    if (typeof raw.objective !== "string" || objectiveLength(raw.objective) > MAX_OBJECTIVE_CHARS) {
      throw nativeFail(502, "INVALID_NATIVE_RESULT");
    }
    objective = raw.objective;
  }

  let tokenBudget = null;
  if (raw.tokenBudget !== undefined && raw.tokenBudget !== null) {
    if (!Number.isSafeInteger(raw.tokenBudget) || raw.tokenBudget < 0) throw nativeFail(502, "INVALID_NATIVE_RESULT");
    tokenBudget = raw.tokenBudget;
  }

  let origin = null;
  if (raw.origin !== undefined && raw.origin !== null) {
    if (raw.origin !== "user" && raw.origin !== "automatic") throw nativeFail(502, "INVALID_NATIVE_RESULT");
    origin = raw.origin;
  }

  const createdAt = safeTimestamp(raw.createdAt);
  const updatedAt = safeTimestamp(raw.updatedAt);

  const usageSource = isPlainObject(raw.usage) ? raw.usage : null;
  const usage = {};
  for (const key of GOAL_USAGE_KEYS) {
    const value = safeUsageValue(raw[key] ?? usageSource?.[key]);
    if (value !== null) usage[key] = value;
  }

  const goal = {
    objective,
    status: raw.status,
    tokenBudget,
    origin,
    createdAt,
    updatedAt,
    usage
  };
  const version = digest({ objective, status: goal.status, tokenBudget, createdAt });
  return { goal, version };
}
