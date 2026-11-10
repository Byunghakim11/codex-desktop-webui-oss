import { spawn, execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hiddenProjectPath, restrictedProjectRoot } from "./file-preview-policy.js";

const execFileAsync = promisify(execFile);
const SOURCE = fileURLToPath(new URL("./native/ProjectWriter.cs", import.meta.url));
const LIMITS = Object.freeze({
  uploadBytes: 25 * 1048576,
  textBytes: 1048576,
  prepareBytes: 65536,
  frameBytes: 20 * 1048576,
  prepareMs: 20000,
  authorizeMs: 30000,
  commitMs: 60000
});
const HEX32 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const IDENTITY = /^[0-9a-f]{1,8}-[0-9a-f]{1,8}-[0-9a-f]{1,8}$/;
const VERSION = /^v1\.[0-9a-f]{1,8}-[0-9a-f]{1,8}-[0-9a-f]{1,8}\.[0-9a-f]{64}$/;
const RESERVED = /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])$/i;

// Recovery contract exported for the (not yet written) trusted HTTP consumer. The helper never
// implements HTTP policy: it only guarantees the journal layout, which codes carry a recoveryId,
// and that staged payloads stay caller-owned (the helper never deletes them).
export const RECOVERY_CONTRACT = Object.freeze({
  journalDirectory: "project-writes/recoveries",
  journalName: recoveryId => `recovery-${recoveryId}.bin`,
  journalPattern: /^recovery-[0-9a-f]{64}\.bin$/,
  journalFormat: "one utf8 JSON header line (v, operationId, recoveryBinding, rootIdentity, parentIdentity, targetIdentity, currentVersion, originalSize, originalHash, relativePath, newSize) followed by the original bytes",
  quota: Object.freeze({ bytes: 64 * 1048576, files: 128, eviction: "never" }),
  // Errors carrying recoveryId; the record is retained (never evicted) for the operator.
  recoveryErrors: Object.freeze(["NAME_REPLACED", "WRITE_FAILED", "ROLLBACK_FAILED", "RECOVERY_REQUIRED"]),
  // Errors carrying recoveryId + cleanupIdentity: our owned object is still at its name.
  cleanupErrors: Object.freeze(["CLEANUP_REQUIRED"]),
  recoveryBinding: "must be supplied by the trusted HTTP owner; the helper treats it as opaque",
  stagedPayload: "caller-owned; the helper never deletes staged files"
});

export class ProjectWriterError extends Error {
  constructor(status, code, recoveryId = null, cleanupIdentity = null) {
    super(code);
    this.name = "ProjectWriterError";
    this.status = status;
    this.code = code;
    this.recoveryId = recoveryId;
    this.cleanupIdentity = cleanupIdentity;
  }
}
const fail = (status, code, recoveryId = null, cleanupIdentity = null) => new ProjectWriterError(status, code, recoveryId, cleanupIdentity);
const isError = value => value instanceof ProjectWriterError;
// Case-preserving except the drive letter: Windows canonical paths are compared 8.3-expanded
// (realpath) and never lower-cased, so `K` and `\u212a` siblings stay distinct.
const driveOnly = value => {
  const resolved = path.resolve(value);
  const trimmed = resolved.replace(/[\\/]+$/, "");
  return trimmed.length >= 2 && trimmed[1] === ":" ? trimmed[0].toUpperCase() + trimmed.slice(1) : trimmed;
};
const insideCanonical = (root, target) => {
  const base = driveOnly(root);
  const file = driveOnly(target);
  return file === base || file.startsWith(base + path.sep);
};

function validateLeaf(leaf) {
  if (typeof leaf !== "string" || leaf.length === 0 || leaf.length > 255) throw fail(400, "INVALID_OPERATION");
  if (leaf === "." || leaf === "..") throw fail(400, "INVALID_OPERATION");
  if (/[\x00-\x1f\x7f<>:"/\\|?*]/.test(leaf)) throw fail(400, "INVALID_OPERATION");
  if (/[. ]$/.test(leaf)) throw fail(400, "INVALID_OPERATION");
  if (leaf.normalize("NFC") !== leaf) throw fail(400, "INVALID_OPERATION");
  if (Array.from(leaf).some(character => {
    const code = character.codePointAt(0);
    return code >= 0xd800 && code <= 0xdfff;
  })) throw fail(400, "INVALID_OPERATION");
  if (RESERVED.test(leaf.split(".")[0])) throw fail(400, "INVALID_OPERATION");
}

function validateRoot(root) {
  if (typeof root !== "string" || root.length < 3 || root.length > 4096 || /[\x00-\x1f\x7f]/.test(root) || root.includes("/") || root.startsWith("\\\\")) throw fail(400, "INVALID_OPERATION");
  if (!/^[A-Za-z]:\\/.test(root)) throw fail(400, "INVALID_OPERATION");
  if (root.length === 3) throw fail(403, "PROJECT_UNAVAILABLE");
  if (root.endsWith("\\")) throw fail(400, "INVALID_OPERATION");
  for (const part of root.slice(3).split("\\")) validateLeaf(part);
  if (restrictedProjectRoot(root)) throw fail(403, "SENSITIVE_PATH");
}

function validateRelative(relative, allowEmpty) {
  if (typeof relative !== "string" || relative.length > 4096 || /[\x00-\x1f\x7f]/.test(relative) || relative.includes("\\") || relative.includes(":")) throw fail(400, "INVALID_OPERATION");
  if (relative.length === 0) {
    if (allowEmpty) return;
    throw fail(400, "INVALID_OPERATION");
  }
  if (relative.startsWith("/") || relative.endsWith("/")) throw fail(400, "INVALID_OPERATION");
  for (const part of relative.split("/")) validateLeaf(part);
  if (hiddenProjectPath(relative)) throw fail(403, "SENSITIVE_PATH");
}

function validateOperation(operation) {
  if (!operation || typeof operation !== "object" || Array.isArray(operation)) throw fail(400, "INVALID_OPERATION");
  const kind = operation.kind;
  const allowed = {
    context: ["id", "kind", "root", "relativePath"],
    mkdir: ["id", "kind", "root", "relativePath"],
    upload: ["id", "kind", "root", "relativePath", "stagedPath", "stagedHash"],
    "edit-open": ["id", "kind", "root", "relativePath"],
    "save-text": ["id", "kind", "root", "relativePath", "stagedPath", "stagedHash", "expectedVersion", "recoveryBinding"]
  }[kind];
  if (!allowed) throw fail(400, "INVALID_OPERATION");
  for (const key of Object.keys(operation)) if (!allowed.includes(key)) throw fail(400, "INVALID_OPERATION");
  if (!HEX32.test(operation.id)) throw fail(400, "INVALID_OPERATION");
  validateRoot(operation.root);
  validateRelative(operation.relativePath, kind === "context");
  if (kind === "upload" || kind === "save-text") {
    if (typeof operation.stagedPath !== "string" || !operation.stagedPath || !path.isAbsolute(operation.stagedPath) || operation.stagedPath.startsWith("\\\\")) throw fail(400, "INVALID_OPERATION");
    if (!HEX64.test(operation.stagedHash)) throw fail(400, "INVALID_OPERATION");
  }
  if (kind === "save-text") {
    if (!VERSION.test(operation.expectedVersion)) throw fail(400, "INVALID_OPERATION");
    if (!HEX64.test(operation.recoveryBinding)) throw fail(400, "INVALID_OPERATION");
  }
  return Object.freeze({
    id: operation.id,
    kind,
    root: operation.root,
    relativePath: operation.relativePath,
    stagedPath: operation.stagedPath,
    stagedHash: operation.stagedHash,
    expectedVersion: operation.expectedVersion,
    recoveryBinding: operation.recoveryBinding
  });
}

// Fail-closed canonicalisation of an existing directory: 8.3 short names are expanded by realpath,
// the drive letter is upper-cased and the rest of the case is preserved. A failed realpath is an
// error, never a silent fallback to the un-canonicalised spelling.
async function canonicalExistingDir(value, status, code) {
  if (typeof value !== "string" || !value || value.length > 4096 || value.includes("\0") || !path.isAbsolute(value)) throw fail(status, code);
  if (process.platform === "win32" && (value.startsWith("\\\\") || /^[A-Za-z]:\\?$/.test(value))) throw fail(status, code);
  let stat;
  try { stat = await fs.lstat(value, { bigint: true }); } catch { throw fail(status, code); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail(status, code);
  let real;
  try { real = await fs.realpath(value); } catch { throw fail(status, code); }
  const realStat = await fs.lstat(real, { bigint: true }).catch(() => null);
  if (!realStat || !realStat.isDirectory() || realStat.isSymbolicLink()) throw fail(status, code);
  if (path.parse(real).root === real) throw fail(status, code);
  return driveOnly(real);
}

const canonicalDataDir = dataDir => canonicalExistingDir(dataDir, 400, "INVALID_ARGUMENT");

async function assertNoLinks(base, target) {
  const relative = path.relative(base, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw fail(403, "STAGE_INVALID");
  let current = base;
  for (const part of relative.split(path.sep)) {
    if (!part) continue;
    current = path.join(current, part);
    const stat = await fs.lstat(current, { bigint: true }).catch(() => null);
    if (!stat || stat.isSymbolicLink()) throw fail(403, "STAGE_INVALID");
  }
}

function validateSaveStage(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) throw fail(400, "STAGE_INVALID");
  if (bytes.includes(0)) throw fail(400, "STAGE_INVALID");
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw fail(400, "STAGE_INVALID"); }
  if (text.includes("\r")) throw fail(400, "STAGE_INVALID");
}

async function validateStage(operation, dataDir) {
  if (operation.kind !== "upload" && operation.kind !== "save-text") return null;
  const limit = operation.kind === "save-text" ? LIMITS.textBytes : LIMITS.uploadBytes;
  let lstat;
  try { lstat = await fs.lstat(operation.stagedPath, { bigint: true }); } catch { throw fail(403, "STAGE_INVALID"); }
  if (!lstat.isFile() || lstat.isSymbolicLink() || lstat.nlink !== 1n) throw fail(403, "STAGE_INVALID");
  let real;
  try { real = await fs.realpath(operation.stagedPath); } catch { throw fail(403, "STAGE_INVALID"); }
  if (!insideCanonical(dataDir, real)) throw fail(403, "STAGE_INVALID");
  await assertNoLinks(dataDir, real);
  if (lstat.size > BigInt(limit)) throw fail(413, "TOO_LARGE");
  const handle = await fs.open(real, "r").catch(() => { throw fail(403, "STAGE_INVALID"); });
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n) throw fail(403, "STAGE_INVALID");
    if (stat.size > BigInt(limit)) throw fail(413, "TOO_LARGE");
    const buffer = Buffer.alloc(Number(stat.size) + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset !== Number(stat.size)) throw fail(409, "STAGE_CHANGED");
    const bytes = buffer.subarray(0, offset);
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (hash !== operation.stagedHash) throw fail(409, "STAGE_CHANGED");
    if (operation.kind === "save-text") validateSaveStage(bytes);
    return { path: real, hash, size: bytes.length };
  } finally {
    await handle.close();
  }
}

function requireOnly(message, allowed) {
  for (const key of Object.keys(message)) if (!allowed.includes(key)) throw fail(502, "PROTOCOL_ERROR");
}
function identity(value) {
  if (typeof value !== "string" || !IDENTITY.test(value)) throw fail(502, "PROTOCOL_ERROR");
  return value;
}
function version(value, nullable = false) {
  if (nullable && (value === null || value === undefined)) return null;
  if (typeof value !== "string" || !VERSION.test(value)) throw fail(502, "PROTOCOL_ERROR");
  return value;
}
function integer(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw fail(502, "PROTOCOL_ERROR");
  return value;
}
function boolean(value) {
  if (typeof value !== "boolean") throw fail(502, "PROTOCOL_ERROR");
  return value;
}
function eol(value) {
  if (value !== "lf" && value !== "crlf" && value !== "mixed") throw fail(502, "PROTOCOL_ERROR");
  return value;
}
function reason(value) {
  if (value !== null && value !== undefined && typeof value !== "string") throw fail(502, "PROTOCOL_ERROR");
  return value ?? null;
}

function sanitizePrepared(message, operation) {
  requireOnly(message, ["v", "t", "operationId", "kind", "path", "rootIdentity", "parentIdentity", "targetIdentity", "currentVersion", "size", "newSize", "bom", "eol", "editable", "reason"]);
  if (message.operationId !== operation.id || message.path !== operation.relativePath) throw fail(502, "PROTOCOL_ERROR");
  if (message.kind !== ((operation.kind === "context" || operation.kind === "mkdir") ? "directory" : "file")) throw fail(502, "PROTOCOL_ERROR");
  const prepared = {
    operationId: operation.id,
    kind: operation.kind,
    relativePath: operation.relativePath,
    rootIdentity: identity(message.rootIdentity),
    parentIdentity: identity(message.parentIdentity)
  };
  if (message.targetIdentity != null) prepared.targetIdentity = identity(message.targetIdentity);
  if (message.currentVersion != null) {
    prepared.currentVersion = version(message.currentVersion);
    prepared.version = prepared.currentVersion;
  }
  if (message.size !== undefined) prepared.size = integer(message.size);
  if (message.newSize !== undefined) prepared.newSize = integer(message.newSize);
  if (message.bom !== undefined) prepared.bom = boolean(message.bom);
  if (message.eol !== undefined) prepared.eol = eol(message.eol);
  if (message.editable !== undefined) prepared.editable = boolean(message.editable);
  if (message.reason !== undefined) prepared.reason = reason(message.reason);
  if (operation.kind === "save-text") {
    if (!prepared.currentVersion || !Number.isSafeInteger(prepared.newSize)) throw fail(502, "PROTOCOL_ERROR");
  }
  if (operation.kind === "edit-open") {
    if (!Number.isSafeInteger(prepared.size) || typeof prepared.editable !== "boolean" || !prepared.eol || typeof prepared.bom !== "boolean") throw fail(502, "PROTOCOL_ERROR");
  }
  return Object.freeze(prepared);
}

function sanitizeResult(message, operation) {
  requireOnly(message, ["v", "t", "operationId", "kind", "path", "rootIdentity", "parentIdentity", "targetIdentity", "version", "newVersion", "size", "text", "bom", "eol", "editable", "reason", "recoveryPending", "recoveryId"]);
  if (message.operationId !== operation.id || message.path !== operation.relativePath) throw fail(502, "PROTOCOL_ERROR");
  const result = {
    path: operation.relativePath,
    kind: message.kind,
    rootIdentity: identity(message.rootIdentity),
    parentIdentity: identity(message.parentIdentity)
  };
  if (message.targetIdentity != null) result.targetIdentity = identity(message.targetIdentity);
  if (operation.kind === "context" || operation.kind === "mkdir") {
    if (result.kind !== "directory" || !result.targetIdentity) throw fail(502, "PROTOCOL_ERROR");
    return Object.freeze(result);
  }
  if (result.kind !== "file") throw fail(502, "PROTOCOL_ERROR");
  if (operation.kind === "upload") {
    result.size = integer(message.size);
    result.version = version(message.version);
    return Object.freeze(result);
  }
  if (operation.kind === "save-text") {
    const next = version(message.newVersion ?? message.version);
    result.size = integer(message.size);
    result.version = next;
    result.newVersion = next;
    if (message.bom !== undefined) result.bom = boolean(message.bom);
    if (message.eol !== undefined) result.eol = eol(message.eol);
    if (message.recoveryPending !== undefined) {
      if (boolean(message.recoveryPending) !== true || typeof message.recoveryId !== "string" || !HEX64.test(message.recoveryId)) throw fail(502, "PROTOCOL_ERROR");
      result.recoveryPending = true;
      result.recoveryId = message.recoveryId;
    }
    return Object.freeze(result);
  }
  if (operation.kind === "edit-open") {
    result.size = integer(message.size);
    result.editable = boolean(message.editable);
    result.bom = boolean(message.bom);
    result.eol = eol(message.eol);
    result.reason = reason(message.reason);
    result.version = version(message.version, true);
    if (result.editable) {
      if (typeof message.text !== "string") throw fail(502, "PROTOCOL_ERROR");
      result.text = message.text;
    } else {
      if (message.text !== null) throw fail(502, "PROTOCOL_ERROR");
      result.text = null;
    }
    return Object.freeze(result);
  }
  throw fail(502, "PROTOCOL_ERROR");
}

function helperError(message) {
  requireOnly(message, ["v", "t", "code", "status", "recoveryId", "cleanupIdentity"]);
  if (typeof message.code !== "string" || !/^[A-Z][A-Z0-9_]{1,40}$/.test(message.code)) throw fail(502, "PROTOCOL_ERROR");
  if (!Number.isInteger(message.status) || message.status < 400 || message.status > 599) throw fail(502, "PROTOCOL_ERROR");
  let recoveryId = null;
  if (message.recoveryId !== undefined && message.recoveryId !== null) {
    if (!HEX64.test(message.recoveryId)) throw fail(502, "PROTOCOL_ERROR");
    recoveryId = message.recoveryId;
  }
  let cleanupIdentity = null;
  if (message.cleanupIdentity !== undefined && message.cleanupIdentity !== null) cleanupIdentity = identity(message.cleanupIdentity);
  return fail(message.status, message.code, recoveryId, cleanupIdentity);
}

function phaseError(phase) {
  return phase === "commit" ? fail(504, "COMMIT_UNKNOWN") : fail(502, "PREPARE_FAILED");
}

function withTimeout(promise, ms, onTimeout) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try { onTimeout?.(); } catch { }
      reject(fail(504, "TIMEOUT"));
    }, ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function raceAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(fail(499, "CANCELLED"));
  return new Promise((resolve, reject) => {
    const onAbort = () => { cleanup(); reject(fail(499, "CANCELLED")); };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

class NativeHelper {
  constructor(child, operationId) {
    this.child = child;
    this.operationId = operationId;
    this.buffer = Buffer.alloc(0);
    this.frames = [];
    this.waiters = [];
    this.failure = null;
    this.closed = false;
    this.exit = new Promise(resolve => child.once("close", (code, signal) => {
      this.closed = true;
      for (const waiter of this.waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(this.failure || phaseError(waiter.phase));
      }
      resolve({ code, signal });
    }));
    child.stdout.on("data", chunk => this.onData(chunk));
    child.stdout.on("error", () => {});
    child.stderr.on("data", () => {});
    child.stderr.on("error", () => {});
    child.stdin.on("error", () => {});
    child.on("error", () => this.failNow(fail(503, "NATIVE_UNAVAILABLE")));
  }
  failNow(error) {
    if (!this.failure) this.failure = error;
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }
  onData(chunk) {
    if (this.failure) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > LIMITS.frameBytes + 4) { this.failNow(fail(502, "PROTOCOL_ERROR")); this.child.kill(); return; }
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length <= 0 || length > LIMITS.frameBytes) { this.failNow(fail(502, "PROTOCOL_ERROR")); this.child.kill(); return; }
      if (this.buffer.length < 4 + length) return;
      const body = this.buffer.subarray(4, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);
      let message;
      try { message = JSON.parse(body.toString("utf8")); } catch { this.failNow(fail(502, "PROTOCOL_ERROR")); this.child.kill(); return; }
      if (!message || typeof message !== "object" || message.v !== 1 || typeof message.t !== "string") { this.failNow(fail(502, "PROTOCOL_ERROR")); this.child.kill(); return; }
      const waiter = this.waiters.shift();
      if (waiter) { clearTimeout(waiter.timer); waiter.resolve(message); } else this.frames.push(message);
    }
  }
  next(ms, phase) {
    if (this.frames.length) return Promise.resolve(this.frames.shift());
    if (this.failure) return Promise.reject(this.failure);
    if (this.closed) return Promise.reject(phaseError(phase));
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, phase, timer: null };
      waiter.timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(phaseError(phase));
        try { this.child.kill(); } catch { }
      }, ms);
      waiter.timer.unref?.();
      this.waiters.push(waiter);
    });
  }
  send(message) {
    if (this.failure) throw this.failure;
    if (this.closed) throw fail(502, "HELPER_EXIT");
    const body = Buffer.from(JSON.stringify(message), "utf8");
    if (body.length <= 0 || body.length > LIMITS.prepareBytes) throw fail(400, "INVALID_OPERATION");
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length, 0);
    this.child.stdin.write(Buffer.concat([header, body]));
  }
  endInput() { try { this.child.stdin.end(); } catch { } }
  async abort() {
    try { this.send({ v: 1, t: "abort", operationId: this.operationId }); } catch { }
    this.endInput();
    try { await this.next(3000, "prepare"); } catch { }
    await this.terminate();
  }
  async terminate() {
    this.endInput();
    let result = await Promise.race([this.exit, new Promise(resolve => { const timer = setTimeout(() => resolve(null), 2500); timer.unref?.(); })]);
    if (result === null && !this.closed) { try { this.child.kill(); } catch { } }
    result = await Promise.race([this.exit, new Promise(resolve => { const timer = setTimeout(() => resolve(null), 3000); timer.unref?.(); })]);
    return result;
  }
}

async function sourceDigest() {
  return createHash("sha256").update(await fs.readFile(SOURCE)).digest("hex").slice(0, 24);
}

async function hashRegularFile(file) {
  try {
    const stat = await fs.lstat(file, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) return null;
    return createHash("sha256").update(await fs.readFile(file)).digest("hex");
  } catch { return null; }
}

async function readSidecar(file) {
  try {
    const stat = await fs.lstat(`${file}.sha256`, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.size > 128n) return null;
    const text = (await fs.readFile(`${file}.sha256`, "utf8")).trim();
    return HEX64.test(text) ? text : null;
  } catch { return null; }
}

async function writeSidecar(file, hash) {
  await fs.writeFile(`${file}.sha256`, `${hash}\n`, { mode: 0o600 });
}

// Operational integrity of the cached helper binary (dataDir and the app tree are operator-trusted,
// not a defence against a malicious same-OS-user). Every execution re-lstats the path, rejects links
// and hardlinks, and compares the compiled hash with the recorded sidecar.
async function verifyBuilt(built) {
  const actual = await hashRegularFile(built.path);
  if (!actual || actual !== built.hash) return false;
  return (await readSidecar(built.path)) === built.hash;
}

function prepareMessage(operation, dataDir, stage) {
  const message = {
    v: 1,
    t: "prepare",
    operationId: operation.id,
    kind: operation.kind,
    root: operation.root,
    relativePath: operation.relativePath,
    dataDir
  };
  if (stage) { message.stagedPath = stage.path; message.stagedHash = stage.hash; message.stagedSize = stage.size; }
  if (operation.expectedVersion) message.expectedVersion = operation.expectedVersion;
  if (operation.recoveryBinding) message.recoveryBinding = operation.recoveryBinding;
  return message;
}

function createRuntime(configuration = {}) {
  const testMode = configuration.testMode === true;
  const cacheName = testMode ? "project-writer-test" : "project-writer";
  const defines = testMode ? ["/define:PROJECT_WRITER_TESTS"] : [];
  const builds = new Map();

  async function compile(dataDir, sourceHash, reuse) {
    const directory = path.join(dataDir, cacheName, sourceHash);
    await fs.mkdir(directory, { recursive: true });
    const target = path.join(directory, "ProjectWriter.exe");
    if (reuse) {
      const cached = await readSidecar(target);
      // A cached binary without a matching recorded hash is never executed; it is rebuilt below.
      if (cached) return { path: target, hash: cached };
    }
    const windir = process.env.WINDIR;
    if (!windir) throw fail(503, "NATIVE_UNAVAILABLE");
    const candidates = [
      path.join(windir, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
      path.join(windir, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe")
    ];
    let compiler = null;
    for (const candidate of candidates) {
      try { await fs.access(candidate); compiler = candidate; break; } catch { }
    }
    if (!compiler) throw fail(503, "NATIVE_UNAVAILABLE");
    const temporary = path.join(directory, `ProjectWriter-${process.pid}-${randomBytes(6).toString("hex")}.tmp.exe`);
    try {
      await execFileAsync(compiler, ["/nologo", "/target:exe", "/r:System.Web.Extensions.dll", ...defines, `/out:${temporary}`, SOURCE], { windowsHide: true, timeout: 30000, maxBuffer: 1048576 });
      const hash = await hashRegularFile(temporary);
      if (!hash) throw fail(503, "NATIVE_UNAVAILABLE");
      if (reuse) {
        try { await fs.rename(temporary, target); } catch { }
        if ((await hashRegularFile(target)) === hash) {
          await writeSidecar(target, hash);
          return { path: target, hash };
        }
        // A changed or corrupt cached binary is left untouched (never executed, never deleted).
      }
      await writeSidecar(temporary, hash);
      return { path: temporary, hash };
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => {});
      await fs.rm(`${temporary}.sha256`, { force: true }).catch(() => {});
      if (isError(error)) throw error;
      throw fail(503, "NATIVE_UNAVAILABLE");
    }
  }

  async function build(dataDir) {
    const sourceHash = await sourceDigest();
    const key = `${dataDir}\0${sourceHash}\0${cacheName}`;
    let pending = builds.get(key);
    if (!pending) {
      pending = compile(dataDir, sourceHash, true);
      builds.set(key, pending);
      pending.catch(() => builds.delete(key));
    }
    const built = await pending;
    if (await verifyBuilt(built)) return built.path;
    builds.delete(key);
    const concurrent = builds.get(key);
    if (concurrent) {
      const other = await concurrent;
      if (await verifyBuilt(other)) return other.path;
      throw fail(503, "NATIVE_UNAVAILABLE");
    }
    const fresh = compile(dataDir, sourceHash, false);
    builds.set(key, fresh);
    fresh.catch(() => builds.delete(key));
    const replacement = await fresh;
    if (!(await verifyBuilt(replacement))) throw fail(503, "NATIVE_UNAVAILABLE");
    return replacement.path;
  }

  async function runProjectWriter(options) {
    const { dataDir, operation, authorizePrepared, signal } = options || {};
    if (!testMode && options?.faults !== undefined) throw fail(400, "INVALID_ARGUMENT");
    if (typeof authorizePrepared !== "function") throw fail(403, "AUTHORIZATION_REQUIRED");
    if (signal?.aborted) throw fail(499, "CANCELLED");
    const faults = testMode && Array.isArray(options?.faults) ? options.faults : [];
    const preparedOperation = validateOperation(operation);
    const canonicalData = await canonicalDataDir(dataDir);
    const stage = await validateStage(preparedOperation, canonicalData);
    if (signal?.aborted) throw fail(499, "CANCELLED");
    if (process.platform === "win32") {
      const canonicalRoot = await canonicalExistingDir(preparedOperation.root, 403, "PROJECT_UNAVAILABLE");
      if (insideCanonical(canonicalData, canonicalRoot) || insideCanonical(canonicalRoot, canonicalData)) throw fail(403, "SENSITIVE_PATH");
    }
    if (process.platform !== "win32") throw fail(503, "NATIVE_UNAVAILABLE");
    const executable = await build(canonicalData);
    const environment = faults.length
      ? {
        ...process.env,
        PROJECT_WRITER_TEST_FAULT: faults.join(","),
        PROJECT_WRITER_TEST_MARKER: path.join(canonicalData, "project-writes", "pw-test-checkpoint"),
        PROJECT_WRITER_TEST_RESUME: path.join(canonicalData, "project-writes", "pw-test-resume")
      }
      : undefined;
    const child = spawn(executable, [], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: environment });
    const helper = new NativeHelper(child, preparedOperation.id);
    try {
      helper.send(prepareMessage(preparedOperation, canonicalData, stage));
      let message;
      try {
        message = await raceAbort(helper.next(LIMITS.prepareMs, "prepare"), signal);
      } catch (error) {
        if (error?.code === "CANCELLED") await helper.abort();
        throw error;
      }
      if (message.t === "error") throw helperError(message);
      if (message.t !== "prepared") throw fail(502, "PROTOCOL_ERROR");
      const prepared = sanitizePrepared(message, preparedOperation);
      if (signal?.aborted) { await helper.abort(); throw fail(499, "CANCELLED"); }
      let allowed;
      try {
        const authorization = Promise.resolve().then(() => authorizePrepared(prepared));
        authorization.catch(() => {});
        allowed = await raceAbort(withTimeout(authorization, LIMITS.authorizeMs, () => {}), signal);
      } catch (error) {
        await helper.abort();
        if (error?.code === "CANCELLED") throw fail(499, "CANCELLED");
        if (isError(error) && error.code !== "TIMEOUT") throw error;
        throw fail(403, "AUTHORIZATION_DENIED");
      }
      if (allowed !== true || signal?.aborted) {
        await helper.abort();
        if (signal?.aborted) throw fail(499, "CANCELLED");
        throw fail(403, "AUTHORIZATION_DENIED");
      }
      helper.send({ v: 1, t: "commit", operationId: preparedOperation.id });
      helper.endInput();
      const result = await helper.next(LIMITS.commitMs, "commit");
      if (result.t === "error") throw helperError(result);
      if (result.t !== "result") throw fail(504, "COMMIT_UNKNOWN");
      return sanitizeResult(result, preparedOperation);
    } finally {
      await helper.terminate();
    }
  }

  return { runProjectWriter };
}

export const runProjectWriter = createRuntime().runProjectWriter;

// TEST-ONLY factory: builds the helper with /define:PROJECT_WRITER_TESTS into a separate cache
// directory and forwards fault names through the child environment. Production wiring must use
// runProjectWriter, which rejects a `faults` field outright.
export function createProjectWriterTestRuntime() {
  return createRuntime({ testMode: true }).runProjectWriter;
}
