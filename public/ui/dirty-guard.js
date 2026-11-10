// Shared "can we change conversation/project context now?" guard.
// Probes are read lazily so the caller stays the single owner of composer,
// attachment, editor and pending-commit state.
export const PENDING_STATE_KEYS = Object.freeze([
  "composerDraft",
  "nativeDraft",
  "attachmentDraft",
  "fileEditorDirty",
  "pendingCommit",
  "queuedAnswer"
]);

function readProbe(probe) {
  if (typeof probe === "function") {
    try {
      return Boolean(probe());
    } catch {
      // A broken probe is treated as pending: fail closed, never lose work.
      return true;
    }
  }
  return Boolean(probe);
}

export function snapshotPendingState(probes = {}) {
  const values = {};
  const reasons = [];
  for (const key of PENDING_STATE_KEYS) {
    const pending = readProbe(probes[key]);
    values[key] = pending;
    if (pending) reasons.push(key);
  }
  return { pending: reasons.length > 0, reasons, values };
}

export function createDirtyGuard({ probes = {}, confirm, onBlocked } = {}) {
  function snapshot() {
    return snapshotPendingState(probes);
  }

  async function requestTransition(reason, options = {}) {
    const state = snapshot();
    if (!state.pending) return true;
    const confirmFn = typeof options.confirm === "function" ? options.confirm : confirm;
    if (typeof confirmFn !== "function") {
      onBlocked?.(reason, state);
      return false;
    }
    let allowed = false;
    try {
      allowed = Boolean(await confirmFn({ reason, reasons: state.reasons, snapshot: state }));
    } catch {
      allowed = false;
    }
    if (!allowed) onBlocked?.(reason, state);
    return allowed;
  }

  return {
    snapshotPendingState: snapshot,
    hasUnsavedChanges: () => snapshot().pending,
    requestTransition
  };
}

// Runs the optional WorkspacePanel hook (`beforeContextChange`) and the dirty
// guard before a real thread/project/new-draft switch. A monotonically
// increasing generation invalidates navigation that finished its async guard
// after a newer transition started.
export function createTransitionController({ guard, getBeforeContextChange, onError, onBlocked, onBlockedReason } = {}) {
  let generation = 0;

  function notifyBlocked(reason) {
    onBlocked?.(reason);
    onBlockedReason?.(reason);
  }

  async function prepare(reason) {
    const token = ++generation;
    if (guard) {
      let allowed;
      try {
        allowed = await guard.requestTransition(reason);
      } catch (error) {
        onError?.(error);
        return { ok: false, blocked: true, token };
      }
      if (!allowed) {
        notifyBlocked(reason);
        return { ok: false, blocked: true, token };
      }
    }
    let hook = null;
    try {
      hook = typeof getBeforeContextChange === "function" ? getBeforeContextChange() : null;
    } catch (error) {
      onError?.(error);
      return { ok: false, blocked: true, token };
    }
    if (typeof hook === "function") {
      let result;
      try {
        result = await hook(reason);
      } catch (error) {
        onError?.(error);
        return { ok: false, blocked: true, token };
      }
      if (result === false) {
        notifyBlocked(reason);
        return { ok: false, blocked: true, token };
      }
    }
    return { ok: true, token };
  }

  return {
    generation: () => generation,
    invalidate() {
      generation += 1;
      return generation;
    },
    isCurrent(token) {
      return token === generation;
    },
    prepare,
    async run(reason, action) {
      const prepared = await prepare(reason);
      if (!prepared.ok) return prepared;
      if (prepared.token !== generation) return { ok: false, stale: true, token: prepared.token };
      if (typeof action !== "function") return { ok: true, token: prepared.token };
      let value;
      try {
        value = await action();
      } catch (error) {
        onError?.(error);
        return { ok: false, error, token: prepared.token };
      }
      if (prepared.token !== generation) return { ok: false, stale: true, token: prepared.token, value };
      return { ok: true, token: prepared.token, value };
    }
  };
}
