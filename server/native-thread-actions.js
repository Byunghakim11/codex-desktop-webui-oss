import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  MCP_SERVER_ID,
  assertKnownKeys,
  isNativeActionError,
  isPlainObject,
  nativeFail,
  nativeFailure,
  parseToolResult,
  requirePlainObject,
  validateRequestId,
  validateThreadId
} from "./native-capabilities.js";
import { createConfirmationStore, digestParams, digestState, principalFromScope } from "./native-confirmations.js";

// Standalone Native thread actions backend. This module owns a HARD, static action -> MCP tool
// mapping. There is no path from client input to a raw tool name, MCP server id, host id, source,
// `_meta`, or arbitrary RPC method. Every call is shaped here from module constants plus validated
// fields only.
//
// MCP contract verified against the Desktop bridge: mcpServer/tool/call
// {server:'codex_app', threadId, tool, arguments}. The result is {content, isError}; only
// isError===false with at least one text part is accepted, and JSON ack text is never treated as
// success for high-risk actions unless an explicit native field proves it.

export const NATIVE_THREAD_TOOLS = Object.freeze({
  setThreadTitle: "set_thread_title",
  setThreadReadState: "set_thread_read_state",
  setThreadArchived: "set_thread_archived",
  forkThread: "fork_thread",
  listProjects: "list_projects",
  moveThreadToProject: "move_thread_to_project",
  shareThread: "share_thread",
  deleteThread: "delete_thread"
});

const SAFE_ID = /^[A-Za-z0-9._:-]{1,200}$/;
const MAX_TITLE_CHARS = 300;
const MAX_PROJECT_LIST = 500;
const MAX_PROJECT_NAME_CHARS = 200;
const MAX_PROJECT_PATH_CHARS = 4096;
const MAX_THREAD_NAME_CHARS = 600; // 300 Unicode code points can occupy 600 UTF-16 units.
const LEDGER_VERSION = 1;
const SHARE_HOSTS = new Set(["chatgpt.com", "www.chatgpt.com"]);

// ---------------------------------------------------------------------------------------------
// Param validation. Each action has its own validator that rejects unknown keys (POST bodies may
// never smuggle hostId, source, server, tool, _meta, beforeThreadId or client paths).
// ---------------------------------------------------------------------------------------------

function validateEmptyParams(params) {
  requirePlainObject(params);
  assertKnownKeys(params, []);
  return {};
}

function validateRenameParams(params) {
  requirePlainObject(params);
  assertKnownKeys(params, ["title"]);
  if (!Object.hasOwn(params, "title")) throw nativeFail(400, "INVALID_TITLE");
  const { title } = params;
  if (typeof title !== "string") throw nativeFail(400, "INVALID_TITLE");
  if (!title.trim()) throw nativeFail(400, "INVALID_TITLE");
  if (Array.from(title).length > MAX_TITLE_CHARS) throw nativeFail(400, "TITLE_TOO_LONG");
  return { title };
}

function validateProjectMoveParams(params) {
  requirePlainObject(params);
  assertKnownKeys(params, ["projectId"]);
  if (!Object.hasOwn(params, "projectId")) throw nativeFail(400, "INVALID_PROJECT_ID");
  const { projectId } = params;
  if (projectId === null) return { projectId: null };
  if (typeof projectId !== "string" || !SAFE_ID.test(projectId)) throw nativeFail(400, "INVALID_PROJECT_ID");
  return { projectId };
}

function validateShareParams(params) {
  requirePlainObject(params);
  assertKnownKeys(params, ["reviewed"]);
  if (params.reviewed !== true) throw nativeFail(400, "REVIEW_REQUIRED");
  return { reviewed: true };
}

function validateDeleteParams(params) {
  requirePlainObject(params);
  assertKnownKeys(params, ["confirmationText"]);
  const { confirmationText } = params;
  if (typeof confirmationText !== "string" || !confirmationText || confirmationText.length > 512) {
    throw nativeFail(400, "INVALID_CONFIRMATION_TEXT");
  }
  return { confirmationText };
}

// ---------------------------------------------------------------------------------------------
// Static action registry.
// ---------------------------------------------------------------------------------------------

const ACTION_DEFINITIONS = Object.freeze([
  Object.freeze({ id: "thread.rename", mutating: true, destructive: false, requiresConfirmation: false, requiresRequestId: false, externalSnapshot: false, tool: NATIVE_THREAD_TOOLS.setThreadTitle, validate: validateRenameParams }),
  Object.freeze({ id: "thread.read", mutating: true, destructive: false, requiresConfirmation: false, requiresRequestId: false, externalSnapshot: false, tool: NATIVE_THREAD_TOOLS.setThreadReadState, validate: validateEmptyParams }),
  Object.freeze({ id: "thread.unread", mutating: true, destructive: false, requiresConfirmation: false, requiresRequestId: false, externalSnapshot: false, tool: NATIVE_THREAD_TOOLS.setThreadReadState, validate: validateEmptyParams }),
  Object.freeze({ id: "thread.archive", mutating: true, destructive: false, requiresConfirmation: false, requiresRequestId: false, externalSnapshot: false, tool: NATIVE_THREAD_TOOLS.setThreadArchived, validate: validateEmptyParams }),
  Object.freeze({ id: "thread.unarchive", mutating: true, destructive: false, requiresConfirmation: false, requiresRequestId: false, externalSnapshot: false, tool: NATIVE_THREAD_TOOLS.setThreadArchived, validate: validateEmptyParams }),
  Object.freeze({ id: "thread.fork", mutating: true, destructive: false, requiresConfirmation: false, requiresRequestId: true, externalSnapshot: false, tool: NATIVE_THREAD_TOOLS.forkThread, validate: validateEmptyParams }),
  Object.freeze({ id: "thread.project.list", mutating: false, destructive: false, requiresConfirmation: false, requiresRequestId: false, externalSnapshot: false, tool: NATIVE_THREAD_TOOLS.listProjects, validate: validateEmptyParams }),
  Object.freeze({ id: "thread.project.move", mutating: true, destructive: false, requiresConfirmation: false, requiresRequestId: false, externalSnapshot: false, tool: NATIVE_THREAD_TOOLS.moveThreadToProject, validate: validateProjectMoveParams }),
  Object.freeze({ id: "thread.share", mutating: true, destructive: false, requiresConfirmation: true, requiresRequestId: true, externalSnapshot: true, tool: NATIVE_THREAD_TOOLS.shareThread, validate: validateShareParams }),
  Object.freeze({ id: "thread.delete", mutating: true, destructive: true, requiresConfirmation: true, requiresRequestId: true, externalSnapshot: false, tool: NATIVE_THREAD_TOOLS.deleteThread, validate: validateDeleteParams })
]);
const ACTION_MAP = new Map(ACTION_DEFINITIONS.map(definition => [definition.id, definition]));

// ---------------------------------------------------------------------------------------------
// Pure helpers.
// ---------------------------------------------------------------------------------------------

function safeThreadName(thread) {
  if (typeof thread?.name === "string" && thread.name.length > 0 && thread.name.length <= MAX_THREAD_NAME_CHARS) return thread.name;
  if (typeof thread?.title === "string" && thread.title.length > 0 && thread.title.length <= MAX_THREAD_NAME_CHARS) return thread.title;
  return null;
}

// Only safe, allowlisted thread fields ever leave this module.
function sanitizeThread(thread) {
  const out = { id: thread.id, cwd: thread.cwd };
  const name = safeThreadName(thread);
  if (name !== null) out.name = name;
  const updatedAt = thread.updatedAt;
  if (typeof updatedAt === "string" && updatedAt.length > 0 && updatedAt.length <= 64) out.updatedAt = updatedAt;
  else if (typeof updatedAt === "number" && Number.isFinite(updatedAt) && updatedAt >= 0) out.updatedAt = updatedAt;
  if (typeof thread.status === "string" && thread.status.length > 0 && thread.status.length <= 64) out.status = thread.status;
  return out;
}

// State version bound into confirmations for share/delete. Usage counters are deliberately absent.
function threadStateDigest(thread) {
  return digestState({
    id: thread.id,
    cwd: thread.cwd,
    name: safeThreadName(thread),
    updatedAt: thread.updatedAt ?? null,
    status: thread.status ?? null
  });
}

function scopeFilterRoots(scope) {
  if (Array.isArray(scope?.threadFilterCwds)) {
    const roots = scope.threadFilterCwds.filter(root => typeof root === "string" && root.length > 0);
    if (roots.length) return roots;
  }
  if (typeof scope?.threadFilterCwd === "string" && scope.threadFilterCwd.length > 0) return [scope.threadFilterCwd];
  return [];
}

// A token with no filter roots is a global owner; otherwise it is folder-scoped.
function isFolderScoped(scope) {
  return scopeFilterRoots(scope).length > 0;
}

function isPathInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

// Deny-if-unknown is intentional: a folder-scoped token may only target a project whose real path
// is provably inside one of its allowed roots. A missing/unreadable path is rejected.
async function projectPathAllowed(scope, projectPath) {
  const roots = scopeFilterRoots(scope);
  if (!roots.length) return true;
  if (typeof projectPath !== "string" || !projectPath) return false;
  const realProject = await fs.realpath(projectPath).catch(() => null);
  if (!realProject) return false;
  for (const root of roots) {
    const realRoot = await fs.realpath(root).catch(() => null);
    if (realRoot && isPathInside(realRoot, realProject)) return true;
  }
  return false;
}

// Parses only validated Codex project ids/names/paths. Never leaks raw project/account payloads.
function parseProjectList(parsed) {
  const json = parsed?.json;
  let list;
  if (Array.isArray(json)) list = json;
  else if (isPlainObject(json) && Array.isArray(json.projects)) list = json.projects;
  else throw nativeFail(501, "NATIVE_UNSUPPORTED");
  const out = [];
  for (const entry of list.slice(0, MAX_PROJECT_LIST)) {
    if (!isPlainObject(entry)) continue;
    if (typeof entry.id !== "string" || !SAFE_ID.test(entry.id)) continue;
    const project = { id: entry.id };
    if (typeof entry.name === "string" && entry.name.length > 0 && entry.name.length <= MAX_PROJECT_NAME_CHARS) project.name = entry.name;
    if (typeof entry.path === "string" && entry.path.length > 0 && entry.path.length <= MAX_PROJECT_PATH_CHARS) project.path = entry.path;
    out.push(project);
  }
  return out;
}

function extractForkChildId(parsed) {
  const json = parsed?.json;
  if (!isPlainObject(json)) return null;
  const fromObject = value => {
    if (!isPlainObject(value)) return null;
    for (const key of ["id", "threadId"]) {
      const candidate = value[key];
      if (typeof candidate === "string") {
        try {
          return validateThreadId(candidate);
        } catch {
          return null;
        }
      }
    }
    return null;
  };
  const nested = fromObject(json.child) || fromObject(json.thread) || fromObject(json.forkedThread) || fromObject(json.newThread);
  if (nested) return nested;
  for (const key of ["childId", "newThreadId", "forkedThreadId", "childThreadId"]) {
    const candidate = json[key];
    if (typeof candidate === "string") {
      try {
        return validateThreadId(candidate);
      } catch {
        return null;
      }
    }
  }
  return null;
}

const PENDING_STATUSES = new Set(["pending", "awaiting_approval", "awaitingapproval", "needs_approval", "requires_approval", "unconfirmed", "approval_required"]);

function isPendingParsed(parsed) {
  const json = parsed?.json;
  if (!isPlainObject(json)) return false;
  if (typeof json.status === "string" && PENDING_STATUSES.has(json.status.toLowerCase())) return true;
  if (json.requiresApproval === true || json.approvalRequired === true) return true;
  if (json.approved === false) return true;
  if (typeof json.approval === "string" && PENDING_STATUSES.has(json.approval.toLowerCase())) return true;
  return false;
}

function isDeletedParsed(parsed) {
  const json = parsed?.json;
  if (!isPlainObject(json)) return false;
  if (json.deleted === true || json.removed === true) return true;
  return typeof json.status === "string" && ["deleted", "removed"].includes(json.status.toLowerCase());
}

function sanitizeShareUrl(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  // An official share link is served on the default HTTPS port only.
  if (url.port && url.port !== "443") return null;
  if (!SHARE_HOSTS.has(url.hostname.toLowerCase())) return null;
  if (!url.pathname.startsWith("/share/") || url.pathname.length <= 7) return null;
  return url.toString();
}

// Only a bounded set of known share fields is consulted; hosts/credentials are validated above.
function extractShareUrl(parsed) {
  const json = parsed?.json;
  if (!isPlainObject(json)) return null;
  const candidates = [json.url, json.shareUrl, json.shareURL, json.link, json.shareLink];
  if (isPlainObject(json.share)) candidates.push(json.share.url, json.share.shareUrl, json.share.link);
  for (const candidate of candidates) {
    const safe = sanitizeShareUrl(candidate);
    if (safe) return safe;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Side-effect ledger for fork/share/delete. A requestId is claimed with an exclusive (wx) create
// before the native call so a concurrent duplicate can never fire a second native mutation. It is
// not an exactly-once guarantee: a claimed-but-unconfirmed outcome is recorded as `unknown` and is
// never auto-retried.
// ---------------------------------------------------------------------------------------------

function ledgerDir(dataDir) {
  return path.join(dataDir, "native-thread-actions");
}

function ledgerFile(dir, principal, requestId) {
  const key = createHash("sha256").update(`${principal}\u0000${requestId}`).digest("hex");
  return path.join(dir, `${key}.json`);
}

function sameLedgerBinding(record, binding) {
  return record
    && record.version === LEDGER_VERSION
    && record.principal === binding.principal
    && record.action === binding.action
    && record.threadId === binding.threadId
    && record.paramsHash === binding.paramsHash;
}

async function readLedgerFile(file) {
  let raw;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw nativeFail(500, "LEDGER_UNAVAILABLE");
  }
  try {
    return JSON.parse(raw);
  } catch {
    // A partial write can only mean a concurrent claim we cannot safely inspect.
    throw nativeFail(503, "NATIVE_OUTCOME_UNKNOWN");
  }
}

async function writeLedgerFile(file, record) {
  try {
    await fs.writeFile(file, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  } catch {
    throw nativeFail(500, "LEDGER_UNAVAILABLE");
  }
}

// ---------------------------------------------------------------------------------------------
// Service.
// ---------------------------------------------------------------------------------------------

export function createNativeThreadActionsService({ callNative, authorizeThread, dataDir, confirmations = null, now = () => Date.now() } = {}) {
  if (typeof callNative !== "function") throw nativeFail(500, "NATIVE_UNAVAILABLE");
  if (typeof authorizeThread !== "function") throw nativeFail(403, "AUTHORIZATION_REQUIRED");
  if (typeof dataDir !== "string" || !dataDir) throw nativeFail(500, "DATA_DIR_REQUIRED");

  const confirmationsStore = confirmations || createConfirmationStore({ dataDir, now });

  const supports = action => typeof action === "string" && ACTION_MAP.has(action);

  // Fresh authorization before every read/mutation. The root authorizeThread verifies the actual
  // native thread, current token, Access and root filter; there is no default-allow path.
  async function requireThread(scope, threadId) {
    validateThreadId(threadId);
    let thread;
    try {
      thread = await authorizeThread(scope, threadId);
    } catch (error) {
      if (isNativeActionError(error)) throw error;
      if (typeof error?.status === "number" && typeof error?.code === "string") throw nativeFail(error.status, error.code);
      throw nativeFail(403, "THREAD_FORBIDDEN");
    }
    if (!isPlainObject(thread) || thread.id !== threadId) throw nativeFail(403, "THREAD_FORBIDDEN");
    if (typeof thread.cwd !== "string" || !thread.cwd) throw nativeFail(403, "THREAD_FORBIDDEN");
    return sanitizeThread(thread);
  }

  // Re-authorize immediately before an MCP mutation and refuse a swapped context.
  async function authorizeStable(scope, thread) {
    const fresh = await requireThread(scope, thread.id);
    if (fresh.cwd !== thread.cwd) throw nativeFail(409, "THREAD_CONTEXT_CHANGED");
    return fresh;
  }

  // The only path to the bridge. Server id, tool and args are shaped here from constants and
  // validated fields; the caller cannot inject a tool/server/host/_meta.
  async function callTool(thread, tool, args) {
    let result;
    try {
      result = await callNative("mcpServer/tool/call", {
        server: MCP_SERVER_ID,
        threadId: thread.id,
        tool,
        arguments: args
      });
    } catch (error) {
      throw nativeFailure(error);
    }
    return parseToolResult(result);
  }

  function normalizedRequestId(requestId) {
    if (requestId === undefined || requestId === null) throw nativeFail(400, "REQUEST_ID_REQUIRED");
    return validateRequestId(requestId);
  }

  async function claimLedger({ scope, requestId, action, threadId, params }) {
    const principal = principalFromScope(scope);
    const binding = { principal, action, threadId, paramsHash: digestParams(params) };
    const dir = ledgerDir(dataDir);
    const file = ledgerFile(dir, principal, requestId);

    const existing = await readLedgerFile(file);
    if (existing) {
      if (!sameLedgerBinding(existing, binding)) throw nativeFail(409, "REQUEST_ID_CONFLICT");
      if (existing.status === "success") return { replayed: true, result: existing.result };
      throw nativeFail(503, "NATIVE_OUTCOME_UNKNOWN");
    }

    await fs.mkdir(dir, { recursive: true, mode: 0o700 }).catch(() => {
      throw nativeFail(500, "LEDGER_UNAVAILABLE");
    });
    const record = { version: LEDGER_VERSION, ...binding, status: "pending", createdAt: now() };
    try {
      await fs.writeFile(file, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    } catch (error) {
      if (error?.code !== "EEXIST") throw nativeFail(500, "LEDGER_UNAVAILABLE");
      const racing = await readLedgerFile(file);
      if (racing) {
        if (!sameLedgerBinding(racing, binding)) throw nativeFail(409, "REQUEST_ID_CONFLICT");
        if (racing.status === "success") return { replayed: true, result: racing.result };
      }
      throw nativeFail(503, "NATIVE_OUTCOME_UNKNOWN");
    }
    return { replayed: false, file };
  }

  async function commitLedger(file, result) {
    const record = await readLedgerFile(file);
    if (!record) return;
    await writeLedgerFile(file, { ...record, status: "success", result, completedAt: now() });
  }

  async function markLedgerUnknown(file) {
    const record = await readLedgerFile(file).catch(() => null);
    if (!record) return;
    await writeLedgerFile(file, { ...record, status: "unknown", failedAt: now() }).catch(() => {});
  }

  // Only for failures that provably happened BEFORE any native call (safe to release the claim).
  async function releaseLedger(file) {
    await fs.unlink(file).catch(() => {});
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

  async function readProjects(scope, thread) {
    await authorizeStable(scope, thread);
    const parsed = await callTool(thread, NATIVE_THREAD_TOOLS.listProjects, {});
    return parseProjectList(parsed);
  }

  // -------------------------------------------------------------------------------------------
  // Action handlers.
  // -------------------------------------------------------------------------------------------

  async function renameThread(scope, thread, normalized) {
    await authorizeStable(scope, thread);
    await callTool(thread, NATIVE_THREAD_TOOLS.setThreadTitle, { source: "codex", threadId: thread.id, title: normalized.title });
    let verified = null;
    try {
      const after = await requireThread(scope, thread.id);
      const name = safeThreadName(after);
      if (name !== null) verified = name === normalized.title;
    } catch {
      verified = null;
    }
    if (verified === false) throw nativeFail(409, "RENAME_NOT_APPLIED");
    return { ok: true, action: "thread.rename", threadId: thread.id, title: normalized.title, verified };
  }

  async function setReadState(scope, thread, read, action) {
    await authorizeStable(scope, thread);
    await callTool(thread, NATIVE_THREAD_TOOLS.setThreadReadState, { source: "codex", threadId: thread.id, read });
    return { ok: true, action, threadId: thread.id, read };
  }

  async function setArchived(scope, thread, archived, action) {
    if (isFolderScoped(scope)) throw nativeFail(403, "THREAD_SCOPE_FORBIDDEN");
    await authorizeStable(scope, thread);
    await callTool(thread, NATIVE_THREAD_TOOLS.setThreadArchived, { source: "codex", threadId: thread.id, archived });
    return { ok: true, action, threadId: thread.id, archived };
  }

  async function listProjects(scope, thread) {
    const projects = await readProjects(scope, thread);
    const visible=[];
    for(const project of projects)if(await projectPathAllowed(scope,project.path))visible.push(project);
    return { ok: true, action: "thread.project.list", threadId: thread.id, projects:visible };
  }

  async function moveToProject(scope, thread, normalized) {
    const { projectId } = normalized;
    if (projectId !== null) {
      const projects = await readProjects(scope, thread);
      const match = projects.find(project => project.id === projectId);
      if (!match) throw nativeFail(404, "PROJECT_NOT_FOUND");
      if (!(await projectPathAllowed(scope, match.path))) throw nativeFail(403, "PROJECT_FORBIDDEN");
    }
    await authorizeStable(scope, thread);
    await callTool(thread, NATIVE_THREAD_TOOLS.moveThreadToProject, { source: "codex", threadId: thread.id, projectId });
    return { ok: true, action: "thread.project.move", threadId: thread.id, projectId };
  }

  async function forkThread(scope, thread, requestId) {
    const claim = await claimLedger({ scope, requestId, action: "thread.fork", threadId: thread.id, params: {} });
    if (claim.replayed) return { ...claim.result, replayed: true };
    const file = claim.file;
    try {
      await authorizeStable(scope, thread);
    } catch (error) {
      await releaseLedger(file);
      throw error;
    }

    let parsed;
    try {
      // Only fork_thread is called. No message/send/turn-start is ever issued for a fork.
      parsed = await callTool(thread, NATIVE_THREAD_TOOLS.forkThread, { threadId: thread.id, environment: { type: "same-directory" } });
    } catch {
      await markLedgerUnknown(file);
      throw nativeFail(503, "NATIVE_OUTCOME_UNKNOWN");
    }
    if (isPendingParsed(parsed)) {
      await markLedgerUnknown(file);
      return { ok: false, action: "thread.fork", threadId: thread.id, status: "pending", childThreadId: null };
    }

    const childId = extractForkChildId(parsed);
    if (!childId) {
      // No verified child id in the native result (ack text, an approval hand-off, or an
      // unrecognized shape): a fork may have happened, so never claim completion.
      await markLedgerUnknown(file);
      return { ok: false, action: "thread.fork", threadId: thread.id, status: "unknown", childThreadId: null };
    }
    let childThreadId = null;
    let childVerified = null;
    try {
      const child = await requireThread(scope, childId);
      if (child.cwd !== thread.cwd) throw nativeFail(409, "FORK_CHILD_UNVERIFIED");
      childThreadId = child.id;
      childVerified = true;
    } catch (error) {
      await markLedgerUnknown(file);
      if (isNativeActionError(error) && error.code === "FORK_CHILD_UNVERIFIED") throw error;
      throw nativeFail(409, "FORK_CHILD_UNVERIFIED");
    }

    const result = { ok: true, action: "thread.fork", threadId: thread.id, childThreadId, childVerified };
    await commitLedger(file, result);
    return result;
  }

  async function shareThread(scope, thread, normalized, { confirmationId, requestId }) {
    if (isFolderScoped(scope)) throw nativeFail(403, "THREAD_SCOPE_FORBIDDEN");
    if (typeof confirmationId !== "string" || !confirmationId) throw nativeFail(400, "CONFIRMATION_REQUIRED");
    const stateDigest = threadStateDigest(thread);
    const claim = await claimLedger({ scope, requestId, action: "thread.share", threadId: thread.id, params: normalized });
    if (claim.replayed) return { ...claim.result, replayed: true };
    const file = claim.file;

    // Fresh state again right before the single-use confirmation and MCP call.
    let fresh;
    try {
      fresh = await authorizeStable(scope, thread);
    } catch (error) {
      await releaseLedger(file);
      throw error;
    }
    if (threadStateDigest(fresh) !== stateDigest) {
      await releaseLedger(file);
      throw nativeFail(409, "CONFIRMATION_STALE");
    }
    try {
      await consumeConfirmation({ scope, action: "thread.share", threadId: thread.id, params: normalized, confirmationId, stateDigest });
    } catch (error) {
      await releaseLedger(file);
      throw error;
    }

    let parsed;
    try {
      parsed = await callTool(thread, NATIVE_THREAD_TOOLS.shareThread, { threadId: thread.id });
    } catch {
      await markLedgerUnknown(file);
      throw nativeFail(503, "NATIVE_OUTCOME_UNKNOWN");
    }
    const shareUrl = extractShareUrl(parsed);
    if (shareUrl) {
      const result = { ok: true, action: "thread.share", threadId: thread.id, shareUrl };
      await commitLedger(file, result);
      return result;
    }
    await markLedgerUnknown(file);
    if (isPendingParsed(parsed)) return { ok: false, action: "thread.share", threadId: thread.id, status: "pending" };
    return { ok: false, action: "thread.share", threadId: thread.id, status: "unknown" };
  }

  async function deleteThread(scope, thread, normalized, { confirmationId, requestId }) {
    if (isFolderScoped(scope)) throw nativeFail(403, "THREAD_SCOPE_FORBIDDEN");
    if (typeof confirmationId !== "string" || !confirmationId) throw nativeFail(400, "CONFIRMATION_REQUIRED");
    const name = safeThreadName(thread);
    if (normalized.confirmationText !== thread.id && normalized.confirmationText !== name) {
      throw nativeFail(400, "CONFIRMATION_TEXT_MISMATCH");
    }
    const stateDigest = threadStateDigest(thread);
    const claim = await claimLedger({ scope, requestId, action: "thread.delete", threadId: thread.id, params: normalized });
    if (claim.replayed) return { ...claim.result, replayed: true };
    const file = claim.file;

    let fresh;
    try {
      fresh = await authorizeStable(scope, thread);
    } catch (error) {
      await releaseLedger(file);
      throw error;
    }
    if (threadStateDigest(fresh) !== stateDigest) {
      await releaseLedger(file);
      throw nativeFail(409, "CONFIRMATION_STALE");
    }
    try {
      await consumeConfirmation({ scope, action: "thread.delete", threadId: thread.id, params: normalized, confirmationId, stateDigest });
    } catch (error) {
      await releaseLedger(file);
      throw error;
    }

    let parsed;
    try {
      // Native itself enforces the composer approval for the named chat; we never forge _meta,
      // approval, or a token. Subagent/side chats are native's responsibility.
      parsed = await callTool(thread, NATIVE_THREAD_TOOLS.deleteThread, { source: "codex", threadId: thread.id });
    } catch {
      await markLedgerUnknown(file);
      throw nativeFail(503, "NATIVE_OUTCOME_UNKNOWN");
    }
    if (isPendingParsed(parsed)) {
      await markLedgerUnknown(file);
      return { ok: false, action: "thread.delete", threadId: thread.id, status: "pending", deleted: false };
    }
    if (isDeletedParsed(parsed)) {
      const result = { ok: true, action: "thread.delete", threadId: thread.id, status: "deleted", deleted: true };
      await commitLedger(file, result);
      return result;
    }
    await markLedgerUnknown(file);
    return { ok: false, action: "thread.delete", threadId: thread.id, status: "unknown", deleted: false };
  }

  // -------------------------------------------------------------------------------------------
  // Public surface.
  // -------------------------------------------------------------------------------------------

  async function describe(scope, { threadId } = {}) {
    const thread = await requireThread(scope, threadId);
    return {
      threadId: thread.id,
      actions: ACTION_DEFINITIONS.map(definition => ({
        id: definition.id,
        mutating: definition.mutating,
        destructive: definition.destructive,
        requiresConfirmation: definition.requiresConfirmation,
        requiresRequestId: definition.requiresRequestId,
        externalSnapshot: definition.externalSnapshot
      }))
    };
  }

  async function prepareConfirmation(scope, { action, threadId, params } = {}) {
    const definition = ACTION_MAP.get(action) || null;
    if (!definition) throw nativeFail(400, "UNKNOWN_ACTION");
    if (!definition.requiresConfirmation) throw nativeFail(400, "CONFIRMATION_NOT_REQUIRED");
    validateThreadId(threadId);
    const normalized = definition.validate(params ?? {});
    const thread = await requireThread(scope, threadId);
    if (isFolderScoped(scope) && (definition.id === "thread.delete" || definition.id === "thread.share")) {
      throw nativeFail(403, "THREAD_SCOPE_FORBIDDEN");
    }
    if (definition.id === "thread.delete") {
      const name = safeThreadName(thread);
      if (normalized.confirmationText !== thread.id && normalized.confirmationText !== name) {
        throw nativeFail(400, "CONFIRMATION_TEXT_MISMATCH");
      }
    }
    const stateDigest = threadStateDigest(thread);
    const receipt = await confirmationsStore.issue({
      principal: principalFromScope(scope),
      action,
      threadId: thread.id,
      paramsDigest: digestParams(normalized),
      stateDigest
    });
    const title = safeThreadName(thread) ?? thread.id;
    const summary = definition.id === "thread.delete"
      ? {
        title,
        destructive: true,
        includesDescendants: true,
        externalSnapshot: false,
        warning: "Deleting this named chat also removes its subagent and side chats. This cannot be undone."
      }
      : {
        title,
        destructive: false,
        includesDescendants: false,
        externalSnapshot: true,
        warning: "A share link contains the whole chat (files and paths included) and may leave this device."
      };
    return { confirmationId: receipt.id, expiresAt: receipt.expiresAt, action: definition.id, threadId: thread.id, summary };
  }

  async function execute(scope, { action, threadId, params, requestId, confirmationId } = {}) {
    const definition = ACTION_MAP.get(action) || null;
    if (!definition) throw nativeFail(400, "UNKNOWN_ACTION");
    validateThreadId(threadId);
    const normalized = definition.validate(params ?? {});
    const thread = await requireThread(scope, threadId);

    switch (definition.id) {
      case "thread.rename":
        return renameThread(scope, thread, normalized);
      case "thread.read":
        return setReadState(scope, thread, true, definition.id);
      case "thread.unread":
        return setReadState(scope, thread, false, definition.id);
      case "thread.archive":
        return setArchived(scope, thread, true, definition.id);
      case "thread.unarchive":
        return setArchived(scope, thread, false, definition.id);
      case "thread.project.list":
        return listProjects(scope, thread);
      case "thread.project.move":
        return moveToProject(scope, thread, normalized);
      case "thread.fork":
        return forkThread(scope, thread, normalizedRequestId(requestId));
      case "thread.share":
        return shareThread(scope, thread, normalized, { confirmationId, requestId: normalizedRequestId(requestId) });
      case "thread.delete":
        return deleteThread(scope, thread, normalized, { confirmationId, requestId: normalizedRequestId(requestId) });
      default:
        throw nativeFail(400, "UNKNOWN_ACTION");
    }
  }

  return Object.freeze({ supports, describe, execute, prepareConfirmation });
}
