// Independent chat attachment controller (U11).
// Owns attachment selection, sequential upload, retry/remove and the single-send lock.
// It never renders filenames: the parent writes snapshot() strings with textContent only,
// and snapshots never expose local paths, File objects, promises or full context.
const MIB = 1024 * 1024;

export const CHAT_ATTACHMENT_LIMITS = Object.freeze({
  maxFileBytes: 25 * MIB,
  maxFiles: 20,
  maxBatchBytes: 100 * MIB
});

export const CHAT_ATTACHMENT_STATUS = Object.freeze({
  PREPARING: "preparing",
  UPLOADING: "uploading",
  READY: "ready",
  FAILED: "failed",
  UNKNOWN: "unknown",
  SENDING: "sending"
});

const failure = (code) => Object.assign(new Error(code), { code });

const isFileLike = (file) => Boolean(file) && typeof file === "object"
  && typeof file.name === "string"
  && Number.isSafeInteger(file.size) && file.size >= 0;

// Text-only normalization: control characters and NUL never reach a DOM node.
const cleanName = (name) => (typeof name === "string" ? name : String(name ?? ""))
  .replace(/[\u0000-\u001f\u007f]/g, "");

function normalizeContext(raw) {
  if(!raw || typeof raw !== "object") throw failure("invalid-context");
  const { draftId, cwd, scopeKey } = raw;
  for(const value of [draftId, cwd, scopeKey]) {
    if(typeof value !== "string" || !value) throw failure("invalid-context");
  }
  const threadId = raw.threadId == null ? null : raw.threadId;
  if(threadId !== null && (typeof threadId !== "string" || !threadId)) throw failure("invalid-context");
  return Object.freeze({ draftId, cwd, threadId, scopeKey });
}

// draft/cwd/scope must match exactly. A still-unbound draft attachment (threadId null) may bind
// to a newly created current thread, but a concrete wrong thread never matches.
export function sameAttachmentContext(bound, current) {
  if(!bound || !current) return false;
  if(bound.cwd !== current.cwd) return false;
  if(bound.draftId !== current.draftId) return false;
  if(bound.scopeKey !== current.scopeKey) return false;
  if((bound.threadId ?? null) === null) return true;
  return bound.threadId === (current.threadId ?? null);
}

function normalizeLimits(overrides = {}) {
  const read = (key) => {
    const value = overrides?.[key];
    return Number.isSafeInteger(value) && value > 0 ? value : CHAT_ATTACHMENT_LIMITS[key];
  };
  return Object.freeze({
    maxFileBytes: read("maxFileBytes"),
    maxFiles: read("maxFiles"),
    maxBatchBytes: read("maxBatchBytes")
  });
}

let idCounter = 0;
const defaultCreateId = () => (globalThis.crypto?.randomUUID
  ? globalThis.crypto.randomUUID()
  : `att-${Date.now().toString(36)}-${(idCounter += 1).toString(36)}`);

export class ChatAttachmentController {
  #transport;
  #contextProvider;
  #onChange;
  #createId;
  #limits;
  #items = new Map();
  #fileIndex = new WeakMap();
  #queue = [];
  #running = false;
  #idleWaiters = [];
  #send = null;
  #sendIds = new Map();
  #disposed = false;

  constructor({ transport, contextProvider, onChange, limits, createId } = {}) {
    if(!transport || typeof transport.upload !== "function" || typeof transport.remove !== "function") {
      throw failure("invalid-transport");
    }
    if(typeof contextProvider !== "function") throw failure("invalid-context-provider");
    if(onChange != null && typeof onChange !== "function") throw failure("invalid-on-change");
    if(createId != null && typeof createId !== "function") throw failure("invalid-create-id");
    this.#transport = transport;
    this.#contextProvider = contextProvider;
    this.#onChange = onChange ?? null;
    this.#createId = createId ?? defaultCreateId;
    this.#limits = normalizeLimits(limits);
  }

  // ---------------------------------------------------------------- selection

  addFiles(files, source = "picker") {
    const list = Array.isArray(files) ? files : Array.from(files ?? []);
    const accepted = [];
    const rejected = [];
    const report = () => Object.freeze({
      accepted: Object.freeze(accepted),
      rejected: Object.freeze(rejected.map((entry) => Object.freeze(entry)))
    });

    if(this.#disposed) {
      for(const file of list) rejected.push({ name: cleanName(file?.name), error: "disposed" });
      return report();
    }
    if(this.#send) {
      for(const file of list) rejected.push({ name: cleanName(file?.name), error: "send-locked" });
      return report();
    }
    let context;
    try {
      context = normalizeContext(this.#contextProvider());
    } catch {
      for(const file of list) rejected.push({ name: cleanName(file?.name), error: "context-unavailable" });
      return report();
    }

    let bytes = this.#bytes();
    for(const file of list) {
      if(!isFileLike(file)) { rejected.push({ name: cleanName(file?.name), error: "invalid-file" }); continue; }
      const held = this.#fileIndex.get(file);
      if(held && this.#items.has(held)) { rejected.push({ name: cleanName(file.name), error: "duplicate-file" }); continue; }
      if(this.#items.size >= this.#limits.maxFiles) { rejected.push({ name: cleanName(file.name), error: "file-count-limit" }); continue; }
      if(file.size > this.#limits.maxFileBytes) { rejected.push({ name: cleanName(file.name), error: "file-too-large" }); continue; }
      if(bytes + file.size > this.#limits.maxBatchBytes) { rejected.push({ name: cleanName(file.name), error: "draft-too-large" }); continue; }

      const clientId = this.#nextClientId();
      const record = {
        clientId,
        file,
        source: typeof source === "string" ? source : "unknown",
        context,
        status: CHAT_ATTACHMENT_STATUS.PREPARING,
        progress: 0,
        id: null,
        name: cleanName(file.name),
        size: file.size,
        mime: typeof file.type === "string" ? file.type : "",
        error: null,
        abort: null,
        removed: false
      };
      this.#items.set(clientId, record);
      this.#fileIndex.set(file, clientId);
      this.#queue.push(clientId);
      bytes += file.size;
      accepted.push(clientId);
    }

    if(accepted.length) {
      this.#notify();
      this.#run();
    }
    return report();
  }

  // ---------------------------------------------------------------- upload pump

  #nextClientId() {
    let clientId = cleanName(String(this.#createId()));
    let guard = 0;
    while(this.#items.has(clientId) && guard < 16) {
      clientId = cleanName(String(this.#createId()));
      guard += 1;
    }
    if(this.#items.has(clientId)) clientId = `${clientId}-${this.#items.size}`;
    return clientId;
  }

  #bytes() {
    let bytes = 0;
    for(const record of this.#items.values()) bytes += record.size;
    return bytes;
  }

  #hasPending() {
    for(const record of this.#items.values()) {
      if(record.status === CHAT_ATTACHMENT_STATUS.PREPARING || record.status === CHAT_ATTACHMENT_STATUS.UPLOADING) return true;
    }
    return false;
  }

  #idle() {
    if(!this.#hasPending()) return Promise.resolve();
    return new Promise((resolve) => { this.#idleWaiters.push(resolve); });
  }

  #flushIdle() {
    if(!this.#idleWaiters.length) return;
    if(!this.#disposed && this.#hasPending()) return;
    const waiters = this.#idleWaiters;
    this.#idleWaiters = [];
    for(const resolve of waiters) resolve();
  }

  #run() {
    if(this.#running || this.#disposed) return;
    this.#running = true;
    void (async () => {
      try {
        // One draft on the server: upload strictly one file at a time.
        while(this.#queue.length) {
          const clientId = this.#queue.shift();
          const record = this.#items.get(clientId);
          if(!record || record.removed || this.#disposed) continue;
          await this.#upload(record);
        }
      } finally {
        this.#running = false;
        this.#flushIdle();
      }
    })();
  }

  #progress(record, value, total) {
    if(this.#disposed || record.removed) return;
    if(record.status !== CHAT_ATTACHMENT_STATUS.UPLOADING) return;
    let loaded;
    let totalBytes;
    if(value && typeof value === "object") {
      loaded = Number(value.loaded);
      totalBytes = Number(value.total);
    } else {
      loaded = Number(value);
      totalBytes = Number(total);
    }
    if(!Number.isFinite(loaded) || loaded < 0) return;
    if(!Number.isFinite(totalBytes) || totalBytes <= 0) totalBytes = record.size;
    if(totalBytes <= 0) return;
    const fraction = Math.min(1, loaded / totalBytes);
    if(!Number.isFinite(fraction) || fraction <= record.progress) return;
    record.progress = fraction;
    this.#notify();
  }

  async #upload(record) {
    if(this.#disposed || record.removed) return;
    record.status = CHAT_ATTACHMENT_STATUS.UPLOADING;
    record.progress = 0;
    record.error = null;
    const abort = new AbortController();
    record.abort = abort;
    this.#notify();

    let result;
    try {
      result = await this.#transport.upload({
        file: record.file,
        context: record.context,
        onProgress: (value, total) => this.#progress(record, value, total),
        signal: abort.signal
      });
    } catch(error) {
      record.abort = null;
      if(record.removed || this.#disposed) return;
      record.status = CHAT_ATTACHMENT_STATUS.FAILED;
      record.progress = 0;
      record.error = abort.signal.aborted
        ? "upload-aborted"
        : (typeof error?.code === "string" && error.code ? error.code : "upload-failed");
      this.#notify();
      return;
    }
    record.abort = null;

    // A remove()/dispose() finished while the server accepted the bytes: drop the orphan.
    if(record.removed || this.#disposed) {
      await this.#purge(result, record.context);
      return;
    }

    const id = result && typeof result === "object" && typeof result.id === "string" ? result.id : "";
    if(!id || result.status !== "ready") {
      record.status = CHAT_ATTACHMENT_STATUS.FAILED;
      record.progress = 0;
      record.error = "invalid-response";
      await this.#purge(result, record.context);
      this.#notify();
      return;
    }
    if(Number.isSafeInteger(result.size) && result.size !== record.size) {
      record.status = CHAT_ATTACHMENT_STATUS.FAILED;
      record.progress = 0;
      record.error = "size-mismatch";
      await this.#purge(result, record.context);
      this.#notify();
      return;
    }
    record.id = id;
    if(typeof result.name === "string" && result.name) record.name = cleanName(result.name);
    if(typeof result.mime === "string") record.mime = result.mime;
    record.status = CHAT_ATTACHMENT_STATUS.READY;
    record.progress = 1;
    record.error = null;
    this.#notify();
  }

  async #purge(result, context) {
    const id = result && typeof result === "object" && typeof result.id === "string" ? result.id : "";
    if(!id) return;
    try {
      await this.#transport.remove({ id, context });
    } catch {
      // Best-effort orphan cleanup; the server reconciles stale drafts on its own.
    }
  }

  #drop(record) {
    this.#items.delete(record.clientId);
    if(this.#fileIndex.get(record.file) === record.clientId) this.#fileIndex.delete(record.file);
    const index = this.#queue.indexOf(record.clientId);
    if(index !== -1) this.#queue.splice(index, 1);
    record.removed = true;
  }

  #notify() {
    if(this.#disposed || !this.#onChange) return;
    try {
      this.#onChange(this.snapshot());
    } catch {
      // A renderer failure must not corrupt controller state.
    }
  }

  // ---------------------------------------------------------------- UI contract

  snapshot() {
    return Object.freeze(Array.from(this.#items.values(), (record) => Object.freeze({
      clientId: record.clientId,
      id: record.id,
      name: record.name,
      size: record.size,
      mime: record.mime,
      status: record.status,
      progress: record.progress,
      error: record.error
    })));
  }

  totals() {
    let bytes = 0;
    const counts = { preparing: 0, uploading: 0, ready: 0, failed: 0, unknown: 0, sending: 0 };
    for(const record of this.#items.values()) {
      bytes += record.size;
      if(counts[record.status] !== undefined) counts[record.status] += 1;
    }
    return Object.freeze({
      files: this.#items.size,
      bytes,
      ready: counts.ready,
      failed: counts.failed,
      pending: counts.preparing + counts.uploading,
      sending: counts.sending,
      unknown: counts.unknown,
      locked: Boolean(this.#send),
      maxFiles: this.#limits.maxFiles,
      maxFileBytes: this.#limits.maxFileBytes,
      maxBatchBytes: this.#limits.maxBatchBytes
    });
  }

  get locked() {
    return Boolean(this.#send);
  }

  // ---------------------------------------------------------------- remove / retry

  remove(clientId) {
    const record = this.#items.get(clientId);
    if(!record) return Promise.resolve({ ok: false, error: "missing" });
    if(this.#disposed) return Promise.resolve({ ok: false, error: "disposed" });
    if(record.status === CHAT_ATTACHMENT_STATUS.UNKNOWN) return Promise.resolve({ ok: false, error: "send-unknown" });
    if(this.#send) return Promise.resolve({ ok: false, error: "send-locked" });

    if(record.status === CHAT_ATTACHMENT_STATUS.PREPARING || record.status === CHAT_ATTACHMENT_STATUS.UPLOADING) {
      this.#drop(record);
      record.abort?.abort();
      record.abort = null;
      this.#notify();
      this.#flushIdle();
      return Promise.resolve({ ok: true, status: "aborted" });
    }

    if(!record.id) {
      this.#drop(record);
      this.#notify();
      return Promise.resolve({ ok: true, status: "removed" });
    }

    const id = record.id;
    const context = record.context;
    return (async () => {
      try {
        await this.#transport.remove({ id, context });
      } catch(error) {
        record.error = typeof error?.code === "string" && error.code ? error.code : "remove-failed";
        this.#notify();
        return { ok: false, error: record.error };
      }
      if(this.#disposed || this.#items.get(clientId) !== record) {
        return { ok: false, error: this.#disposed ? "disposed" : "missing" };
      }
      this.#drop(record);
      this.#notify();
      return { ok: true, status: "removed" };
    })();
  }

  retry(clientId) {
    if(this.#disposed) return { ok: false, error: "disposed" };
    if(this.#send) return { ok: false, error: "send-locked" };
    const record = this.#items.get(clientId);
    if(!record) return { ok: false, error: "missing" };
    if(record.status !== CHAT_ATTACHMENT_STATUS.FAILED) return { ok: false, error: "not-failed" };
    let current;
    try {
      current = normalizeContext(this.#contextProvider());
    } catch {
      return { ok: false, error: "context-unavailable" };
    }
    if(!sameAttachmentContext(record.context, current)) return { ok: false, error: "context-changed" };

    // Same captured File object and same captured context: no duplicate event processing.
    record.status = CHAT_ATTACHMENT_STATUS.PREPARING;
    record.progress = 0;
    record.error = null;
    record.id = null;
    record.hadServerCopy = false;
    this.#queue.push(clientId);
    this.#notify();
    this.#run();
    return { ok: true };
  }

  // ---------------------------------------------------------------- send lock

  #signature(context, items) {
    return JSON.stringify([
      context.draftId,
      context.cwd,
      context.scopeKey,
      context.threadId ?? null,
      items.map((record) => record.clientId)
    ]);
  }

  #clientSendId(signature) {
    const cached = this.#sendIds.get(signature);
    if(cached) return cached;
    if(this.#sendIds.size >= 8) this.#sendIds.delete(this.#sendIds.keys().next().value);
    const clientSendId = cleanName(String(this.#createId())) || `send-${Date.now().toString(36)}`;
    this.#sendIds.set(signature, clientSendId);
    return clientSendId;
  }

  prepareSend(context) {
    if(this.#disposed) return Promise.reject(failure("disposed"));
    let requested;
    try {
      requested = normalizeContext(context);
    } catch(error) {
      return Promise.reject(error);
    }
    const active = this.#send;
    if(active) {
      const identical = active.context.draftId === requested.draftId
        && active.context.cwd === requested.cwd
        && active.context.scopeKey === requested.scopeKey
        && (active.context.threadId ?? null) === (requested.threadId ?? null);
      if(active.unknown) return Promise.reject(failure("send-unknown"));
      if(identical && active.promise) return active.promise;
      return Promise.reject(failure("send-in-progress"));
    }

    // Lock before the first await so no add/remove/retry can mutate the captured set.
    const send = { context: requested, items: [], plan: null, promise: null, clientSendId: "", signature: "", unknown: false };
    this.#send = send;
    send.promise = this.#prepare(send);
    return send.promise;
  }

  async #prepare(send) {
    const captured = Array.from(this.#items.values());
    try {
      for(const record of captured) {
        if(record.status === CHAT_ATTACHMENT_STATUS.UNKNOWN) {
          throw failure("unknown-attachment");
        }
      }
      // Wait for the real in-flight/queued upload promises instead of guessing readiness.
      await this.#idle();
      if(this.#disposed) throw failure("disposed");

      for(const record of captured) {
        if(this.#items.get(record.clientId) !== record) throw failure("attachment-changed");
        if(record.status === CHAT_ATTACHMENT_STATUS.UNKNOWN) throw failure("unknown-attachment");
        if(record.status !== CHAT_ATTACHMENT_STATUS.READY || !record.id) {
          throw failure(typeof record.error === "string" && record.error ? record.error : "attachment-not-ready");
        }
        if(!sameAttachmentContext(record.context, send.context)) throw failure("context-mismatch");
      }
      if(!captured.length) throw failure("no-attachments");

      let current;
      try {
        current = normalizeContext(this.#contextProvider());
      } catch {
        throw failure("context-unavailable");
      }
      // The provider is authoritative: a project/draft/thread switch invalidates the bound server side.
      if(!sameAttachmentContext(send.context, current)) throw failure("context-changed");

      const signature = this.#signature(send.context, captured);
      const clientSendId = this.#clientSendId(signature);
      const plan = Object.freeze({
        attachmentIds: Object.freeze(captured.map((record) => record.id)),
        draftId: send.context.draftId,
        clientSendId,
        commit: () => this.#finishSend(send, "commit"),
        fail: (options) => this.#finishSend(send, "fail", options)
      });

      send.items = captured;
      send.signature = signature;
      send.clientSendId = clientSendId;
      send.plan = plan;
      for(const record of captured) {
        record.status = CHAT_ATTACHMENT_STATUS.SENDING;
        record.error = null;
      }
      this.#notify();
      return plan;
    } catch(error) {
      const code = typeof error?.code === "string" && error.code ? error.code : "prepare-failed";
      if(this.#send === send) this.#send = null;
      // Preserve user items; unlock anything this attempt had marked as sending.
      for(const record of send.items.length ? send.items : captured) {
        if(this.#items.get(record.clientId) !== record) continue;
        if(record.status === CHAT_ATTACHMENT_STATUS.SENDING) {
          record.status = CHAT_ATTACHMENT_STATUS.READY;
          record.progress = 1;
        }
      }
      this.#notify();
      throw failure(code);
    }
  }

  #finishSend(send, mode, options) {
    if(this.#send !== send) return { ok: false, error: "stale-send" };
    const captured = send.items;
    if(mode === "commit") {
      for(const record of captured) {
        if(this.#items.get(record.clientId) === record) this.#drop(record);
      }
      this.#sendIds.delete(send.signature);
      this.#send = null;
      this.#notify();
      return { ok: true, status: "sent" };
    }
    if(options?.unknown) {
      for(const record of captured) {
        if(this.#items.get(record.clientId) !== record) continue;
        record.status = CHAT_ATTACHMENT_STATUS.UNKNOWN;
        record.progress = 1;
        record.error = typeof options.error === "string" && options.error ? options.error : "send-unknown";
      }
      send.unknown = true;
      this.#notify();
      return { ok: true, status: "unknown" };
    }
    // Definite rejection: keep the items, release the lock, keep the send id for a deduped retry.
    for(const record of captured) {
      if(this.#items.get(record.clientId) !== record) continue;
      if(record.status === CHAT_ATTACHMENT_STATUS.SENDING) {
        record.status = CHAT_ATTACHMENT_STATUS.READY;
        record.progress = 1;
      }
    }
    this.#send = null;
    this.#notify();
    return { ok: true, status: "retry" };
  }

  // Only an explicit authoritative server outcome unlocks an unknown send.
  reconcileSend(clientSendId, { status } = {}) {
    const send = this.#send;
    if(!send || !send.unknown || !send.clientSendId || send.clientSendId !== clientSendId) {
      return { ok: false, error: "unknown-send" };
    }
    if(status === "unknown") return { ok: true, status: "unknown" };
    if(status === "accepted") {
      for(const record of send.items) {
        if(this.#items.get(record.clientId) === record) this.#drop(record);
      }
      this.#sendIds.delete(send.signature);
      this.#send = null;
      this.#notify();
      return { ok: true, status: "accepted" };
    }
    if(status === "rejected") {
      for(const record of send.items) {
        if(this.#items.get(record.clientId) !== record) continue;
        if(record.status === CHAT_ATTACHMENT_STATUS.UNKNOWN) {
          record.status = CHAT_ATTACHMENT_STATUS.READY;
          record.progress = 1;
          record.error = null;
        }
      }
      this.#send = null;
      this.#notify();
      return { ok: true, status: "rejected" };
    }
    return { ok: false, error: "invalid-status" };
  }

  // ---------------------------------------------------------------- teardown

  dispose() {
    if(this.#disposed) return;
    this.#disposed = true;
    this.#queue.length = 0;
    for(const record of this.#items.values()) {
      const abort = record.abort;
      record.removed = true;
      record.abort = null;
      abort?.abort();
    }
    this.#items.clear();
    this.#send = null;
    for(const resolve of this.#idleWaiters) resolve();
    this.#idleWaiters = [];
  }
}
