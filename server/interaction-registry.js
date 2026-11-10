import { interactionKey, publicInteractionRequest, validateInteractionResponse } from "../public/interaction-contracts.js";

// The broker owns the single response claim. Retain only human-facing requests,
// never authentication/attestation tool payloads, for reconnect snapshots.
export class InteractionRegistry {
  constructor() { this.pending = new Map(); this.files = new Map(); this.previews = new Map(); }

  fileKey(params) {
    return [params?.threadId, params?.turnId, params?.itemId].every(value => typeof value === "string" && value.length > 0 && value.length <= 256) ? JSON.stringify([params.threadId, params.turnId, params.itemId]) : null;
  }

  add(request) {
    const updates = [];
    const key = interactionKey(request.id);
    if (request.method === "item/fileChange/requestApproval" && this.fileKey(request.params)) {
      // Retain metadata only, not an arbitrary native request payload.
      this.files.set(key, { id: request.id, method: request.method, params: { threadId: request.params.threadId, turnId: request.params.turnId, itemId: request.params.itemId, reason: request.params.reason, grantRoot: request.params.grantRoot } });
      if (this.files.size > 128) {
        const expired = this.files.keys().next().value;
        const prior = this.files.get(expired);
        const fallback = publicInteractionRequest({ ...prior, desktopOnly: true, unavailableReason: "file-preview-expired" });
        this.pending.set(expired, fallback); updates.push(structuredClone(fallback));
        this.files.delete(expired);
      }
      request = this.files.get(key);
      const preview = this.previews.get(this.fileKey(request.params));
      if (preview) request = { ...request, displayContext: { fileChanges: preview } };
    }
    const visible = publicInteractionRequest(request);
    if (visible) this.pending.set(interactionKey(request.id), visible);
    return updates;
  }

  observe(message) {
    const p = message.params;
    const isPatch = message.method === "item/fileChange/patchUpdated";
    const item = p?.item;
    if (!isPatch && !(message.method === "item/started" && item?.type === "fileChange")) return [];
    const key = this.fileKey({ ...p, itemId: isPatch ? p?.itemId : item?.id });
    if (!key) return [];
    const changes = isPatch ? p.changes : item.changes;
    let preview = null;
    try {
      if (Array.isArray(changes) && changes.length <= 64 && JSON.stringify(changes).length <= 131072) preview = changes.map(change => ({ path: change.path, kind: change.kind?.type, diff: change.diff, movePath: change.kind?.move_path ?? null }));
    } catch { /* Invalid previews keep the approval Desktop-only. */ }
    if (preview) this.previews.set(key, preview); else this.previews.delete(key);
    if (this.previews.size > 64) this.previews.delete(this.previews.keys().next().value);
    const updated = [];
    for (const [id, request] of this.files) {
      if (this.fileKey(request.params) !== key || !this.pending.has(id)) continue;
      const previous = this.pending.get(id);
      if (previous.displayContext && JSON.stringify(previous.displayContext.fileChanges) !== JSON.stringify(preview)) {
        // A click on an older card must not approve a newer unseen patch.
        request.desktopOnly = true; request.unavailableReason = "file-preview-changed";
      }
      const visible = publicInteractionRequest(preview ? { ...request, displayContext: { fileChanges: preview } } : request);
      this.pending.set(id, visible); updated.push(structuredClone(visible));
    }
    return updated;
  }

  get(id) { return this.pending.get(interactionKey(id)); }

  resolve(id) {
    const key = interactionKey(id), request = this.files.get(key);
    if (request) this.previews.delete(this.fileKey(request.params));
    this.files.delete(key); this.pending.delete(key);
  }

  snapshot() { return structuredClone([...this.pending.values()]); }

  claim(id, response) {
    const key = interactionKey(id);
    const request = this.pending.get(key);
    if (!request) {
      const error = new Error("Server request is no longer pending");
      error.code = "REQUEST_RESOLVED";
      throw error;
    }
    const validated = validateInteractionResponse(request, response);
    this.resolve(id);
    return validated;
  }
}
