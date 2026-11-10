import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";

const MIB = 1024 * 1024;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const CHUNK = 64 * 1024;
const MANIFEST_LIMIT = 64 * 1024;
const PRUNE_BATCH = 64;

export const CHAT_ATTACHMENT_LIMITS = Object.freeze({
  fileBytes: 25 * MIB,
  filesPerDraft: 20,
  draftBytes: 100 * MIB,
  principalBytes: 256 * MIB,
  globalBytes: 1024 * MIB,
  concurrentGlobal: 2,
  concurrentDraft: 1,
  reservationBytes: 25 * MIB,
  readyTtlMs: 24 * HOUR,
  sentTtlMs: 7 * DAY,
  maxManifestEntries: 20000
});

const LIMITS = CHAT_ATTACHMENT_LIMITS;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ID_RE = /^[0-9a-f]{32}$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\u2028\u2029]/g;
const CONTROL_TEST = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\u2028\u2029]/;
const MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,79}$/;

const ERRORS = {
  invalid_input: [400, "Invalid attachment request"], invalid_context: [400, "Invalid attachment context"], invalid_draft: [400, "Invalid draft identifier"], invalid_name: [400, "Invalid attachment name"],
  invalid_type: [400, "Invalid attachment type"], invalid_stream: [400, "Attachment stream is not readable"], empty_file: [400, "Empty attachments are not supported"], file_too_large: [413, "Attachment exceeds the 25 MiB file limit"],
  quota_exceeded: [413, "Attachment storage quota exceeded"], too_many_files: [429, "Too many active attachments for this draft"], busy: [429, "Attachment upload concurrency limit reached"], not_found: [404, "Attachment not found"],
  forbidden: [403, "Attachment is not accessible in this context"], thread_mismatch: [403, "Attachment is bound to another thread"], expired: [410, "Attachment has expired"], tampered: [409, "Attachment verification failed"],
  leased: [409, "Attachment is held by an active read lease"], sent: [409, "Attachment was sent and is retained"], unavailable: [503, "Attachment storage is unavailable"], closed: [503, "Attachment store is closed"]
};

export class ChatAttachmentError extends Error {
  constructor(code) {
    const [status, message] = ERRORS[code] ?? [500, "Attachment operation failed"];
    super(message);
    this.name = "ChatAttachmentError";
    this.code = ERRORS[code] ? code : "internal";
    this.status = status;
  }
}

function fail(code) {
  throw new ChatAttachmentError(code);
}

function mtimeKey(stat) {
  return stat.mtimeNs !== undefined ? String(stat.mtimeNs) : String(Math.trunc(Number(stat.mtimeMs) * 1e6));
}

function normalizeCwd(cwd) {
  const normalized = path.normalize(cwd);
  const root = path.parse(normalized).root;
  const trimmed = normalized.length > root.length && /[\\/]$/.test(normalized) ? normalized.slice(0, -1) : normalized;
  return trimmed;
}

function draftKey(principalId, scopeId, cwd, draftId) {
  return `${principalId}\u0000${scopeId}\u0000${cwd}\u0000${draftId}`;
}

function normalizeContext(context) {
  if (!context || typeof context !== "object" || Array.isArray(context)) fail("invalid_context");
  const principalId = typeof context.principalId === "string" ? context.principalId.trim() : "";
  const scopeId = typeof context.scopeId === "string" ? context.scopeId.trim() : "";
  if (!principalId || principalId.length > 200 || CONTROL_TEST.test(principalId)) fail("invalid_context");
  if (!scopeId || scopeId.length > 200 || CONTROL_TEST.test(scopeId)) fail("invalid_context");
  if (typeof context.cwd !== "string" || !context.cwd || context.cwd.length > 4096) fail("invalid_context");
  if (CONTROL_TEST.test(context.cwd) || !path.isAbsolute(context.cwd)) fail("invalid_context");
  const cwd = normalizeCwd(context.cwd);
  if (typeof context.draftId !== "string" || !UUID_RE.test(context.draftId)) fail("invalid_draft");
  const draftId = context.draftId.toLowerCase();
  let threadId = null;
  if (context.threadId !== undefined && context.threadId !== null) {
    if (typeof context.threadId !== "string") fail("invalid_context");
    const value = context.threadId.trim();
    if (!value || value.length > 200 || CONTROL_TEST.test(value)) fail("invalid_context");
    threadId = value;
  }
  return { principalId, scopeId, cwd, draftId, threadId, draftKey: draftKey(principalId, scopeId, cwd, draftId) };
}

function safeDisplayName(raw) {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 4096) fail("invalid_name");
  const base = raw.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(CONTROL_CHARS, "").replace(/[ .]+$/u, "").trim();
  if (!cleaned) fail("invalid_name");
  return cleaned.length > 180 ? cleaned.slice(0, 180) : cleaned;
}

function safeMime(raw) {
  if (raw === undefined || raw === null || raw === "") return "application/octet-stream";
  if (typeof raw !== "string" || raw.length > 512) return "application/octet-stream";
  const value = raw.split(";")[0].trim().toLowerCase();
  return MIME_RE.test(value) ? value : "application/octet-stream";
}

function extensionOf(name) {
  const match = /\.([a-z0-9]{1,12})$/i.exec(name);
  return match ? `.${match[1].toLowerCase()}` : "";
}

function dto(record) {
  return {
    id: record.id,
    name: record.name,
    size: record.size,
    mime: record.mime,
    status: record.status,
    expiresAt: new Date(record.expiresAt).toISOString()
  };
}

function manifestOf(record) {
  const { id, principalId, scopeId, cwd, draftId, threadId, name, mime, ext, size, sha256, storageKey, identity, createdAt, expiresAt, status, sentAt } = record;
  return { version: 1, id, principalId, scopeId, cwd, draftId, threadId, name, mime, ext, size, sha256, storageKey, identity, createdAt, expiresAt, status, sentAt };
}

export function checkAttachmentQuota(usage, reserve = LIMITS.reservationBytes) {
  const draftCount = Number(usage?.draftCount) || 0;
  const draftBytes = Number(usage?.draftBytes) || 0;
  const principalBytes = Number(usage?.principalBytes) || 0;
  const globalBytes = Number(usage?.globalBytes) || 0;
  if (draftCount >= LIMITS.filesPerDraft) return "too_many_files";
  if (draftBytes + reserve > LIMITS.draftBytes) return "quota_exceeded";
  if (principalBytes + reserve > LIMITS.principalBytes) return "quota_exceeded";
  if (globalBytes + reserve > LIMITS.globalBytes) return "quota_exceeded";
  return null;
}

function validateManifest(raw, id) {
  if (!raw || typeof raw !== "object" || raw.version !== 1 || raw.id !== id || !ID_RE.test(id)) return null;
  const text = (value, max) => typeof value === "string" && value.length > 0 && value.length <= max && !CONTROL_TEST.test(value);
  if (!text(raw.principalId, 200) || !text(raw.scopeId, 200) || !text(raw.cwd, 4096)) return null;
  if (typeof raw.cwd !== "string" || !path.isAbsolute(raw.cwd) || normalizeCwd(raw.cwd) !== raw.cwd) return null;
  if (typeof raw.draftId !== "string" || !UUID_RE.test(raw.draftId) || raw.draftId !== raw.draftId.toLowerCase()) return null;
  if (raw.threadId !== null && !text(raw.threadId, 200)) return null;
  if (!text(raw.name, 400) || !text(raw.mime, 400)) return null;
  if (!Number.isSafeInteger(raw.size) || raw.size <= 0 || raw.size > LIMITS.fileBytes) return null;
  if (typeof raw.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(raw.sha256)) return null;
  if (raw.storageKey !== `${id}.blob`) return null;
  if (!raw.identity || typeof raw.identity !== "object") return null;
  const { dev, ino, mtimeNs } = raw.identity;
  if (typeof dev !== "string" || typeof ino !== "string" || typeof mtimeNs !== "string") return null;
  if (!Number.isSafeInteger(raw.createdAt) || !Number.isSafeInteger(raw.expiresAt) || raw.expiresAt < raw.createdAt) return null;
  if (raw.status !== "ready" && raw.status !== "sent") return null;
  if (raw.sentAt !== null && !Number.isSafeInteger(raw.sentAt)) return null;
  const record = { id, draftKey: draftKey(raw.principalId, raw.scopeId, raw.cwd, raw.draftId), ext: typeof raw.ext === "string" ? raw.ext.slice(0, 32) : "", identity: { dev, ino, size: raw.size, mtimeNs }, leaseCount: 0, removed: false };
  return { ...record, principalId: raw.principalId, scopeId: raw.scopeId, cwd: raw.cwd, draftId: raw.draftId, threadId: raw.threadId, name: raw.name, mime: raw.mime, size: raw.size, sha256: raw.sha256, storageKey: raw.storageKey, createdAt: raw.createdAt, expiresAt: raw.expiresAt, status: raw.status, sentAt: raw.sentAt };
}

async function hashHandle(handle) {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(CHUNK);
  let total = 0;
  for (;;) {
    const { bytesRead } = await handle.read(buffer, 0, CHUNK, total);
    if (!bytesRead) break;
    hash.update(buffer.subarray(0, bytesRead));
    total += bytesRead;
  }
  return { bytes: total, sha256: hash.digest("hex") };
}

export class ChatAttachments {
  #dataDir;
  #root;
  #manifests;
  #now;
  #externalLease;
  #opening;
  #records = new Map();
  #reservations = new Map();
  #leases = new Set();
  #uploads = new Set();
  #lock = Promise.resolve();
  #closed = false;

  constructor(options = {}) {
    if (!options || typeof options !== "object") fail("invalid_input");
    if (typeof options.dataDir !== "string" || !path.isAbsolute(options.dataDir)) fail("invalid_input");
    if (options.now !== undefined && typeof options.now !== "function") fail("invalid_input");
    if (options.acquireLease !== undefined && options.acquireLease !== null && typeof options.acquireLease !== "function") fail("invalid_input");
    this.#dataDir = options.dataDir;
    this.#root = path.join(options.dataDir, "chat-attachments");
    this.#manifests = path.join(this.#root, "manifests");
    this.#now = options.now ?? (() => Date.now());
    this.#externalLease = options.acquireLease ?? null;
    this.#opening = this.#open();
    this.#opening.catch(() => {});
  }

  async upload(input) {
    const request = input && typeof input === "object" ? input : {};
    const context = normalizeContext(request.context);
    const name = safeDisplayName(request.name);
    const mime = safeMime(request.type);
    const declaredSize = request.declaredSize;
    const declaredKnown = declaredSize !== undefined && declaredSize !== null;
    if (declaredKnown) {
      if (typeof declaredSize !== "number" || !Number.isSafeInteger(declaredSize) || declaredSize < 0) fail("invalid_input");
      if (declaredSize > LIMITS.fileBytes) fail("file_too_large");
    }
    const stream = request.stream;
    if (!stream || typeof stream[Symbol.asyncIterator] !== "function") fail("invalid_stream");
    await this.#ready();
    const id = randomBytes(16).toString("hex");
    const createdAt = this.#nowMs();
    const reserved = await this.#reserve(context, id, declaredKnown ? declaredSize : null);
    const work = this.#streamToDisk({ id, context, name, mime, stream, createdAt, reservationBytes: reserved, declaredSize: declaredKnown ? declaredSize : null });
    const tracked = work.then(() => {}, () => {});
    this.#uploads.add(tracked);
    tracked.then(() => this.#uploads.delete(tracked), () => this.#uploads.delete(tracked));
    return work;
  }

  async list(context) {
    const ctx = normalizeContext(context);
    await this.#ready();
    return this.#withLock(() => {
      const now = this.#nowMs();
      const items = [];
      for (const record of this.#records.values()) {
        if (record.removed) continue;
        if (record.principalId !== ctx.principalId || record.scopeId !== ctx.scopeId) continue;
        if (record.cwd !== ctx.cwd || record.draftId !== ctx.draftId) continue;
        if (record.threadId && record.threadId !== ctx.threadId) continue;
        if (now >= record.expiresAt) continue;
        items.push(dto(record));
      }
      items.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return items;
    });
  }

  async remove(context, id) {
    const ctx = normalizeContext(context);
    if (typeof id !== "string" || !ID_RE.test(id)) fail("not_found");
    await this.#ready();
    return this.#withLock(async () => {
      const record = this.#records.get(id);
      if (!record || record.removed) fail("not_found");
      this.#assertOwner(record, ctx);
      if (record.threadId && ctx.threadId && record.threadId !== ctx.threadId) fail("thread_mismatch");
      if ((record.leaseCount ?? 0) > 0) fail("leased");
      if (record.sentAt !== null) fail("sent");
      record.removed = true;
      this.#records.delete(id);
      await unlink(path.join(this.#root, record.storageKey)).catch(() => {});
      await unlink(path.join(this.#manifests, `${id}.json`)).catch(() => {});
      return { id };
    });
  }

  async openForDownload(context,id) {
    if(typeof id!=="string"||!ID_RE.test(id)||!context||typeof context.threadId!=="string"||!context.threadId)fail("not_found");
    await this.#ready();
    const ctx=await this.#withLock(()=>{
      const record=this.#records.get(id);
      if(!record||record.removed||record.status!=="sent"||record.threadId!==context.threadId)fail("not_found");
      const bound=normalizeContext({...context,draftId:record.draftId});
      this.#assertOwner(record,bound);
      return bound;
    });
    const lease=await this.acquire(ctx,[id]);
    return {files:lease.files,release:lease.release};
  }

  async acquire(context, ids) {
    const ctx = normalizeContext(context);
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 200) fail("invalid_input");
    const unique = [];
    for (const id of ids) {
      if (typeof id !== "string" || !ID_RE.test(id)) fail("not_found");
      if (!unique.includes(id)) unique.push(id);
    }
    await this.#ready();
    const prepared = await this.#withLock(async () => {
      const now = this.#nowMs();
      const selected = [];
      for (const id of unique) {
        const record = this.#records.get(id);
        if (!record || record.removed) fail("not_found");
        this.#assertOwner(record, ctx);
        if (record.threadId && record.threadId !== ctx.threadId) fail("thread_mismatch");
        if (now >= record.expiresAt) fail("expired");
        selected.push(record);
      }
      const bound = new Set();
      for (const record of selected) {
        if (!record.threadId && ctx.threadId) {
          record.threadId = ctx.threadId;
          bound.add(record.id);
        }
        record.leaseCount = (record.leaseCount ?? 0) + 1;
      }
      try {
        for (const record of selected) if (bound.has(record.id)) await this.#persist(record);
      } catch (error) {
        for (const record of selected) {
          record.leaseCount = Math.max(0, (record.leaseCount ?? 0) - 1);
          if (bound.has(record.id) && record.leaseCount === 0) record.threadId = null;
        }
        throw error;
      }
      return { ids: selected.map(record => record.id), bound: [...bound] };
    }).catch(error => {
      throw error instanceof ChatAttachmentError ? error : new ChatAttachmentError("unavailable");
    });

    const opened = [];
    const natives = [];
    try {
      for (const id of prepared.ids) {
        const record = this.#records.get(id);
        if (!record || record.removed) fail("not_found");
        const handle = await this.#verifyAndOpen(record);
        opened.push({ record, ...handle });
        if (this.#externalLease) {
          let lease = null;
          try {
            lease = await this.#externalLease({ root: this.#root, relative: record.storageKey, kind: "read" });
          } catch {
            fail("unavailable");
          }
          if (!lease || lease.alive !== true) {
            try { await lease?.close?.(); } catch { /* ignore */ }
            fail("unavailable");
          }
          natives.push(lease);
        }
      }
    } catch (error) {
      for (const item of opened) await item.handle.close().catch(() => {});
      for (const lease of natives) { try { await lease.close?.(); } catch { /* ignore */ } }
      await this.#rollback(prepared.ids, prepared.bound).catch(() => {});
      throw error instanceof ChatAttachmentError ? error : new ChatAttachmentError("unavailable");
    }

    const files = opened.map(item => ({
      id: item.record.id,
      name: item.record.name,
      size: item.record.size,
      mime: item.record.mime,
      path: item.path,
      sha256: item.record.sha256
    }));
    let settled = false;
    const cleanup = async () => {
      for (const item of opened) await item.handle.close().catch(() => {});
      for (const lease of natives) { try { await lease.close?.(); } catch { /* ignore */ } }
    };
    const lease = {
      files,
      release: async () => {
        if (settled) return;
        settled = true;
        await cleanup();
        await this.#withLock(() => {
          for (const id of prepared.ids) {
            const record = this.#records.get(id);
            if (record) record.leaseCount = Math.max(0, (record.leaseCount ?? 0) - 1);
          }
        }).catch(() => {});
        this.#leases.delete(lease);
      },
      commit: async () => {
        if (settled) return;
        settled = true;
        await cleanup();
        await this.#withLock(async () => {
          const now = this.#nowMs();
          for (const id of prepared.ids) {
            const record = this.#records.get(id);
            if (!record) continue;
            record.leaseCount = Math.max(0, (record.leaseCount ?? 0) - 1);
            if (record.sentAt === null) {
              record.status = "sent";
              record.sentAt = now;
              record.expiresAt = now + LIMITS.sentTtlMs;
            }
            await this.#persist(record);
          }
        });
        this.#leases.delete(lease);
      }
    };
    this.#leases.add(lease);
    return lease;
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    await this.#opening.catch(() => {});
    await Promise.allSettled([...this.#uploads]);
    for (const lease of [...this.#leases]) {
      try { await lease.release(); } catch { /* ignore */ }
    }
    this.#leases.clear();
    this.#reservations.clear();
  }

  #assertOwner(record, ctx) {
    if (record.principalId !== ctx.principalId || record.scopeId !== ctx.scopeId) fail("forbidden");
    if (record.cwd !== ctx.cwd || record.draftId !== ctx.draftId) fail("forbidden");
  }

  #nowMs() {
    const value = this.#now();
    const ms = typeof value === "number" ? value : value instanceof Date ? value.getTime() : NaN;
    if (!Number.isFinite(ms)) fail("unavailable");
    return ms;
  }

  #withLock(fn) {
    const next = this.#lock.then(fn, fn);
    this.#lock = next.then(() => {}, () => {});
    return next;
  }

  async #ready() {
    try {
      await this.#opening;
    } catch {
      fail("unavailable");
    }
    if (this.#closed) fail("closed");
  }

  async #open() {
    try {
      await mkdir(this.#root, { recursive: true, mode: 0o700 });
      const rootStat = await lstat(this.#root);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("root");
      this.#root = await realpath(this.#root);
      this.#manifests = path.join(this.#root, "manifests");
      await mkdir(this.#manifests, { recursive: true, mode: 0o700 });
      const manifestStat = await lstat(this.#manifests);
      if (!manifestStat.isDirectory() || manifestStat.isSymbolicLink()) throw new Error("manifests");
      if ((await realpath(this.#manifests)) !== this.#manifests) throw new Error("manifests");
      await this.#restore();
    } catch (error) {
      throw error instanceof ChatAttachmentError ? error : new ChatAttachmentError("unavailable");
    }
  }

  async #restore() {
    const entries = await readdir(this.#root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.name.endsWith(".partial") || !entry.isFile()) continue;
      if (!ID_RE.test(entry.name.slice(0, -".partial".length))) continue;
      await unlink(path.join(this.#root, entry.name)).catch(() => {});
    }
    const manifestEntries = await readdir(this.#manifests, { withFileTypes: true });
    if (manifestEntries.length > LIMITS.maxManifestEntries) fail("unavailable");
    for (const entry of manifestEntries) {
      if (!entry.isFile() || entry.name.endsWith(".tmp")) {
        if (entry.isFile() && entry.name.endsWith(".tmp")) await unlink(path.join(this.#manifests, entry.name)).catch(() => {});
        continue;
      }
      if (!entry.name.endsWith(".json")) continue;
      const id = entry.name.slice(0, -".json".length);
      if (!ID_RE.test(id)) continue;
      const record = await this.#readManifest(id).catch(() => null);
      if (!record) continue;
      if (this.#records.size >= LIMITS.maxManifestEntries) fail("unavailable");
      this.#records.set(id, record);
    }
    await this.#reclaimOrphanBlobs();
  }

  async #reclaimOrphanBlobs() {
    const valid = new Set();
    for (const record of this.#records.values()) valid.add(record.storageKey);
    const entries = await readdir(this.#root, { withFileTypes: true });
    for (const entry of entries) {
      if (!/^[0-9a-f]{32}\.blob$/.test(entry.name)) continue;
      if (valid.has(entry.name)) continue;
      const target = path.join(this.#root, entry.name);
      const info = await lstat(target).catch(() => null);
      if (!info || info.isSymbolicLink() || !info.isFile()) continue;
      await unlink(target).catch(() => {});
    }
  }

  async #readManifest(id) {
    const manifestPath = path.join(this.#manifests, `${id}.json`);
    const stat = await lstat(manifestPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MANIFEST_LIMIT) return null;
    const handle = await open(manifestPath, "r");
    let raw;
    try {
      raw = JSON.parse((await handle.readFile()).toString("utf8"));
    } finally {
      await handle.close().catch(() => {});
    }
    const record = validateManifest(raw, id);
    if (!record) return null;
    const blob = await lstat(path.join(this.#root, record.storageKey), { bigint: true }).catch(() => null);
    if (!blob || blob.isSymbolicLink() || !blob.isFile() || blob.nlink !== 1n) return null;
    if (Number(blob.size) !== record.size) return null;
    if (String(blob.dev) !== record.identity.dev) return null;
    if (String(blob.ino) !== record.identity.ino) return null;
    if (mtimeKey(blob) !== record.identity.mtimeNs) return null;
    return record;
  }

  async #persist(record) {
    const tmp = path.join(this.#manifests, `.${record.id}.${randomBytes(8).toString("hex")}.tmp`);
    try {
      const handle = await open(tmp, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify(manifestOf(record)));
        await handle.sync();
      } finally {
        await handle.close().catch(() => {});
      }
      await rename(tmp, path.join(this.#manifests, `${record.id}.json`));
    } catch {
      await unlink(tmp).catch(() => {});
      fail("unavailable");
    }
  }

  async #reserve(ctx, id, declaredSize) {
    return this.#withLock(async () => {
      await this.#pruneExpired(this.#nowMs());
      let global = 0;
      let draft = 0;
      for (const reservation of this.#reservations.values()) {
        global += 1;
        if (reservation.draftKey === ctx.draftKey) draft += 1;
      }
      if (global >= LIMITS.concurrentGlobal || draft >= LIMITS.concurrentDraft) fail("busy");
      let draftCount = 0;
      let draftBytes = 0;
      let principalBytes = 0;
      let globalBytes = 0;
      for (const record of this.#records.values()) {
        if (record.removed) continue;
        globalBytes += record.size;
        if (record.principalId === ctx.principalId) principalBytes += record.size;
        if (record.draftKey === ctx.draftKey) {
          draftCount += 1;
          draftBytes += record.size;
        }
      }
      for (const reservation of this.#reservations.values()) {
        globalBytes += reservation.bytes;
        if (reservation.principalId === ctx.principalId) principalBytes += reservation.bytes;
        if (reservation.draftKey === ctx.draftKey) draftBytes += reservation.bytes;
      }
      let reserved;
      if (declaredSize !== null && declaredSize !== undefined) {
        reserved = declaredSize;
      } else {
        reserved = Math.min(LIMITS.fileBytes, LIMITS.draftBytes - draftBytes, LIMITS.principalBytes - principalBytes, LIMITS.globalBytes - globalBytes);
        if (reserved <= 0) fail("quota_exceeded");
      }
      const denial = checkAttachmentQuota({ draftCount, draftBytes, principalBytes, globalBytes }, reserved);
      if (denial) fail(denial);
      this.#reservations.set(id, { id, draftKey: ctx.draftKey, principalId: ctx.principalId, bytes: reserved });
      return reserved;
    });
  }

  async #pruneExpired(now) {
    const expired = [];
    for (const record of this.#records.values()) {
      if (expired.length >= PRUNE_BATCH) break;
      if (record.removed) continue;
      if (record.status !== "ready" && record.status !== "sent") continue;
      if ((record.leaseCount ?? 0) > 0) continue;
      if (this.#reservations.has(record.id)) continue;
      if (now < record.expiresAt) continue;
      expired.push(record);
    }
    for (const record of expired) {
      // Keep bytes quota-counted if a live external reader prevents deletion.
      if (record.storageKey !== `${record.id}.blob`) continue;
      try { await unlink(path.join(this.#root, record.storageKey)); }
      catch (error) { if(error.code!=="ENOENT")continue; }
      try { await unlink(path.join(this.#manifests, `${record.id}.json`)); }
      catch (error) { if(error.code!=="ENOENT")continue; }
      record.removed = true;this.#records.delete(record.id);
    }
    return expired.length;
  }

  async #streamToDisk({ id, context, name, mime, stream, createdAt, reservationBytes, declaredSize }) {
    const partialPath = path.join(this.#root, `${id}.partial`);
    const blobPath = path.join(this.#root, `${id}.blob`);
    let handle = null;
    let moved = false;
    try {
      handle = await open(partialPath, "wx", 0o600).catch(() => { throw new ChatAttachmentError("unavailable"); });
      const hash = createHash("sha256");
      let bytes = 0;
      for await (const chunk of stream) {
        if (this.#closed) fail("closed");
        const buffer = Buffer.isBuffer(chunk) ? chunk : chunk instanceof Uint8Array ? Buffer.from(chunk) : null;
        if (!buffer) fail("invalid_stream");
        if (buffer.length === 0) continue;
        bytes += buffer.length;
        if (bytes > LIMITS.fileBytes) fail("file_too_large");
        if (bytes > reservationBytes) fail(declaredSize === null || declaredSize === undefined ? "quota_exceeded" : "tampered");
        hash.update(buffer);
        let offset = 0;
        while (offset < buffer.length) {
          const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset);
          if (!bytesWritten) fail("unavailable");
          offset += bytesWritten;
        }
      }
      if (bytes === 0) fail("empty_file");
      if (declaredSize !== null && declaredSize !== undefined && bytes !== declaredSize) fail("tampered");
      const sha256 = hash.digest("hex");
      await handle.sync();
      const stat = await handle.stat({ bigint: true });
      if (!stat.isFile() || stat.nlink !== 1n || Number(stat.size) !== bytes) fail("tampered");
      const identity = { dev: String(stat.dev), ino: String(stat.ino), size: bytes, mtimeNs: mtimeKey(stat) };
      await handle.close();
      handle = null;
      await rename(partialPath, blobPath).catch(() => { throw new ChatAttachmentError("unavailable"); });
      moved = true;
      const record = {
        id,
        principalId: context.principalId,
        scopeId: context.scopeId,
        cwd: context.cwd,
        draftKey: context.draftKey,
        draftId: context.draftId,
        threadId: null,
        name,
        mime,
        ext: extensionOf(name),
        size: bytes,
        sha256,
        storageKey: `${id}.blob`,
        identity,
        createdAt,
        expiresAt: createdAt + LIMITS.readyTtlMs,
        status: "ready",
        sentAt: null,
        leaseCount: 0,
        removed: false
      };
      await this.#persist(record);
      await this.#withLock(() => {
        this.#reservations.delete(id);
        this.#records.set(id, record);
      });
      return dto(record);
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      await unlink(partialPath).catch(() => {});
      if (moved) await unlink(blobPath).catch(() => {});
      await this.#withLock(() => { this.#reservations.delete(id); }).catch(() => {});
      throw error instanceof ChatAttachmentError ? error : new ChatAttachmentError("unavailable");
    }
  }

  async #verifyAndOpen(record) {
    const blobPath = path.join(this.#root, record.storageKey);
    const before = await lstat(blobPath, { bigint: true }).catch(() => null);
    if (!before || before.isSymbolicLink() || !before.isFile() || before.nlink !== 1n) fail("tampered");
    if (Number(before.size) !== record.size) fail("tampered");
    if (String(before.dev) !== record.identity.dev || String(before.ino) !== record.identity.ino) fail("tampered");
    if (mtimeKey(before) !== record.identity.mtimeNs) fail("tampered");
    let handle = null;
    try {
      handle = await open(blobPath, "r").catch(() => { throw new ChatAttachmentError("tampered"); });
      const after = await handle.stat({ bigint: true });
      if (!after.isFile() || after.nlink !== 1n || Number(after.size) !== record.size) fail("tampered");
      if (String(after.dev) !== record.identity.dev || String(after.ino) !== record.identity.ino) fail("tampered");
      if (mtimeKey(after) !== record.identity.mtimeNs) fail("tampered");
      const digest = await hashHandle(handle);
      if (digest.bytes !== record.size || digest.sha256 !== record.sha256) fail("tampered");
      return { handle, path: blobPath };
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      throw error instanceof ChatAttachmentError ? error : new ChatAttachmentError("tampered");
    }
  }

  async #rollback(ids, bound) {
    const boundSet = new Set(bound);
    await this.#withLock(async () => {
      for (const id of ids) {
        const record = this.#records.get(id);
        if (!record) continue;
        record.leaseCount = Math.max(0, (record.leaseCount ?? 0) - 1);
        if (boundSet.has(id) && record.leaseCount === 0) record.threadId = null;
      }
      for (const id of ids) {
        if (!boundSet.has(id)) continue;
        const record = this.#records.get(id);
        if (record) await this.#persist(record).catch(() => {});
      }
    });
  }
}
