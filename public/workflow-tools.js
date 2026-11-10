import { createTabState, isFullComposerDeletion } from "./tab-state.js";
import { buildConversationSnapshot } from "./conversation-tools.js";

/** Cache immutable loaded content by explicit render revision and cheap scope keys. */
export function createConversationSnapshotCache({ getInput, build = buildConversationSnapshot }) {
  let keys = null, snapshot = null;
  return {
    get() {
      const input = getInput(), next = [input.threadKey, input.revision, input.messages, input.activeTurnId, input.title];
      if (!keys || next.some((value, index) => value !== keys[index])) { snapshot = build(input); keys = next; }
      return snapshot;
    },
    invalidate() { keys = null; snapshot = null; }
  };
}

// Static local rollback switches. No content or configuration is persisted.
export const WORKFLOW_FEATURES = Object.freeze({
  F01: true, F02: true, F03: true, F04: true, F05: true,
  F06: true, F07: true, F08: true, F09: true, F10: true,
  F11: true, F12: true, F13: true, F14: true, F15: true,
});

/** Owns only the ordinary composer. Native question fields never enter this controller. */
export function createComposerDraftController({ input, notify = () => {}, changed = () => {}, blocked = () => false, now = Date.now, features = WORKFLOW_FEATURES }) {
  const store = createTabState({ now }), recovery = createTabState({ now }), sends = new Map();
  let active = null, revision = 0, destructive = null, disposed = false;
  const snapshot = () => ({ text: input.value, selectionStart: input.selectionStart, selectionEnd: input.selectionEnd, selectionDirection: input.selectionDirection });
  function status(value) { notify(value); }
  function save() {
    if (!features.F07 || !active) return true;
    const result = store.drafts.put(active, snapshot());
    status(result.ok ? "saved" : result.status);
    return result.ok;
  }
  function apply(value) {
    input.value = value.text || "";
    input.setSelectionRange(value.selectionStart ?? 0, value.selectionEnd ?? 0, value.selectionDirection || "none");
    revision++; destructive = null; changed();
  }
  function beforeInput(event) {
    destructive = features.F08 && active && isFullComposerDeletion({ ...snapshot(), inputType: event.inputType, isComposing: event.isComposing }) ? snapshot() : null;
  }
  function onInput() {
    revision++;
    const previous = destructive; destructive = null;
    store.undo.invalidate(active);
    save();
    if (features.F08 && previous && !input.value && !sends.size) {
      const result = store.undo.capture(active, { ...previous, composerRevision: revision });
      status(result.ok ? "undo-ready" : result.status);
    }
    changed();
  }
  if (features.F08) input.addEventListener("beforeinput", beforeInput);
  input.addEventListener("input", onInput);
  return {
    switchThread(key) {
      if (disposed) return false;
      if (key === active) return true; // Reconnect/load must never restore over the active editor.
      if (blocked() || sends.size) { status("attachments-or-send"); return false; }
      if (!save()) return false;
      active = key; store.drafts.setActive(key); recovery.drafts.setActive(key); revision++; destructive = null;
      const value = features.F07 ? store.drafts.get(key) : { status: "missing" };
      apply(value.status === "saved" ? value : { text: "" }); status(value.status);
      return true;
    },
    // A newly created server thread inherits its existing editor without a restore cycle.
    adoptThread(key) {
      const previous = active; active = key; store.drafts.remove(previous); store.drafts.setActive(key); recovery.drafts.setActive(key);
      for (const ticket of sends.values()) if (ticket.key === previous) ticket.key = key;
      save();
    },
    beginSend() {
      const ticket = {}; sends.set(ticket, { key: active, revision, text: input.value });
      destructive = null; store.undo.invalidate(active); return ticket;
    },
    finishSend(ticket, confirmed) {
      const sent = sends.get(ticket); if (!sent) return; sends.delete(ticket);
      if (!confirmed) {
        const retained = features.F07 ? recovery.drafts.put(sent.key, { text: sent.text }) : { ok: true };
        if (active === sent.key) save(); status(retained.ok ? "send-retained" : "recovery-limit"); return;
      }
      store.drafts.remove(sent.key);
      recovery.drafts.remove(sent.key);
      if (active !== sent.key) return;
      if (revision === sent.revision && input.value === sent.text) apply({ text: "" });
      save(); // Preserve new typing, never restore the sent snapshot.
      store.undo.invalidate(active);
    },
    clear() {
      if (!features.F08 || disposed || sends.size || !active || !input.value) return false;
      const previous = snapshot();
      // Preflight capacity before a destructive button action. Empty put below
      // invalidates this trial slot, then the accepted snapshot is captured once.
      const trial = store.undo.capture(active, { ...previous, composerRevision: revision + 1 });
      if (!trial.ok) { status(trial.status); return false; }
      apply({ text: "" }); save();
      const result = store.undo.capture(active, { ...previous, composerRevision: revision });
      status(result.ok ? "undo-ready" : result.status); return result.ok;
    },
    undoClear() {
      if (!features.F08 || disposed || sends.size || !active || input.value) return false;
      const previous = store.undo.take(active, revision);
      if (previous.status !== "restored") { status(previous.status); return false; }
      apply(previous); save(); status("restored"); return true;
    },
    forget() {
      if (disposed || sends.size) return false;
      store.drafts.remove(active); recovery.drafts.remove(active); apply({ text: "" }); status("removed"); return true;
    },
    getRecovery() { const value = recovery.drafts.get(active); return value.status === "saved" ? { text: value.text } : null; },
    metadata: () => store.drafts.listMetadata(),
    dispose() { disposed = true; input.removeEventListener("beforeinput", beforeInput); input.removeEventListener("input", onInput); store.clearAllTabContent(); recovery.clearAllTabContent(); sends.clear(); },
  };
}
