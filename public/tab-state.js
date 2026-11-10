const ITEM_BYTES = 64 * 1024;
const TOTAL_BYTES = 512 * 1024;
const DRAFT_TTL = 30 * 60 * 1000;
const UNDO_TTL = 60 * 1000;
const LIMIT = 10;
const encoder = new TextEncoder();

function selection(value) {
  if (!value || typeof value.text !== "string") return null;
  const clamp = index => Math.max(0, Math.min(value.text.length, Number.isInteger(index) ? index : value.text.length));
  const start = clamp(value.selectionStart), end = clamp(value.selectionEnd);
  return {
    text: value.text,
    selectionStart: Math.min(start, end), selectionEnd: Math.max(start, end),
    selectionDirection: ["forward", "backward"].includes(value.selectionDirection) ? value.selectionDirection : "none",
  };
}
const validKey = key => typeof key === "string" && key.length > 0 && key.length <= 512;

/** Text and selection only. Neither this module nor its metadata uses persistent storage. */
export function createTabState({ now = Date.now } = {}) {
  const entries = new Map(), expired = new Map(), undoSlots = new Map();
  let active = null;
  function prune() {
    const at = now();
    for (const [key, entry] of entries) {
      if (key === active || entry.inactiveSince === null || at < entry.inactiveSince + DRAFT_TTL) continue;
      entries.delete(key);
      expired.set(key, entry.inactiveSince + DRAFT_TTL);
      // Expiry notices contain no text and are bounded separately from preserved drafts.
      if (expired.size > LIMIT) expired.delete(expired.keys().next().value);
    }
    for (const [key, slot] of undoSlots) if (at >= slot.expiresAt) undoSlots.delete(key);
  }
  function remove(key) {
    entries.delete(key); expired.delete(key); undoSlots.delete(key);
  }
  const drafts = {
    setActive(key) {
      if (key !== null && !validKey(key)) return false;
      prune();
      if (key === active) return true;
      const previous = entries.get(active);
      if (previous) previous.inactiveSince = now();
      active = key;
      const next = entries.get(key);
      if (next) next.inactiveSince = null;
      return true;
    },
    put(key, value) {
      prune();
      const content = selection(value);
      if (!validKey(key) || !content) return { ok: false, status: "invalid" };
      const bytes = encoder.encode(content.text).length;
      if (bytes > ITEM_BYTES) return { ok: false, status: "item-limit" };
      if (!content.text.length) { remove(key); return { ok: true, status: "removed" }; }
      if (!entries.has(key) && entries.size >= LIMIT) return { ok: false, status: "count-limit" };
      let total = bytes;
      for (const [other, entry] of entries) if (other !== key) total += entry.bytes;
      if (total > TOTAL_BYTES) return { ok: false, status: "total-limit" };
      const previous = entries.get(key);
      entries.set(key, { ...content, bytes, inactiveSince: key === active ? null : previous?.inactiveSince ?? now() });
      expired.delete(key);
      return { ok: true, status: "saved" };
    },
    get(key) {
      prune();
      const entry = entries.get(key);
      if (!entry) return { status: expired.has(key) ? "expired" : "missing" };
      return { status: "saved", text: entry.text, selectionStart: entry.selectionStart, selectionEnd: entry.selectionEnd, selectionDirection: entry.selectionDirection };
    },
    remove,
    listMetadata() {
      prune();
      return [
        ...Array.from(entries, ([threadKey, entry]) => ({ threadKey, status: "saved", bytes: entry.bytes, active: threadKey === active, expiresAt: entry.inactiveSince === null ? null : entry.inactiveSince + DRAFT_TTL })),
        ...Array.from(expired, ([threadKey, expiresAt]) => ({ threadKey, status: "expired", bytes: 0, active: false, expiresAt })),
      ];
    },
  };
  const undo = {
    capture(key, value) {
      prune();
      const content = selection(value);
      if (!validKey(key) || !content?.text || !Number.isSafeInteger(value.composerRevision) || value.composerRevision < 0) return { ok: false, status: "invalid" };
      if (encoder.encode(content.text).length > ITEM_BYTES) return { ok: false, status: "item-limit" };
      if (!undoSlots.has(key) && undoSlots.size >= LIMIT) return { ok: false, status: "count-limit" };
      undoSlots.set(key, { ...content, composerRevision: value.composerRevision, expiresAt: now() + UNDO_TTL });
      return { ok: true, status: "captured" };
    },
    take(key, composerRevision) {
      const slot = undoSlots.get(key);
      if (!slot) return { status: "missing" };
      undoSlots.delete(key);
      if (now() >= slot.expiresAt) return { status: "expired" };
      if (composerRevision !== slot.composerRevision) return { status: "revision-mismatch" };
      return { status: "restored", text: slot.text, selectionStart: slot.selectionStart, selectionEnd: slot.selectionEnd, selectionDirection: slot.selectionDirection };
    },
    invalidate(key) { undoSlots.delete(key); },
  };
  return { drafts, undo, clearAllTabContent() { entries.clear(); expired.clear(); undoSlots.clear(); active = null; } };
}

/** Call during beforeinput, before the browser applies an ordinary selected-text deletion. */
export function isFullComposerDeletion({ text, selectionStart, selectionEnd, inputType, isComposing = false } = {}) {
  return !isComposing && typeof text === "string" && text.length > 0 && selectionStart === 0 && selectionEnd === text.length && ["deleteContentBackward", "deleteContentForward"].includes(inputType);
}
