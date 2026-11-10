import { createHash, randomBytes } from "node:crypto";
import { safeRelativePath, hiddenProjectPath, fileError } from "./file-preview-policy.js";

const HEX32 = /^[0-9a-f]{32}$/;
const NATIVE_ID = /^[0-9a-f]{1,8}-[0-9a-f]{1,8}-[0-9a-f]{1,8}$/;
const KINDS = new Set(["mkdir", "upload", "edit-open", "save-text"]);
const DEFAULT_TTL_MS = 5 * 60 * 1000;
const MAX_GLOBAL = 256;
const MAX_PRINCIPAL = 64;

const deny = (status, code) => fileError(status, code);
const sha256 = value => createHash("sha256").update(value).digest("hex");
const opaqueId = () => randomBytes(16).toString("hex");

function scopeRoots(scope) {
  if (Array.isArray(scope.threadFilterCwds) && scope.threadFilterCwds.length) return scope.threadFilterCwds;
  if (scope.threadFilterCwd) return [scope.threadFilterCwd];
  return [];
}

// The stored binding covers the server-side scope only; client-supplied scope is never consulted.
function scopeBinding(scope) {
  return sha256(JSON.stringify([
    scope.id ?? null,
    scope.tokenHash ?? null,
    scope.authMode ?? null,
    scope.accessEmail ?? null,
    scopeRoots(scope)
  ]));
}

function parentOf(relative) {
  const parts = relative.split("/");
  parts.pop();
  return parts.join("/");
}

async function resolveFresh(resolveScope) {
  if (typeof resolveScope !== "function") throw deny(403, "WRITE_CONTEXT_DENIED");
  let scope;
  try { scope = await resolveScope(); } catch { scope = null; }
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) throw deny(403, "WRITE_CONTEXT_DENIED");
  return { scope, hash: scopeBinding(scope) };
}

export class ProjectWriteContexts {
  constructor({ files, runWriter, dataDir, now, ttlMs } = {}) {
    if (!files || typeof files.context !== "function") throw new TypeError("ProjectWriteContexts requires files.context");
    if (typeof runWriter !== "function") throw new TypeError("ProjectWriteContexts requires runWriter");
    if (typeof dataDir !== "string" || dataDir.length === 0) throw new TypeError("ProjectWriteContexts requires dataDir");
    if (now !== undefined && typeof now !== "function") throw new TypeError("now must be a function");
    if (ttlMs !== undefined && (!Number.isSafeInteger(ttlMs) || ttlMs <= 0)) throw new TypeError("ttlMs must be a positive integer");
    this.files = files;
    this.runWriter = runWriter;
    this.dataDir = dataDir;
    this.now = now ?? (() => Date.now());
    this.ttlMs = ttlMs ?? DEFAULT_TTL_MS;
    this.records = new Map();
  }

  // Expiration cleanup removes records only; it never touches project files.
  prune() {
    const current = this.now();
    for (const [id, record] of this.records) if (record.expiresAt <= current) this.records.delete(id);
  }

  enforce(principal, newestId) {
    let owned = 0;
    for (const record of this.records.values()) if (record.principal === principal) owned++;
    if (owned > MAX_PRINCIPAL) {
      for (const [id, record] of this.records) {
        if (owned <= MAX_PRINCIPAL) break;
        if (record.principal === principal) { this.records.delete(id); owned--; }
      }
    }
    while(this.records.size>MAX_GLOBAL){
      const candidate=[...this.records].find(([id,record])=>record.principal===principal&&id!==newestId);
      if(!candidate){this.records.delete(newestId);throw deny(429,"WRITE_CONTEXTS_BUSY");}
      this.records.delete(candidate[0]);
    }
  }

  async recheck(scope, record) {
    let current;
    try {
      current = await this.files.context(scope, { threadId: record.threadId, rootRevision: record.rootRevision });
    } catch {
      throw deny(409, "PROJECT_CHANGED");
    }
    if (!current
      || current.root !== record.root
      || current.rootIdentity !== record.fsIdentity
      || current.rootRevision !== record.rootRevision) throw deny(409, "PROJECT_CHANGED");
    return current;
  }

  async issue({ resolveScope, query, signal } = {}) {
    if (!query || typeof query !== "object" || Array.isArray(query)) throw deny(400, "INVALID_ARGUMENT");
    const threadId = query.threadId;
    if (typeof threadId !== "string" || threadId.length === 0 || threadId.length > 256) throw deny(403, "WRITE_CONTEXT_DENIED");
    let parentPath;
    try {
      parentPath = safeRelativePath(query.parentPath ?? "");
    } catch (error) {
      throw deny(error?.status ?? 400, error?.code ?? "INVALID_PATH");
    }
    if (hiddenProjectPath(parentPath)) throw deny(403, "WRITE_CONTEXT_DENIED");
    const requestedRevision = query.rootRevision;
    if (requestedRevision !== undefined && requestedRevision !== null
      && (typeof requestedRevision !== "string" || requestedRevision.length === 0 || requestedRevision.length > 256)) {
      throw deny(400, "INVALID_ARGUMENT");
    }
    if (signal?.aborted) throw deny(499, "CANCELLED");

    const initial = await resolveFresh(resolveScope);
    const principal = sha256(JSON.stringify([initial.scope.id??null,initial.scope.tokenHash??null,initial.scope.authMode??null,initial.scope.accessEmail??null]));
    const contextQuery = { threadId, ...(requestedRevision ? { rootRevision: requestedRevision } : {}) };
    let pinned;
    try {
      pinned = await this.files.context(initial.scope, contextQuery);
    } catch (error) {
      throw deny(error?.status === 409 ? 409 : 403, error?.status === 409 ? "PROJECT_CHANGED" : "WRITE_CONTEXT_DENIED");
    }
    if (!pinned
      || typeof pinned.root !== "string"
      || typeof pinned.rootIdentity !== "string"
      || typeof pinned.rootRevision !== "string") throw deny(403, "WRITE_CONTEXT_DENIED");
    if (requestedRevision && pinned.rootRevision !== requestedRevision) throw deny(409, "PROJECT_CHANGED");

    const expected = { root: pinned.root, identity: pinned.rootIdentity, revision: pinned.rootRevision };
    const confirm = async () => {
      let fresh;
      try { fresh = await resolveFresh(resolveScope); } catch { return false; }
      if (fresh.hash !== initial.hash) return false;
      try {
        const current = await this.files.context(fresh.scope, { threadId, rootRevision: expected.revision });
        return !!current
          && current.root === expected.root
          && current.rootIdentity === expected.identity
          && current.rootRevision === expected.revision;
      } catch { return false; }
    };

    const operationId = opaqueId();
    const operation = { id: operationId, kind: "context", root: expected.root, relativePath: parentPath };
    let result;
    try {
      result = await this.runWriter({
        dataDir: this.dataDir,
        operation,
        signal,
        authorizePrepared: async prepared => {
          if (signal?.aborted) return false;
          if (!prepared || prepared.operationId !== operationId || prepared.relativePath !== parentPath) return false;
          return confirm();
        }
      });
    } catch (error) {
      if (error?.code === "CANCELLED") throw deny(499, "CANCELLED");
      throw deny(403, "WRITE_CONTEXT_DENIED");
    }
    if (!result || typeof result !== "object") throw deny(403, "WRITE_CONTEXT_DENIED");
    const nativeRootIdentity = result.rootIdentity;
    const nativeParentIdentity = result.parentIdentity;
    if (typeof nativeRootIdentity !== "string" || !NATIVE_ID.test(nativeRootIdentity)) throw deny(403, "WRITE_CONTEXT_DENIED");
    if (typeof nativeParentIdentity !== "string" || !NATIVE_ID.test(nativeParentIdentity)) throw deny(403, "WRITE_CONTEXT_DENIED");
    if (!(await confirm())) throw deny(409, "PROJECT_CHANGED");
    if (signal?.aborted) throw deny(499, "CANCELLED");

    const createdAt = this.now();
    const expiresAt = createdAt + this.ttlMs;
    const contextId = opaqueId();
    const record = Object.freeze({
      contextId,
      principal,
      scopeHash: initial.hash,
      threadId,
      root: expected.root,
      rootRevision: expected.revision,
      fsIdentity: expected.identity,
      parentPath,
      nativeRootIdentity,
      nativeParentIdentity,
      createdAt,
      expiresAt
    });
    this.prune();
    this.records.set(contextId, record);
    this.enforce(principal, contextId);
    if (!this.records.has(contextId)) throw deny(429, "WRITE_CONTEXTS_BUSY");
    return Object.freeze({ contextId, threadId, rootRevision: expected.revision, parentPath, expiresAt });
  }

  async get({ resolveScope, contextId, path, kind, signal } = {}) {
    if (typeof resolveScope !== "function") throw deny(403, "WRITE_CONTEXT_DENIED");
    if (typeof contextId !== "string" || !HEX32.test(contextId)) throw deny(404, "WRITE_CONTEXT_NOT_FOUND");
    if (!KINDS.has(kind)) throw deny(400, "INVALID_ARGUMENT");
    if (signal?.aborted) throw deny(499, "CANCELLED");
    let relative;
    try { relative = safeRelativePath(path ?? ""); } catch (error) { throw deny(error?.status ?? 400, error?.code ?? "INVALID_PATH"); }
    if (relative.length === 0) throw deny(400, "INVALID_PATH");
    if (hiddenProjectPath(relative)) throw deny(403, "WRITE_CONTEXT_DENIED");

    const record = this.records.get(contextId);
    if (!record) throw deny(404, "WRITE_CONTEXT_NOT_FOUND");
    if (record.expiresAt <= this.now()) { this.records.delete(contextId); throw deny(403, "WRITE_CONTEXT_STALE"); }
    if (parentOf(relative) !== record.parentPath) throw deny(403, "WRITE_CONTEXT_DENIED");

    const fresh = await resolveFresh(resolveScope);
    if (fresh.hash !== record.scopeHash) throw deny(403, "WRITE_CONTEXT_DENIED");
    await this.recheck(fresh.scope, record);

    const recoveryBinding = sha256(JSON.stringify([record.scopeHash, contextId, record.threadId, record.root, record.parentPath]));
    const authorizePrepared = async prepared => {
      if (signal?.aborted) throw deny(499, "CANCELLED");
      if (this.records.get(contextId) !== record) throw deny(403, "WRITE_CONTEXT_DENIED");
      if (record.expiresAt <= this.now()) { this.records.delete(contextId); throw deny(403, "WRITE_CONTEXT_STALE"); }
      const again = await resolveFresh(resolveScope);
      if (again.hash !== record.scopeHash) throw deny(403, "WRITE_CONTEXT_DENIED");
      await this.recheck(again.scope, record);
      if (!prepared || typeof prepared !== "object") throw deny(403, "WRITE_CONTEXT_DENIED");
      if (prepared.rootIdentity !== record.nativeRootIdentity) throw deny(403, "WRITE_CONTEXT_DENIED");
      if (prepared.parentIdentity !== record.nativeParentIdentity) throw deny(403, "WRITE_CONTEXT_DENIED");
      return true;
    };

    return {
      context: { ...record },
      operationBase: { root: record.root, relativePath: relative },
      recoveryBinding,
      authorizePrepared
    };
  }
}
