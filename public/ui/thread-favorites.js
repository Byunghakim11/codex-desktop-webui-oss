// Local UI metadata for favorite conversations.
// Deliberately NOT a native pin: only thread IDs are stored, under an opaque
// account/scope namespace, so no titles, bodies, paths or tokens are persisted.
const STORAGE_PREFIX = "codex-webui.favorites.v1:";
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;
const MAX_ID_LENGTH = 200;
const MAX_NAMESPACE_LENGTH = 160;
const FALLBACK_SEED = 0x811c9dc5;

function normalizeId(value) {
  if (typeof value !== "string") return null;
  const id = value.trim();
  if (!id || id.length > MAX_ID_LENGTH) return null;
  return id;
}

function normalizeNamespace(value) {
  if (typeof value !== "string") return null;
  const namespace = value.trim();
  if (!namespace || namespace.length > MAX_NAMESPACE_LENGTH) return null;
  return namespace;
}

function fallbackHash(text) {
  const input = String(text ?? "");
  let first = FALLBACK_SEED ^ 0x9e3779b9;
  let second = 0x85ebca6b;
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = Math.imul(second ^ (code + index), 0x85ebca6b) >>> 0;
  }
  return `${first.toString(16).padStart(8, "0")}${second.toString(16).padStart(8, "0")}`;
}

// Opaque namespace: a hash over (scope, token) so the raw token, user paths or
// account identifiers never appear in storage keys.
export async function deriveFavoriteNamespace({ token, scope, cryptoImpl = globalThis.crypto } = {}) {
  const material = `${String(scope ?? "")}\u0000${String(token ?? "")}`;
  const subtle = cryptoImpl?.subtle;
  if (subtle && typeof subtle.digest === "function" && typeof TextEncoder === "function") {
    try {
      const digest = new Uint8Array(await subtle.digest("SHA-256", new TextEncoder().encode(material)));
      return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 32);
    } catch {
      // Fall through to the deterministic non-crypto namespace.
    }
  }
  return `${fallbackHash(material)}${fallbackHash(`${material}#scope`)}`;
}

// Share/open links must never carry the current query, hash or credentials.
// Only a single plain `thread` parameter survives.
export function safeThreadLink({ href, threadId, param = "thread" } = {}) {
  const id = normalizeId(threadId);
  if (!id || typeof href !== "string" || !href) return null;
  let url;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  url.searchParams.set(param, id);
  return url.toString();
}

export function createThreadFavorites({ storage, namespace, limit = DEFAULT_LIMIT } = {}) {
  const scope = normalizeNamespace(namespace);
  if (!scope) throw new TypeError("createThreadFavorites needs a non-empty opaque namespace");
  const boundedLimit = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), MAX_LIMIT) : DEFAULT_LIMIT;
  const storageKey = `${STORAGE_PREFIX}${scope}`;
  const listeners = new Set();
  const usable = Boolean(storage && typeof storage.getItem === "function" && typeof storage.setItem === "function");
  let ids = [];
  let lastError = usable ? null : { type: "unavailable" };

  function emit(event) {
    for (const listener of [...listeners]) {
      try {
        listener({ ...event, ids: [...ids] });
      } catch {
        // Subscribers are isolated from each other and from store state.
      }
    }
  }

  function read() {
    if (!usable) return [];
    let raw;
    try {
      raw = storage.getItem(storageKey);
    } catch {
      lastError = { type: "unavailable" };
      return [];
    }
    if (raw === null || raw === undefined || raw === "") return [];
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Corrupt payloads are reported and left untouched until an explicit write.
      lastError = { type: "corrupt" };
      return [];
    }
    const source = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.ids) ? parsed.ids : [];
    const next = [];
    for (const value of source) {
      const id = normalizeId(value);
      if (id && !next.includes(id)) next.push(id);
      if (next.length >= boundedLimit) break;
    }
    return next;
  }

  function persist(next) {
    if (!usable) {
      lastError = { type: "unavailable" };
      return false;
    }
    try {
      storage.setItem(storageKey, JSON.stringify({ version: 1, ids: next }));
      lastError = null;
      return true;
    } catch {
      // Never silently drop stored favorites: the in-memory list is reverted.
      lastError = { type: "write" };
      return false;
    }
  }

  function storageReason() {
    if (!lastError) return null;
    return lastError.type === "unavailable" || lastError.type === "write" ? "storage" : lastError.type;
  }

  ids = read();

  function has(value) {
    const id = normalizeId(value);
    return Boolean(id) && ids.includes(id);
  }

  function commit(next, meta = {}) {
    if (!persist(next)) {
      const reason = storageReason() || "storage";
      emit({ type: "error", reason, operation: meta.operation || "write" });
      return { ...meta.result, changed: false, persisted: false, reason };
    }
    ids = next;
    emit({ type: "change", operation: meta.operation || "write", favorite: meta.result?.favorite ?? false });
    return { ...meta.result, changed: true, persisted: true, reason: null };
  }

  function toggle(value) {
    const id = normalizeId(value);
    if (!id) return { id: null, favorite: false, changed: false, persisted: false, reason: "invalid" };
    if (ids.includes(id)) {
      return remove(id);
    }
    if (ids.length >= boundedLimit) {
      emit({ type: "error", reason: "limit", operation: "add" });
      return { id, favorite: false, changed: false, persisted: false, reason: "limit" };
    }
    return commit([...ids, id], { operation: "add", result: { id, favorite: true } });
  }

  function remove(value) {
    const id = normalizeId(value);
    if (!id) return { id: null, removed: false, favorite: false, changed: false, persisted: false, reason: "invalid" };
    if (!ids.includes(id)) return { id, removed: false, favorite: true, changed: false, persisted: false, reason: null };
    const result = commit(ids.filter((candidate) => candidate !== id), {
      operation: "remove",
      result: { id, removed: true, favorite: false }
    });
    return result.changed ? { ...result, removed: true } : { ...result, removed: false };
  }

  function clear() {
    if (!ids.length) return { cleared: 0, changed: false, persisted: false, reason: null };
    const cleared = ids.length;
    const result = commit([], { operation: "clear", result: { cleared } });
    return result.changed ? { ...result, cleared } : { ...result, cleared: 0 };
  }

  function subscribe(listener) {
    if (typeof listener !== "function") return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  return {
    has,
    listIds: () => [...ids],
    toggle,
    remove,
    clear,
    subscribe,
    size: () => ids.length,
    limit: boundedLimit,
    storageKey,
    status: () => ({ available: usable, error: lastError ? { ...lastError } : null })
  };
}
