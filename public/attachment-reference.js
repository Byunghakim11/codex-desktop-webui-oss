// Read-only helpers for the reserved native attachment reference block.
//
// The server (`server/chat-attachment-input.js`) serializes verified attachment
// metadata into one `text` input item shaped like:
//
//   <codex-webui-attachments-v1>
//   {"version":1,"policy":"...","attachments":[{"id":...,"name":...,"size":...,
//     "mime":...,"path":"<absolute server path>"}]}
//   </codex-webui-attachments-v1>
//
// Anything rendered back to a user must never echo the physical `path`, and bad
// or truncated payloads must be dropped fail-closed instead of shown.

export const ATTACHMENT_BLOCK_OPEN = "<codex-webui-attachments-v1>";
export const ATTACHMENT_BLOCK_CLOSE = "</codex-webui-attachments-v1>";
export const MAX_ATTACHMENT_JSON_CHARS = 50_000;

const MAX_ATTACHMENTS = 20;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_FILE_NAME_CHARS = 200;
const MAX_FILE_MIME_CHARS = 120;

const ATTACHMENT_ID = /^[0-9a-f]{32}$/i;
const MIME = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;
const BIDI_CHARS = /[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
const PATH_SEPARATORS = /[\\/]/g;
const HTML_DELIMITERS = /[<>&]/g;

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sanitizeName(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  const cleaned = value
    .replace(CONTROL_CHARS, "")
    .replace(BIDI_CHARS, "")
    .replace(PATH_SEPARATORS, "_")
    .replace(HTML_DELIMITERS, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;
  const codePoints = Array.from(cleaned);
  const bounded = codePoints.length > MAX_FILE_NAME_CHARS
    ? codePoints.slice(0, MAX_FILE_NAME_CHARS).join("").trim()
    : cleaned;
  return bounded || null;
}

function normalizeId(value) {
  if (typeof value !== "string" || !ATTACHMENT_ID.test(value)) return null;
  return value.toLowerCase();
}

function normalizeSize(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_FILE_BYTES) return null;
  return value;
}

function normalizeMime(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_FILE_MIME_CHARS) return null;
  if (/[\u0000-\u0020\u007f]/.test(value)) return null;
  if (!MIME.test(value)) return null;
  return value.toLowerCase();
}

// Returns an array of allowlisted `{id,name,size,mime}` entries, or null when
// the payload is not exactly the shape the native expander emits. The physical
// path and every other field are intentionally discarded.
function parseBlockPayload(raw) {
  if (typeof raw !== "string" || raw.length > MAX_ATTACHMENT_JSON_CHARS) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  if (parsed.version !== 1) return null;
  if (!Array.isArray(parsed.attachments)) return null;
  if (parsed.attachments.length === 0 || parsed.attachments.length > MAX_ATTACHMENTS) return null;
  const seen = new Set();
  const references = [];
  for (const entry of parsed.attachments) {
    if (!isPlainObject(entry)) return null;
    const id = normalizeId(entry.id);
    const name = sanitizeName(entry.name);
    const size = normalizeSize(entry.size);
    const mime = normalizeMime(entry.mime);
    if (!id || !name || size === null || !mime) return null;
    if (seen.has(id)) return null;
    seen.add(id);
    references.push({ id, name, size, mime });
  }
  return references;
}

function formatLabel(references) {
  return `[Attached files: ${references.map(reference => reference.name).join(", ")}]`;
}

// Remove every reserved block and replace a valid block with safe plaintext
// file names. Malformed or truncated blocks are removed without exposing any of
// their JSON. Ordinary text outside blocks is preserved byte-for-byte.
export function stripAttachmentReferences(text) {
  if (typeof text !== "string" || text.length === 0) return "";
  let output = "";
  let index = 0;
  while (index < text.length) {
    const openAt = text.indexOf(ATTACHMENT_BLOCK_OPEN, index);
    if (openAt === -1) {
      output += text.slice(index);
      break;
    }
    output += text.slice(index, openAt);
    const afterOpen = openAt + ATTACHMENT_BLOCK_OPEN.length;
    const closeAt = text.indexOf(ATTACHMENT_BLOCK_CLOSE, afterOpen);
    if (closeAt === -1) {
      // Truncated block: fail closed and drop everything to the end.
      break;
    }
    const references = parseBlockPayload(text.slice(afterOpen, closeAt));
    if (references) output += formatLabel(references);
    index = closeAt + ATTACHMENT_BLOCK_CLOSE.length;
  }
  return output;
}

// Return only allowlisted metadata from valid reserved blocks. Invalid,
// duplicated, malformed or truncated blocks contribute nothing.
export function attachmentReferences(text) {
  const references = [];
  if (typeof text !== "string" || text.length === 0) return references;
  let index = 0;
  while (index < text.length) {
    const openAt = text.indexOf(ATTACHMENT_BLOCK_OPEN, index);
    if (openAt === -1) break;
    const afterOpen = openAt + ATTACHMENT_BLOCK_OPEN.length;
    const closeAt = text.indexOf(ATTACHMENT_BLOCK_CLOSE, afterOpen);
    if (closeAt === -1) break;
    const parsed = parseBlockPayload(text.slice(afterOpen, closeAt));
    if (parsed) references.push(...parsed);
    index = closeAt + ATTACHMENT_BLOCK_CLOSE.length;
  }
  return references;
}
