import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileError, safeRelativePath } from "./file-preview-policy.js";

// Orchestrator for the project mutations (mkdir / upload / save-text) and the read-only edit-open.
// It owns exactly four things and nothing else:
//   1. caller-supplied operation ids plus their durable lifecycle ledger (project-writes/operations),
//   2. private staging under project-writes/staging with its byte/slot quota,
//   3. fresh context authorisation before staging and again before the helper commit,
//   4. the bounded native queue (2 global, 1 per root, 8 waiting).
// Responses are built from the safe DTO below only: the canonical root, the native fs identities and
// the staged paths never leave this module. Context DTOs always come from ProjectWriteContexts.
// HTTP wiring, the recovery consumer/download and UI are deliberately not part of this file.

export const WRITE_LIMITS = Object.freeze({
  uploadBytes: 25 * 1048576,
  textBytes: 1048576,
  stageBytesGlobal: 128 * 1048576,
  stageBytesPrincipal: 64 * 1048576,
  stageSlotsPrincipal: 2,
  stageRetainedMax: 16,
  stageRetainedPrincipalFiles: 4,
  nativeConcurrent: 2,
  nativePerRoot: 1,
  nativeWaiting: 8,
  recordsInMemory: 512
});

const HEX32 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const STAGE_NAME = /^(?:[0-9a-f]{64}-)?[0-9a-f]{32}\.stage$/;
const VERSION = /^v1\.[0-9a-f]{1,8}-[0-9a-f]{1,8}-[0-9a-f]{1,8}\.[0-9a-f]{64}$/;
const KINDS = new Set(["mkdir", "upload", "edit-open", "save-text"]);
const TERMINAL = new Set(["succeeded", "failed", "unknown"]);
// Codes that mean "the helper may already have replaced the target or may still be reading the
// staged payload": those are reported as unknown, never as a failed write.
const UNCERTAIN_CODES = new Set(["COMMIT_UNKNOWN", "NAME_REPLACED", "ROLLBACK_FAILED", "CLEANUP_REQUIRED", "RECOVERY_REQUIRED"]);

// Exact accepted fields per entry point. Anything else (root, stagedPath, stagedHash, force, ...) is
// rejected, so a caller can never choose the target root or which file is staged.
const FIELDS = Object.freeze({
  mkdir: ["resolveScope", "contextId", "path", "operationId", "signal"],
  upload: ["resolveScope", "contextId", "path", "operationId", "signal", "stream", "declaredSize"],
  "edit-open": ["resolveScope", "contextId", "path", "signal"],
  "save-text": ["resolveScope", "contextId", "path", "operationId", "signal", "text", "expectedVersion"],
  status: ["resolveScope", "operationId", "contextId", "path", "kind", "signal"]
});

const deny = (status, code) => fileError(status, code);
const sha256 = value => createHash("sha256").update(value).digest("hex");

// Case-preserving drive-letter canonicalisation; mirrors the helper so both agree on containment.
const driveOnly = value => {
  const trimmed = path.resolve(value).replace(/[\\/]+$/, "");
  return trimmed.length >= 2 && trimmed[1] === ":" ? trimmed[0].toUpperCase() + trimmed.slice(1) : trimmed;
};
const insideCanonical = (base, target) => {
  const root = driveOnly(base);
  const file = driveOnly(target);
  return file !== root && file.startsWith(root + path.sep);
};

async function canonicalDataDir(dataDir) {
  if (typeof dataDir !== "string" || dataDir.length === 0 || dataDir.length > 4096 || dataDir.includes("\0") || !path.isAbsolute(dataDir)) throw deny(400, "INVALID_ARGUMENT");
  let real;
  try { real = await fs.realpath(dataDir); } catch { throw deny(400, "INVALID_ARGUMENT"); }
  const stat = await fs.lstat(real, { bigint: true }).catch(() => null);
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) throw deny(400, "INVALID_ARGUMENT");
  if (path.parse(real).root === real) throw deny(400, "INVALID_ARGUMENT");
  return driveOnly(real);
}

// Every component between the canonical data dir and the runtime directory must be a real directory.
async function assertNoLinks(base, target) {
  const relative = path.relative(base, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw deny(403, "STAGE_INVALID");
  let current = base;
  for (const part of relative.split(path.sep)) {
    if (!part) continue;
    current = path.join(current, part);
    const stat = await fs.lstat(current, { bigint: true }).catch(() => null);
    if (!stat || stat.isSymbolicLink()) throw deny(403, "STAGE_INVALID");
  }
}

function normalizeInput(input, allowed) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw deny(400, "INVALID_ARGUMENT");
  for (const key of Object.keys(input)) if (!allowed.includes(key)) throw deny(400, "INVALID_ARGUMENT");
  if (typeof input.resolveScope !== "function") throw deny(403, "WRITE_CONTEXT_DENIED");
  return input;
}

function requireOperationId(value) {
  // Mutations are idempotent only because the id is chosen by the caller and validated here.
  if (typeof value !== "string" || !HEX32.test(value)) throw deny(400, "INVALID_OPERATION");
  return value;
}

function requireContextId(value) {
  if (typeof value !== "string" || !HEX32.test(value)) throw deny(404, "WRITE_CONTEXT_NOT_FOUND");
  return value;
}

function requirePath(value) {
  let relative;
  try { relative = safeRelativePath(value ?? ""); } catch (error) { throw deny(error?.status ?? 400, error?.code ?? "INVALID_PATH"); }
  if (relative.length === 0) throw deny(400, "INVALID_PATH");
  return relative;
}

// Explicit JS UTF-16 validity plus the exact UTF-8 byte ceiling. No BOM is added, no newline is
// converted and an empty document is a legitimate save. The helper refuses BOM/CR/NUL staged bytes
// (STAGE_INVALID), so refuse them here with a stable code before anything is staged.
function encodeText(text) {
  if (typeof text !== "string") throw deny(400, "INVALID_ARGUMENT");
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw deny(400, "INVALID_TEXT");
      index++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) throw deny(400, "INVALID_TEXT");
  }
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length > WRITE_LIMITS.textBytes) throw deny(413, "TOO_LARGE");
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) throw deny(400, "INVALID_TEXT");
  if (bytes.includes(0) || bytes.includes(0x0d)) throw deny(400, "INVALID_TEXT");
  return bytes;
}

function toBytes(chunk) {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  if (typeof chunk === "string") return Buffer.from(chunk, "utf8");
  return null;
}

class RuntimeBase {
  #dataDir;
  #ready = null;
  constructor(dataDir) { this.#dataDir = dataDir; }
  async base() {
    if (!this.#ready) this.#ready = this.#prepare().catch(error => { this.#ready = null; throw error; });
    return this.#ready;
  }
  async #prepare() {
    const canonical = await canonicalDataDir(this.#dataDir);
    const base = path.join(canonical, "project-writes");
    const staging = path.join(base, "staging");
    const operations = path.join(base, "operations");
    for (const dir of [base, staging, operations]) {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      const stat = await fs.lstat(dir, { bigint: true }).catch(() => null);
      if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) throw deny(403, "STAGE_INVALID");
      if (process.platform !== "win32" && (Number(stat.mode) & 0o077) !== 0) await fs.chmod(dir, 0o700).catch(() => {});
      await assertNoLinks(canonical, dir);
    }
    return { canonical, base, staging, operations };
  }
}

const principalKey=value=>HEX64.test(String(value))?String(value):sha256(String(value??""));
async function createStage(runtime,principal) {
  const file = path.join(runtime.staging, `${principalKey(principal)}-${randomBytes(16).toString("hex")}.stage`);
  let handle;
  try { handle = await fs.open(file, "wx", 0o600); } catch { throw deny(403, "STAGE_INVALID"); }
  return { file, handle };
}

// Owned stage must be a single-link regular file inside the private staging dir and match the
// number of bytes we actually hashed.
async function sealStage(runtime, stage, size) {
  try { await stage.handle.sync(); } finally { await stage.handle.close().catch(() => {}); }
  if (!insideCanonical(runtime.staging, stage.file)) throw deny(403, "STAGE_INVALID");
  const stat = await fs.lstat(stage.file, { bigint: true }).catch(() => null);
  if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) throw deny(403, "STAGE_INVALID");
  if (Number(stat.size) !== size) throw deny(409, "STAGE_CHANGED");
  const real = await fs.realpath(stage.file).catch(() => null);
  if (!real || !insideCanonical(runtime.staging, real)) throw deny(403, "STAGE_INVALID");
  return stage.file;
}

// Deletion is restricted to files this module created: a descendant of the staging dir with the
// process-generated crypto name. Nothing else on disk is ever removed.
async function removeOwnStage(runtime, file) {
  if (typeof file !== "string" || !file) return;
  const resolved = path.resolve(file);
  if (path.dirname(resolved) !== path.resolve(runtime.staging)) return;
  if (!STAGE_NAME.test(path.basename(resolved))) return;
  await fs.rm(resolved, { force: true }).catch(() => {});
}

async function stageBuffer(runtime, bytes,principal) {
  const stage = await createStage(runtime,principal);
  try {
    if (bytes.length) await stage.handle.write(bytes, 0, bytes.length, 0);
    const stagedPath = await sealStage(runtime, stage, bytes.length);
    return { stagedPath, stagedHash: sha256(bytes), size: bytes.length };
  } catch (error) {
    await stage.handle.close().catch(() => {});
    await removeOwnStage(runtime, stage.file);
    throw error;
  }
}

async function stageStream(runtime, stream, { declaredSize, signal,principal }) {
  if (!stream || typeof stream[Symbol.asyncIterator] !== "function") throw deny(400, "INVALID_ARGUMENT");
  const stage = await createStage(runtime,principal);
  const digest = createHash("sha256");
  let size = 0;
  try {
    for await (const chunk of stream) {
      if (signal?.aborted) throw deny(499, "CANCELLED");
      const bytes = toBytes(chunk);
      if (!bytes) throw deny(400, "INVALID_UPLOAD");
      size += bytes.length;
      if (size > WRITE_LIMITS.uploadBytes) throw deny(413, "TOO_LARGE");
      if (declaredSize !== undefined && size > declaredSize) throw deny(409, "SIZE_MISMATCH");
      digest.update(bytes);
      await stage.handle.write(bytes);
    }
    if (signal?.aborted) throw deny(499, "CANCELLED");
    if (declaredSize !== undefined && declaredSize !== size) throw deny(409, "SIZE_MISMATCH");
    const stagedPath = await sealStage(runtime, stage, size);
    return { stagedPath, stagedHash: digest.digest("hex"), size };
  } catch (error) {
    await stage.handle.close().catch(() => {});
    await removeOwnStage(runtime, stage.file);
    if (Number.isInteger(error?.status)) throw error;
    throw deny(400, "INVALID_UPLOAD");
  }
}

// Bounded native slots: 2 running globally, 1 per root, at most 8 queued, FIFO grant by capability.
class NativeQueue {
  #global = 0;
  #roots = new Map();
  #waiting = [];
  #free(root) { return this.#global < WRITE_LIMITS.nativeConcurrent && !(this.#roots.get(root) > 0); }
  #take(root) {
    this.#global += 1;
    this.#roots.set(root, (this.#roots.get(root) ?? 0) + 1);
  }
  #drop(root) {
    this.#global -= 1;
    const left = (this.#roots.get(root) ?? 1) - 1;
    if (left <= 0) this.#roots.delete(root); else this.#roots.set(root, left);
  }
  #detach(waiter) {
    if (!waiter.signal) return;
    waiter.signal.removeEventListener("abort", waiter.onAbort);
  }
  #release(root) {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#drop(root);
      this.#pump();
    };
  }
  #pump() {
    for (let index = 0; index < this.#waiting.length; index++) {
      const waiter = this.#waiting[index];
      if (!this.#free(waiter.root)) continue;
      this.#waiting.splice(index, 1);
      index -= 1;
      this.#take(waiter.root);
      this.#detach(waiter);
      if (waiter.signal?.aborted) { waiter.reject(deny(499, "CANCELLED")); this.#drop(waiter.root); continue; }
      waiter.resolve(this.#release(waiter.root));
    }
  }
  acquire(rootKey, signal) {
    const root = typeof rootKey === "string" && rootKey ? rootKey : "";
    if (signal?.aborted) return Promise.reject(deny(499, "CANCELLED"));
    if (this.#free(root)) { this.#take(root); return Promise.resolve(this.#release(root)); }
    if (this.#waiting.length >= WRITE_LIMITS.nativeWaiting) return Promise.reject(deny(429, "WRITE_BUSY"));
    return new Promise((resolve, reject) => {
      const waiter = { root, signal, resolve, reject, onAbort: null };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.#waiting.indexOf(waiter);
          if (index >= 0) this.#waiting.splice(index, 1);
          this.#detach(waiter);
          reject(deny(499, "CANCELLED"));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.#waiting.push(waiter);
    });
  }
}

// Stage budget: 128 MiB global, 64 MiB per principal, 2 concurrent stages per principal. A stage whose
// outcome is unknown is retained on disk (the helper may still be reading it), so its reservation is
// NOT given back: it moves into the retained account and keeps consuming the global budget. Stages
// found on disk at startup are adopted the same way, and both are bounded, so an accumulation of
// unknown stages fails closed (STAGE_BUSY) until an operator recovers them. Nothing here deletes them.
class StageQuota {
  #bytes = 0;
  #principals = new Map();
  #retainedBytes = 0;
  #retainedFiles = 0;
  #retainedPrincipals = new Map();
  get retained() { return { bytes: this.#retainedBytes, files: this.#retainedFiles }; }
  adoptRetained(bytes, files,ownerKey=null) {
    this.#retainedBytes += Number.isSafeInteger(bytes) && bytes > 0 ? bytes : 0;
    this.#retainedFiles += Number.isSafeInteger(files) && files > 0 ? files : 0;
    if(ownerKey){const owner=this.#retainedPrincipals.get(ownerKey)??{bytes:0,files:0};owner.bytes+=bytes;owner.files+=files;this.#retainedPrincipals.set(ownerKey,owner);}
  }
  reserve(principal, bytes) {
    principal=principalKey(principal);
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > WRITE_LIMITS.uploadBytes) throw deny(413, "TOO_LARGE");
    if (this.#retainedFiles >= WRITE_LIMITS.stageRetainedMax) throw deny(429, "STAGE_BUSY");
    const entry = this.#principals.get(principal) ?? { bytes: 0, slots: 0 };
    const retained=this.#retainedPrincipals.get(principal)??{bytes:0,files:0};
    if(retained.files+entry.slots+1>WRITE_LIMITS.stageRetainedPrincipalFiles)throw deny(429,"STAGE_BUSY");
    if (entry.slots + 1 > WRITE_LIMITS.stageSlotsPrincipal) throw deny(429, "STAGE_BUSY");
    if (this.#retainedBytes + this.#bytes + bytes > WRITE_LIMITS.stageBytesGlobal) throw deny(429, "STAGE_BUSY");
    if (retained.bytes + entry.bytes + bytes > WRITE_LIMITS.stageBytesPrincipal) throw deny(429, "STAGE_BUSY");
    this.#bytes += bytes;
    entry.bytes += bytes;
    entry.slots += 1;
    this.#principals.set(principal, entry);
    let released = false;
    // `retain === true` means the stage file stays on disk, so its bytes stay charged instead of being
    // handed back to the next uploader.
    return (retain = false) => {
      if (released) return;
      released = true;
      if (retain === true) {
        this.adoptRetained(bytes,1,principal);
      }
      this.#bytes -= bytes;
      entry.bytes -= bytes;
      entry.slots -= 1;
      if (entry.slots <= 0) this.#principals.delete(principal);
    };
  }
}

// The safe result surface accepted from the helper. Anything not listed here is dropped, including
// the native root/parent/target identities.
function safeResult(kind, raw) {
  if (!raw || typeof raw !== "object") throw deny(502, "PROTOCOL_ERROR");
  const out = {};
  if (Number.isSafeInteger(raw.size) && raw.size >= 0) out.size = raw.size;
  if (typeof raw.version === "string" && VERSION.test(raw.version)) out.version = raw.version;
  if (kind === "save-text") {
    if (typeof raw.editable === "boolean") out.editable = raw.editable;
    if (typeof raw.bom === "boolean") out.bom = raw.bom;
    if (raw.eol === "lf" || raw.eol === "crlf" || raw.eol === "mixed") out.eol = raw.eol;
  }
  if (kind === "edit-open") {
    if (typeof raw.editable !== "boolean") throw deny(502, "PROTOCOL_ERROR");
    if (!Number.isSafeInteger(raw.size)) throw deny(502, "PROTOCOL_ERROR");
    if (raw.editable && typeof raw.text !== "string") throw deny(502, "PROTOCOL_ERROR");
    if (!raw.editable && raw.text !== null && raw.text !== undefined) throw deny(502, "PROTOCOL_ERROR");
    out.editable = raw.editable;
    if (typeof raw.text === "string") out.text = raw.text;
    if (typeof raw.bom === "boolean") out.bom = raw.bom;
    if (raw.eol === "lf" || raw.eol === "crlf" || raw.eol === "mixed") out.eol = raw.eol;
    if (raw.reason === null || typeof raw.reason === "string") out.reason = raw.reason ?? null;
    out.version = typeof raw.version === "string" && VERSION.test(raw.version) ? raw.version : null;
  }
  return Object.freeze(out);
}

// Public operation DTO: no root, no identities, no staged path.
function safeDto(record, cached = false) {
  const result = record.result && typeof record.result === "object" ? { ...record.result } : {};
  if (!result.reason && typeof record.reason === "string" && record.reason) result.reason = record.reason;
  const dto = {
    operationId: record.operationId,
    status: record.status,
    kind: record.kind,
    path: record.path,
    result: Object.freeze(result)
  };
  if (typeof record.recoveryId === "string" && HEX64.test(record.recoveryId)) dto.recoveryId = record.recoveryId;
  if (cached) dto.cached = true;
  return Object.freeze(dto);
}

const BINDING_KEYS = Object.freeze(["principal", "scopeHash", "contextId", "threadId", "rootRevision", "kind", "path", "expectedVersion"]);

function assertSameBinding(record, binding) {
  for (const key of BINDING_KEYS) {
    if ((record[key] ?? null) !== (binding[key] ?? null)) {
      // A replayed id with a different principal/context/thread/revision/path/kind/version is a
      // conflict: the original operation is never overwritten or re-dispatched.
      throw deny(409, "OPERATION_CONFLICT");
    }
  }
}

function assertSamePayload(record, staged) {
  if (!record.payloadSHA || !staged) throw deny(409, "OPERATION_CONFLICT");
  if (record.payloadSHA !== staged.stagedHash) throw deny(409, "OPERATION_CONFLICT");
  if (record.payloadSize !== null && record.payloadSize !== undefined && record.payloadSize !== staged.size) throw deny(409, "OPERATION_CONFLICT");
}

function assertSameContext(context, binding) {
  if (!context || typeof context !== "object") throw deny(403, "WRITE_CONTEXT_DENIED");
  if ((context.principal ?? null) !== (binding.principal ?? null) || (context.scopeHash ?? null) !== (binding.scopeHash ?? null)
    || (context.threadId ?? null) !== (binding.threadId ?? null) || (context.rootRevision ?? null) !== (binding.rootRevision ?? null)
    || typeof context.root !== "string" || !context.root) {
    throw deny(409, "PROJECT_CHANGED");
  }
}

async function readRecordFile(runtime, operationId) {
  const file = path.join(runtime.operations, `${operationId}.json`);
  let raw;
  try { raw = await fs.readFile(file, "utf8"); } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw deny(500, "LEDGER_UNAVAILABLE");
  }
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { parsed = null; }
  // Records are only ever replaced atomically, so an unreadable one is external tampering: refuse it
  // instead of guessing at its binding.
  if (!parsed || typeof parsed !== "object" || parsed.v !== 1 || parsed.operationId !== operationId || !KINDS.has(parsed.kind) || typeof parsed.path !== "string") {
    throw deny(409, "OPERATION_UNKNOWN");
  }
  return parsed;
}

async function writeRecordFile(runtime, record) {
  const target = path.join(runtime.operations, `${record.operationId}.json`);
  const temp = path.join(runtime.operations, `${record.operationId}.${randomBytes(8).toString("hex")}.tmp`);
  let handle;
  try { handle = await fs.open(temp, "wx", 0o600); } catch { throw deny(500, "LEDGER_UNAVAILABLE"); }
  try {
    await handle.writeFile(JSON.stringify(record), "utf8");
    await handle.sync();
  } finally { await handle.close().catch(() => {}); }
  try { await fs.rename(temp, target); } catch {
    await fs.rm(temp, { force: true }).catch(() => {});
    throw deny(500, "LEDGER_UNAVAILABLE");
  }
  const dir = await fs.open(runtime.operations, "r").catch(() => null);
  if (dir) {
    await dir.sync().catch(() => {});
    await dir.close().catch(() => {});
  }
}

export class ProjectWrites {
  #runtime;
  #records = new Map();
  #locks = new Map();
  #active = new Set();
  #scan = null;
  #native = new NativeQueue();
  #quota = new StageQuota();

  constructor({ contexts, runWriter, dataDir, now } = {}) {
    if (!contexts || typeof contexts !== "object" || typeof contexts.get !== "function" || typeof contexts.issue !== "function") throw new TypeError("ProjectWrites requires contexts");
    if (typeof runWriter !== "function") throw new TypeError("ProjectWrites requires runWriter");
    if (typeof dataDir !== "string" || dataDir.length === 0) throw new TypeError("ProjectWrites requires dataDir");
    if (now !== undefined && typeof now !== "function") throw new TypeError("now must be a function");
    this.contexts = contexts;
    this.runWriter = runWriter;
    this.dataDir = dataDir;
    this.now = now ?? (() => Date.now());
    this.#runtime = new RuntimeBase(dataDir);
  }

  // The context DTO is authoritative: it is returned exactly as issued, never rebuilt or extended.
  async issueContext(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw deny(400, "INVALID_ARGUMENT");
    return this.contexts.issue(input);
  }

  mkdir(input) { return this.#mutate("mkdir", input); }

  upload(input) { return this.#mutate("upload", input); }

  saveText(input) { return this.#mutate("save-text", input); }

  async editOpen(input) {
    const args = normalizeInput(input, FIELDS["edit-open"]);
    const ids = { contextId: requireContextId(args.contextId), relativePath: requirePath(args.path) };
    if (args.signal?.aborted) throw deny(499, "CANCELLED");
    // Read-only native probe: no ledger entry is required and the helper operation id is generated
    // here, never accepted from the caller.
    const operationId = randomBytes(16).toString("hex");
    const authority = await this.#authority("edit-open", args, ids);
    const root = authority.operationBase.root;
    const release = await this.#native.acquire(root, args.signal);
    try {
      // Fresh gate after the queue wait, plus the authority's own fresh resolveScope callback.
      const gate = await this.#authority("edit-open", args, ids);
      if (gate.operationBase.root !== root) throw deny(409, "PROJECT_CHANGED");
      const result = await this.runWriter({
        dataDir: this.dataDir,
        operation: { id: operationId, kind: "edit-open", root: gate.operationBase.root, relativePath: gate.operationBase.relativePath },
        signal: args.signal,
        authorizePrepared: async prepared => {
          await gate.authorizePrepared(prepared);
          if (args.signal?.aborted) throw deny(499, "CANCELLED");
          return true;
        }
      });
      return safeDto({ operationId, status: "succeeded", kind: "edit-open", path: ids.relativePath, result: safeResult("edit-open", result), recoveryId: null, reason: null });
    } finally {
      release();
    }
  }

  // Scoped status: only a currently valid context of the same scope/principal may read the record,
  // and the answer is the same safe DTO (never the stage path or the recovery internals).
  async operationStatus(input) {
    const args = normalizeInput(input, FIELDS.status);
    const operationId = requireOperationId(args.operationId);
    const ids = { contextId: requireContextId(args.contextId), relativePath: requirePath(args.path) };
    if (!KINDS.has(args.kind)) throw deny(400, "INVALID_ARGUMENT");
    const authority = await this.#authority(args.kind, args, ids);
    const runtime = await this.#runtime.base();
    const { record } = await this.#findRecord(runtime, operationId);
    if (!record) throw deny(404, "OPERATION_NOT_FOUND");
    const context = authority.context;
    const sameNativeAuthority = record.nativeRootIdentity && record.nativeParentIdentity
      && record.nativeRootIdentity === context.nativeRootIdentity && record.nativeParentIdentity === context.nativeParentIdentity;
    if ((record.contextId !== ids.contextId && !sameNativeAuthority) || record.kind !== args.kind || record.path !== ids.relativePath
      || (context.principal ?? null) !== (record.principal ?? null) || (context.scopeHash ?? null) !== (record.scopeHash ?? null)
      || record.threadId !== context.threadId || record.rootRevision !== context.rootRevision) {
      throw deny(403, "OPERATION_DENIED");
    }
    if (!TERMINAL.has(record.status)) {
      // A live flight in this process keeps its current state: a caller polling a commit that is still
      // running must never be told "unknown" and must not disturb the operation. Only a record left
      // mid-flight by a previous process (restored from the ledger, not active here) becomes unknown.
      if (this.#active.has(record.operationId)) return safeDto(record);
      await this.#setStatus(runtime, record, { status: "unknown", reason: typeof record.reason === "string" && record.reason ? record.reason : "INTERRUPTED" });
    }
    return safeDto(record);
  }

  async #authority(kind, args, ids) {
    let authority;
    try {
      authority = await this.contexts.get({ resolveScope: args.resolveScope, contextId: ids.contextId, path: ids.relativePath, kind, signal: args.signal });
    } catch (error) {
      throw deny(error?.status ?? 403, error?.code ?? "WRITE_CONTEXT_DENIED");
    }
    if (!authority || typeof authority !== "object" || typeof authority.authorizePrepared !== "function") throw deny(403, "WRITE_CONTEXT_DENIED");
    const context = authority.context;
    const base = authority.operationBase;
    if (!context || typeof context !== "object" || typeof context.root !== "string" || !context.root) throw deny(403, "WRITE_CONTEXT_DENIED");
    if (!base || typeof base.root !== "string" || !base.root || typeof base.relativePath !== "string" || base.relativePath !== ids.relativePath) throw deny(403, "WRITE_CONTEXT_DENIED");
    return authority;
  }

  async downloadRecovery(input) {
    const dto = await this.operationStatus(input);
    if (!dto.recoveryId || input.kind !== "save-text") throw deny(404, "RECOVERY_NOT_FOUND");
    const runtime = await this.#runtime.base();
    const { record } = await this.#findRecord(runtime, input.operationId);
    const dir = path.join(runtime.base, "recoveries");
    await assertNoLinks(runtime.canonical, dir);
    const file = path.join(dir, `recovery-${dto.recoveryId}.bin`);
    const stat = await fs.lstat(file).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > WRITE_LIMITS.textBytes + 8192) throw deny(404, "RECOVERY_NOT_FOUND");
    const handle = await fs.open(file, "r");
    let bytes;
    try {
      const opened = await handle.stat();
      if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size) throw deny(409, "RECOVERY_CHANGED");
      bytes = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < bytes.length) { const read = await handle.read(bytes, offset, bytes.length-offset, offset); if (!read.bytesRead) throw deny(409,"RECOVERY_CHANGED"); offset += read.bytesRead; }
    } finally { await handle.close(); }
    const separator = bytes.indexOf(10);
    if (separator < 0 || separator > 8192) throw deny(409, "RECOVERY_INVALID");
    let meta; try { meta = JSON.parse(bytes.subarray(0, separator).toString("utf8")); } catch { throw deny(409,"RECOVERY_INVALID"); }
    const original = bytes.subarray(separator+1);
    if (meta.v !== 1 || meta.operationId !== record.operationId || meta.recoveryBinding !== record.recoveryBinding
      || meta.rootIdentity !== record.nativeRootIdentity || meta.parentIdentity !== record.nativeParentIdentity
      || meta.relativePath !== record.path || meta.currentVersion !== record.expectedVersion
      || meta.originalSize !== original.length || original.length > WRITE_LIMITS.textBytes
      || meta.originalHash !== sha256(original)) throw deny(409,"RECOVERY_INVALID");
    // Re-authorize after reading; only original bytes leave this private record.
    await this.operationStatus(input);
    return { bytes: original, name: path.posix.basename(record.path) + ".recovery" };
  }

  async #findRecord(runtime, operationId) {
    const cached = this.#records.get(operationId);
    if (cached) return { record: cached, restored: false };
    const loaded = await readRecordFile(runtime, operationId);
    if (!loaded) return { record: null, restored: false };
    this.#remember(loaded);
    return { record: loaded, restored: true };
  }

  #remember(record) {
    this.#records.delete(record.operationId);
    this.#records.set(record.operationId, record);
    while (this.#records.size > WRITE_LIMITS.recordsInMemory) this.#records.delete(this.#records.keys().next().value);
  }

  // One promise chain per operation id: concurrent duplicates queue behind the first and then see its
  // cached answer instead of dispatching a second native operation.
  async #locked(key, run) {
    const prior = this.#locks.get(key);
    let release;
    const mine = new Promise(resolve => { release = resolve; });
    const tail = (prior ?? Promise.resolve()).then(() => mine);
    this.#locks.set(key, tail);
    tail.then(() => { if (this.#locks.get(key) === tail) this.#locks.delete(key); });
    if (prior) await prior;
    try { return await run(); } finally { release(); }
  }

  async #createRecord(runtime, record) {
    const now = this.now();
    const created = { v: 1, ...record, createdAt: now, updatedAt: now };
    await writeRecordFile(runtime, created);
    this.#remember(created);
    return created;
  }

  async #setStatus(runtime, record, patch) {
    Object.assign(record, patch, { updatedAt: this.now() });
    await writeRecordFile(runtime, record);
    this.#remember(record);
    return record;
  }

  async #mutate(kind, input) {
    const args = normalizeInput(input, FIELDS[kind]);
    const operationId = requireOperationId(args.operationId);
    const ids = { operationId, contextId: requireContextId(args.contextId), relativePath: requirePath(args.path) };
    if (args.signal?.aborted) throw deny(499, "CANCELLED");
    return this.#locked(operationId, () => this.#run(kind, args, ids));
  }

  // A live flight stays registered for the whole mutation, so operationStatus can report its real
  // state instead of guessing "unknown" for an operation this process is still running.
  async #run(kind, args, ids) {
    this.#active.add(ids.operationId);
    try { return await this.#execute(kind, args, ids); } finally { this.#active.delete(ids.operationId); }
  }

  // Stage files found on disk belong to earlier processes: their outcome is unknown, so they are
  // adopted into the retained account once (never deleted, never re-dispatched) and stay bounded.
  async #prepared() {
    const runtime = await this.#runtime.base();
    this.#scan ??= (async () => {
      const names = await fs.readdir(runtime.staging).catch(() => []);
      for (const name of names) {
        if (!STAGE_NAME.test(name)) continue;
        const stat = await fs.lstat(path.join(runtime.staging, name), { bigint: true }).catch(() => null);
        if (!stat || !stat.isFile()) continue;
        const owner=name.match(/^([0-9a-f]{64})-/)?.[1]??null;
        this.#quota.adoptRetained(Number(stat.size),1,owner);
      }
    })();
    await this.#scan;
    return runtime;
  }

  async #execute(kind, args, ids) {
    const { operationId, contextId, relativePath } = ids;
    // Cheap, purely local validation happens before anything durable is written.
    const payload = kind === "save-text" ? encodeText(args.text) : null;
    if (kind === "save-text" && (typeof args.expectedVersion !== "string" || !VERSION.test(args.expectedVersion))) throw deny(400, "INVALID_ARGUMENT");
    if (kind === "upload") {
      if (args.declaredSize !== undefined && (!Number.isSafeInteger(args.declaredSize) || args.declaredSize < 0)) throw deny(400, "INVALID_ARGUMENT");
      if (args.declaredSize !== undefined && args.declaredSize > WRITE_LIMITS.uploadBytes) throw deny(413, "TOO_LARGE");
      if (!args.stream || typeof args.stream[Symbol.asyncIterator] !== "function") throw deny(400, "INVALID_ARGUMENT");
    }

    const runtime = await this.#prepared();
    const authority = await this.#authority(kind, args, ids); // fresh server auth before staging
    const binding = Object.freeze({
      principal: authority.context.principal ?? null,
      scopeHash: authority.context.scopeHash ?? null,
      contextId,
      threadId: authority.context.threadId ?? null,
      rootRevision: authority.context.rootRevision ?? null,
      nativeRootIdentity: authority.context.nativeRootIdentity ?? null,
      nativeParentIdentity: authority.context.nativeParentIdentity ?? null,
      kind,
      path: relativePath,
      expectedVersion: kind === "save-text" ? args.expectedVersion : null
    });

    const { record: existing } = await this.#findRecord(runtime, operationId);
    if (existing) {
      assertSameBinding(existing, binding);
      if (!TERMINAL.has(existing.status)) {
        // Crash leftovers are never retried automatically: report unknown and keep the stage.
        await this.#setStatus(runtime, existing, { status: "unknown", reason: typeof existing.reason === "string" && existing.reason ? existing.reason : "INTERRUPTED" });
      }
      // Replays must retain the same bytes even when the original outcome is
      // unknown or failed. An unknown outcome is never dispatched again.
      if (kind === "upload") {
        if (!existing.payloadSHA) throw deny(409,"OPERATION_STATUS_REQUIRED");
        // An upload payload digest is only knowable by hashing it, so hash into a probe stage and
        // drop it again: the cached ack is returned only when the digest matches exactly.
        const release = this.#quota.reserve(binding.principal, args.declaredSize ?? WRITE_LIMITS.uploadBytes);
        let probe = null;
        try {
          probe = await stageStream(runtime, args.stream, { declaredSize: args.declaredSize, signal: args.signal,principal:binding.principal });
          assertSamePayload(existing, probe);
        } finally {
          if (probe) await removeOwnStage(runtime, probe.stagedPath);
          release();
        }
        return safeDto(existing, true);
      }
      if (kind === "save-text") assertSamePayload(existing, { stagedHash: sha256(payload), size: payload.length });
      return safeDto(existing, true);
    }

    const reserveBytes = kind === "save-text" ? payload.length : kind === "upload" ? (args.declaredSize ?? WRITE_LIMITS.uploadBytes) : 0;
    const releaseQuota = kind === "mkdir" ? () => {} : this.#quota.reserve(binding.principal, reserveBytes); // before the stream
    let record = null;
    let staged = null;
    try {
      // Durable intent before any staging or dispatch.
      record = await this.#createRecord(runtime, {
        operationId,
        ...binding,
        status: "preparing",
        recoveryBinding: typeof authority.recoveryBinding === "string" ? authority.recoveryBinding : null,
        payloadSHA: payload ? sha256(payload) : null,
        payloadSize: payload ? payload.length : null,
        stagedPath: null,
        result: null,
        recoveryId: null,
        reason: null
      });
      await this.#setStatus(runtime, record, { status: "staging" });
      staged = kind === "upload" ? await stageStream(runtime, args.stream, { declaredSize: args.declaredSize, signal: args.signal,principal:binding.principal })
        : kind === "save-text" ? await stageBuffer(runtime, payload,binding.principal)
          : null;
      if (args.signal?.aborted) throw deny(499, "CANCELLED");
      if (staged) {
        if (record.payloadSHA && record.payloadSHA !== staged.stagedHash) throw deny(409, "OPERATION_CONFLICT");
        await this.#setStatus(runtime, record, { status: "prepared", payloadSHA: staged.stagedHash, payloadSize: staged.size, stagedPath: staged.stagedPath });
      } else {
        await this.#setStatus(runtime, record, { status: "prepared" });
      }

      // Fresh server auth after staging and before the helper commit.
      const after = await this.#authority(kind, args, ids);
      assertSameContext(after.context, binding);
      const release = await this.#native.acquire(after.context.root, args.signal);
      let commitRequested = false;
      try {
        if (args.signal?.aborted) throw deny(499, "CANCELLED");
        // Queued callers re-check authorisation here, so a scope revoked while waiting never runs.
        const gate = await this.#authority(kind, args, ids);
        assertSameContext(gate.context, binding);
        if (gate.operationBase.root !== after.context.root) throw deny(409, "PROJECT_CHANGED");
        await this.#setStatus(runtime, record, { status: "committing" });
        const operation = {
          id: operationId,
          kind,
          root: gate.operationBase.root,
          relativePath: gate.operationBase.relativePath,
          ...(staged ? { stagedPath: staged.stagedPath, stagedHash: staged.stagedHash } : {}),
          ...(kind === "save-text" ? { expectedVersion: args.expectedVersion, recoveryBinding: gate.recoveryBinding } : {})
        };
        let result;
        try {
          result = await this.runWriter({
            dataDir: this.dataDir,
            operation,
            signal: args.signal,
            authorizePrepared: async prepared => {
              commitRequested = true;
              await gate.authorizePrepared(prepared);
              if (args.signal?.aborted) throw deny(499, "CANCELLED");
              return true;
            }
          });
        } catch (error) {
          const code = typeof error?.code === "string" && error.code ? error.code : "WRITE_FAILED";
          const uncertain = UNCERTAIN_CODES.has(code) || (commitRequested && (code === "TIMEOUT" || code === "CANCELLED" || !Number.isInteger(error?.status)));
          if (uncertain) {
            // The helper may still be reading our stage and may already have replaced the target.
            // Keep the stage, keep the recovery id, report unknown and never retry automatically.
            await this.#setStatus(runtime, record, {
              status: "unknown",
              reason: code,
              recoveryId: typeof error?.recoveryId === "string" && HEX64.test(error.recoveryId) ? error.recoveryId : record.recoveryId
            });
            return safeDto(record);
          }
          throw error;
        }
        await this.#setStatus(runtime, record, {
          status: "succeeded",
          result: safeResult(kind, result),
          reason: null,
          recoveryId: typeof result?.recoveryId === "string" && HEX64.test(result.recoveryId) ? result.recoveryId : record.recoveryId
        });
        return safeDto(record);
      } finally {
        release();
      }
    } catch (error) {
      if (record && !TERMINAL.has(record.status)) {
        // Definite failure: the ledger remembers why, and the stage is dropped in the finally below.
        await this.#setStatus(runtime, record, { status: "failed", reason: typeof error?.code === "string" && error.code ? error.code : "WRITE_FAILED" }).catch(() => {});
      }
      throw error;
    } finally {
      // A stage whose outcome is unknown stays on disk (the helper may still be reading it or may
      // already have replaced the target): it is never deleted automatically and its quota stays
      // charged, so unknown stages cannot be used to grow the staging directory for free.
      const retained = record !== null && record.status === "unknown" && staged !== null;
      if (!retained) await removeOwnStage(runtime, staged?.stagedPath);
      releaseQuota(retained);
    }
  }
}
