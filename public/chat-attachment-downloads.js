// Safe download buttons for already-sent chat attachments.
//
// The server stores verified attachment metadata inside reserved reference
// blocks; this module only ever exposes the allowlisted `{id,name,size,mime}`
// subset and never the physical server path. Downloads are fetched from one
// fixed relative same-origin URL, the access token travels in an Authorization
// header (never in the URL or the DOM), redirects are refused, and a temporary
// object URL is revoked in `finally` even when the click is abandoned.
import { attachmentReferences } from "./attachment-reference.js";

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_NAME_CHARS = 240;
const MAX_MIME_CHARS = 200;
const MAX_ATTACHMENTS = 20;

const ATTACHMENT_ID = /^[a-f0-9]{32}$/;
const MIME = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
const BIDI_CHARS = /[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
const PATH_SEPARATORS = /[\\/]/g;

function cleanLabel(value, limit) {
  if (typeof value !== "string") return null;
  const cleaned = value
    .replace(CONTROL_CHARS, "")
    .replace(BIDI_CHARS, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;
  const points = Array.from(cleaned);
  return points.length > limit ? points.slice(0, limit).join("").trim() : cleaned;
}

function cleanName(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  const cleaned = value
    .replace(CONTROL_CHARS, "")
    .replace(BIDI_CHARS, "")
    .replace(PATH_SEPARATORS, "_")
    .replace(/[<>&]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;
  const points = Array.from(cleaned);
  const bounded = points.length > MAX_NAME_CHARS
    ? points.slice(0, MAX_NAME_CHARS).join("").trim()
    : cleaned;
  return bounded || null;
}

function cleanMime(value) {
  if (typeof value !== "string" || value.length === 0) return "application/octet-stream";
  const trimmed = value.trim();
  if (trimmed.length > MAX_MIME_CHARS) return "application/octet-stream";
  if (/[\u0000-\u0020\u007f]/.test(trimmed)) return "application/octet-stream";
  if (!MIME.test(trimmed)) return "application/octet-stream";
  return trimmed.toLowerCase();
}

// Allowlist one untrusted metadata object. Anything outside the bounds fails
// closed; the physical path and every other field are discarded.
export function safeAttachmentMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { id, size } = value;
  if (typeof id !== "string" || !ATTACHMENT_ID.test(id.toLowerCase())) return null;
  const name = cleanName(value.name);
  if (!name) return null;
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES) return null;
  return Object.freeze({ id: id.toLowerCase(), name, size, mime: cleanMime(value.mime) });
}

// Extract only safe metadata from reserved reference blocks in message text.
export function attachmentsFromReference(text) {
  const collected = [];
  const seen = new Set();
  if (typeof text !== "string" || text.length === 0) return collected;
  for (const entry of attachmentReferences(text)) {
    if (collected.length >= MAX_ATTACHMENTS) break;
    const safe = safeAttachmentMetadata(entry);
    if (!safe || seen.has(safe.id)) continue;
    seen.add(safe.id);
    collected.push(safe);
  }
  return collected;
}

function downloadFilename(name) {
  const cleaned = String(name ?? "")
    .replace(CONTROL_CHARS, "")
    .replace(BIDI_CHARS, "")
    .replace(PATH_SEPARATORS, "_")
    .replace(/^\.+/, "")
    .trim();
  return cleaned || "attachment";
}

function emptyChildren(node) {
  if (typeof node?.replaceChildren === "function") {
    node.replaceChildren();
    return;
  }
  if (!Array.isArray(node?.children)) return;
  for (const child of [...node.children]) {
    if (typeof node.removeChild === "function") node.removeChild(child);
  }
}

export function renderAttachmentDownloads({
  document: doc = globalThis.document,
  container,
  attachments,
  getContext,
  fetchImpl = globalThis.fetch,
  URLImpl = globalThis.URL,
  onFeedback,
  t
} = {}) {
  if (!doc || typeof doc.createElement !== "function") return { element: null, buttons: [], dispose() {} };
  if (!container) return { element: null, buttons: [], dispose() {} };

  const label = (key, fallback) => {
    let value;
    try {
      value = t?.(`attachment.${key}`);
    } catch {
      value = undefined;
    }
    return typeof value === "string" && value && value !== `attachment.${key}` ? value : fallback;
  };
  const downloadLabel = () => label("download", "Download");
  const downloadingLabel = () => label("downloading", "Downloading…");
  const errorLabel = () => label("error", "Download failed");

  const safe = [];
  const seen = new Set();
  for (const entry of Array.isArray(attachments) ? attachments : []) {
    if (safe.length >= MAX_ATTACHMENTS) break;
    const metadata = safeAttachmentMetadata(entry);
    if (!metadata || seen.has(metadata.id)) continue;
    seen.add(metadata.id);
    safe.push({ ...metadata, busy: false, button: null, handler: null });
  }

  let disposed = false;
  const controllers = new Set();
  const list = doc.createElement("div");
  list.className = "chat-attachment-downloads";

  const feedback = (message) => {
    try {
      onFeedback?.(message);
    } catch {
      /* feedback is best effort */
    }
  };

  const setBusy = (entry, busy) => {
    entry.busy = busy;
    if (!entry.button) return;
    entry.button.disabled = busy;
    entry.button.textContent = busy
      ? `${entry.name} · ${downloadingLabel()}`
      : `${entry.name} · ${downloadLabel()}`;
  };

  async function readContext() {
    if (disposed) return null;
    let value;
    try {
      value = await getContext?.();
    } catch {
      return null;
    }
    if (!value || typeof value !== "object") return null;
    const threadId = typeof value.threadId === "string" && value.threadId ? value.threadId : null;
    if (!threadId) return null;
    const token = typeof value.token === "string" && value.token ? value.token : null;
    return { threadId, token };
  }

  async function fetchBlob(id, context, signal) {
    const headers = { accept: "application/octet-stream" };
    if (context.token) headers.authorization = `Bearer ${context.token}`;
    // Fixed relative same-origin URL; the token is never part of the URL.
    const target = `/api/chat-attachments/${id}/download?threadId=${encodeURIComponent(context.threadId)}`;
    const response = await fetchImpl(target, {
      method: "GET",
      headers,
      credentials: "same-origin",
      redirect: "error",
      cache: "no-store",
      signal
    });
    if (!response || response.ok !== true) throw new Error("download failed");
    return response.blob();
  }

  function deliver(blob, name) {
    const url = URLImpl.createObjectURL(blob);
    try {
      const link = doc.createElement("a");
      link.href = url;
      link.download = downloadFilename(name);
      link.rel = "noopener";
      link.style.display = "none";
      const host = doc.body;
      const attached = Boolean(host && typeof host.appendChild === "function");
      if (attached) host.appendChild(link);
      try {
        link.click();
      } finally {
        if (attached && typeof host.removeChild === "function") host.removeChild(link);
      }
    } finally {
      URLImpl.revokeObjectURL(url);
    }
  }

  async function run(entry) {
    if (disposed || entry.busy) return;
    setBusy(entry, true);
    const controller = new AbortController();
    controllers.add(controller);
    let failed = false;
    try {
      const first = await readContext();
      if (!first) throw new Error("download failed");
      const blob = await fetchBlob(entry.id, first, controller.signal);
      // Authority may have changed while bytes were in flight: recheck the
      // same thread and token before touching the DOM.
      const second = await readContext();
      if (!second || second.threadId !== first.threadId || second.token !== first.token) return;
      if (disposed || controller.signal.aborted) return;
      deliver(blob, entry.name);
    } catch {
      if (!disposed && !controller.signal.aborted) failed = true;
    } finally {
      controllers.delete(controller);
      if (!disposed) {
        setBusy(entry, false);
        if (failed) {
          entry.button.textContent = `${entry.name} · ${errorLabel()}`;
          feedback(errorLabel());
        }
      }
    }
  }

  const buttons = [];
  for (const entry of safe) {
    const button = doc.createElement("button");
    button.type = "button";
    button.className = "chat-attachment-download";
    button.textContent = `${entry.name} · ${downloadLabel()}`;
    button.setAttribute?.("aria-label", `${downloadLabel()}: ${entry.name}`);
    button.disabled = false;
    const handler = () => {
      void run(entry);
    };
    button.addEventListener?.("click", handler);
    entry.button = button;
    entry.handler = handler;
    buttons.push(button);
    if (typeof list.appendChild === "function") list.appendChild(button);
  }

  emptyChildren(container);
  if (typeof container.appendChild === "function") container.appendChild(list);

  return {
    element: list,
    buttons,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const controller of controllers) {
        try {
          controller.abort();
        } catch {
          /* ignore */
        }
      }
      controllers.clear();
      for (const entry of safe) {
        if (entry.button && entry.handler) entry.button.removeEventListener?.("click", entry.handler);
        entry.busy = false;
        entry.handler = null;
      }
      emptyChildren(list);
      if (container.firstChild === list) emptyChildren(container);
    }
  };
}
