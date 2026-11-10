export const ACTIVE_THREAD_SYNC_MS = 3000;
export const IDLE_THREAD_SYNC_MS = 15000;
export const HISTORY_PREFETCH_PX = 240;

export function initialThreadCandidates({ threads, urlThreadId, lastThreadId }) {
  const available = Array.isArray(threads) ? threads.filter((thread) => thread?.id) : [];
  const byId = new Map(available.map((thread) => [String(thread.id), thread]));
  const candidates = [];
  const seen = new Set();
  for (const id of [urlThreadId, lastThreadId, available[0]?.id]) {
    const key = String(id || "");
    if (!key || seen.has(key) || !byId.has(key)) continue;
    seen.add(key);
    candidates.push(byId.get(key));
  }
  return candidates;
}

export async function restoreFirstUsableThread(candidates, openThread) {
  for (const thread of candidates || []) {
    if (await openThread(thread)) return thread;
  }
  return null;
}

export function threadSyncDelay({ visible, working }) {
  if (!visible) return null;
  return working ? ACTIVE_THREAD_SYNC_MS : IDLE_THREAD_SYNC_MS;
}

export function shouldAutoLoadOlderTurns({ armed, scrollTop, hasCursor, loading }) {
  return Boolean(armed && hasCursor && !loading && Number(scrollTop) < HISTORY_PREFETCH_PX);
}

export function anchoredHistoryScrollTop({ beforeHeight, beforeTop, afterHeight }) {
  return Math.max(0, Number(afterHeight) - Number(beforeHeight) + Number(beforeTop));
}

export function liveFollowState({ current, userReading, nearBottom }) {
  if (userReading) return false;
  if (nearBottom) return true;
  return Boolean(current);
}

export function disclosureIdentity({ threadId, prefix, messageId, fallback }) {
  return `${threadId || "draft"}:${prefix || "details"}:${messageId || fallback || "item"}`;
}

export function updateDisclosureState(current, key, open) {
  const next = new Set(current || []);
  if (open) next.add(key);
  else next.delete(key);
  return next;
}

export function turnLifecycle(status) {
  const raw = typeof status === "object" && status?.type ? status.type : status;
  const value = String(raw || "").replace(/[\s_-]+/g, "").toLowerCase();
  if (["inprogress", "running"].includes(value)) return "active";
  if (["completed", "failed", "cancelled", "canceled", "interrupted"].includes(value)) return "terminal";
  return "unknown";
}

export function activeTurnIdFromLatest(currentTurnId, latestTurn) {
  const lifecycle = turnLifecycle(latestTurn?.status);
  if (lifecycle === "active") return latestTurn?.id || currentTurnId || null;
  if (lifecycle === "terminal") return null;
  return currentTurnId || null;
}

export function createReadinessGate() {
  let ready = false;
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return {
    promise,
    get ready() {
      return ready;
    },
    resolve() {
      if (ready) return false;
      ready = true;
      release();
      return true;
    }
  };
}

/** Missing completion/sync fields cannot erase a live item's known native scope. */
export function mergeMessageClassification(existing, incoming) {
  if (!existing) return incoming;
  const merged = { ...existing, ...incoming };
  if (incoming?.role !== "assistant") return merged;
  for (const field of ["phase", "delivery", "questions"]) if (incoming[field] == null && existing[field] != null) merged[field] = existing[field];
  const knownPhase = ["final", "final_answer", "commentary"].includes(merged.phase);
  merged.classificationPending = !knownPhase && Boolean(existing.classificationPending || incoming.classificationPending || existing.streamingReply || incoming.streamingReply);
  return merged;
}

export function mergeRecentMessages(currentMessages, recentMessages, { preserveLiveState = true } = {}) {
  const current = Array.isArray(currentMessages) ? currentMessages : [];
  const recent = Array.isArray(recentMessages) ? recentMessages : [];
  if (!recent.length) {
    const messages = preserveLiveState ? current : finalizeMessages(current);
    return { messages, changed: messageSignature(current) !== messageSignature(messages) };
  }

  const recentIds = new Set(recent.map((message) => message?.id).filter(Boolean));
  const aliasSources = new Map();
  for (const message of current) if (message?.liveNotification && !recentIds.has(message.id)) {
    const key = transientMessageAliasKey(message);
    if (key) { if (!aliasSources.has(key)) aliasSources.set(key, []); aliasSources.get(key).push(message); }
  }
  const recentAliasCounts = messageAliasCounts(recent);
  const recentUserIdentities = new Set(
    recent.filter((message) => message?.role === "user").map(userMessageIdentity)
  );
  const hasRecentAssistant = recent.some((message) => message?.role === "assistant");
  const withoutSatisfiedPlaceholders = current.filter((message) => {
    if (message?.pendingLocal && recentUserIdentities.has(userMessageIdentity(message))) return false;
    if (message?.pendingReply && hasRecentAssistant) return false;
    if (message?.liveNotification && !recentIds.has(message?.id)) {
      const aliasKey = transientMessageAliasKey(message);
      const remaining = recentAliasCounts.get(aliasKey) || 0;
      if (aliasKey && remaining > 0) {
        recentAliasCounts.set(aliasKey, remaining - 1);
        return false;
      }
    }
    return true;
  });
  const currentById = new Map(
    withoutSatisfiedPlaceholders.filter((message) => message?.id).map((message) => [message.id, message])
  );
  const hydratedRecent = recent.map((incoming) => {
    const existing = (incoming?.id ? currentById.get(incoming.id) : null) || aliasSources.get(transientMessageAliasKey(incoming))?.shift();
    if (!existing) return incoming;
    const preserveLongerStream = preserveLiveState
      && existing.streamingReply
      && String(existing.text || "").length > String(incoming.text || "").length;
    const hydrated = {
      ...mergeMessageClassification(existing, incoming),
      pendingLocal: false,
      pendingReply: false,
      streamingReply: preserveLongerStream,
      liveNotification: false
    };
    if (preserveLongerStream) hydrated.text = existing.text;
    return hydrated;
  });

  const matchingIndexes = withoutSatisfiedPlaceholders
    .map((message, index) => message?.id && recentIds.has(message.id) ? index : -1)
    .filter((index) => index >= 0);
  const boundary = matchingIndexes.length ? Math.min(...matchingIndexes) : withoutSatisfiedPlaceholders.length;
  const prefix = withoutSatisfiedPlaceholders
    .slice(0, boundary)
    .filter((message) => !message?.id || !recentIds.has(message.id));
  const liveTail = withoutSatisfiedPlaceholders
    .slice(boundary)
    .filter((message) => {
      if (message?.id && recentIds.has(message.id)) return false;
      return preserveLiveState;
    });
  const merged = [...prefix, ...hydratedRecent, ...liveTail];
  const messages = preserveLiveState ? merged : finalizeMessages(merged);
  return { messages, changed: messageSignature(current) !== messageSignature(messages) };
}

export function findTransientMessageAliasIndex(messages, incoming) {
  const aliasKey = transientMessageAliasKey(incoming);
  if (!aliasKey) return -1;
  return (messages || []).findIndex((message) => (
    Boolean(message?.liveNotification)
    && message?.id !== incoming?.id
    && transientMessageAliasKey(message) === aliasKey
  ));
}

export function transientMessageAliasKey(message) {
  const turnId = String(message?.turnId || "");
  if (!turnId) return "";
  const images = (message?.images || [])
    .map((image) => typeof image === "string"
      ? image
      : image?.source || image?.id || image?.path || image?.url || "")
    .filter(Boolean);
  return JSON.stringify([
    turnId,
    String(message?.role || ""),
    String(message?.kind || ""),
    String(message?.text || "").trim(),
    images
  ]);
}

function messageAliasCounts(messages) {
  const counts = new Map();
  for (const message of messages || []) {
    const aliasKey = transientMessageAliasKey(message);
    if (!aliasKey) continue;
    counts.set(aliasKey, (counts.get(aliasKey) || 0) + 1);
  }
  return counts;
}

function userMessageIdentity(message) {
  if (message?.clientUserMessageId) return `client:${message.clientUserMessageId}`;
  const images = (message?.images || [])
    .map((image) => typeof image === "string"
      ? image
      : image?.source || image?.id || image?.path || image?.url || "")
    .filter(Boolean);
  return JSON.stringify([String(message?.text || "").trim(), images]);
}

export function createLatestFrameBatcher({ scheduleFrame, cancelFrame, render }) {
  let frame = null;
  let pending = null;

  const flush = () => {
    frame = null;
    const next = pending;
    pending = null;
    if (next) render(next);
  };

  return {
    schedule(value) {
      pending = pending
        ? { ...value, scroll: Boolean(pending.scroll || value?.scroll) }
        : value;
      if (frame == null) frame = scheduleFrame(flush);
    },
    cancel() {
      if (frame != null) cancelFrame(frame);
      frame = null;
      pending = null;
    },
    flush() {
      if (frame != null) cancelFrame(frame);
      flush();
    }
  };
}

export function createRecentThreadCache(maxEntries = 16) {
  const entries = new Map();
  const limit = Math.max(1, Number(maxEntries) || 1);

  return {
    get(threadId) {
      const key = String(threadId || "");
      if (!entries.has(key)) return null;
      const value = entries.get(key);
      entries.delete(key);
      entries.set(key, value);
      return value;
    },
    set(threadId, value) {
      const key = String(threadId || "");
      if (!key) return;
      entries.delete(key);
      entries.set(key, value);
      while (entries.size > limit) entries.delete(entries.keys().next().value);
    },
    delete(threadId) {
      entries.delete(String(threadId || ""));
    },
    clear() {
      entries.clear();
    },
    get size() {
      return entries.size;
    }
  };
}

export function shouldRefreshCachedThread({ cachedTimestamp, threadTimestamp, working }) {
  if (working) return true;
  const cachedMs = timestampMillis(cachedTimestamp);
  const threadMs = timestampMillis(threadTimestamp);
  if (!cachedMs) return true;
  if (!threadMs) return false;
  return threadMs > cachedMs;
}

export function selectThreadCachePrewarmIds({ threads, activityByThread, currentThreadId, limit = 16 }) {
  const ordered = [];
  const seen = new Set();
  const candidates = (threads || []).filter((thread) => (
    thread?.id && !thread.ephemeral && thread.id !== currentThreadId
  ));
  const append = (thread) => {
    const id = String(thread.id);
    if (seen.has(id)) return;
    seen.add(id);
    ordered.push(id);
  };
  const isActive = (thread) => ["running", "waiting"].includes(activityByThread?.get(thread.id)?.state);

  candidates.filter(isActive).forEach(append);
  candidates.filter((thread) => !isActive(thread)).forEach(append);
  return ordered.slice(0, Math.max(1, Number(limit) || 1));
}

export function shouldRenderThreadLoadOverlay(stats) {
  return Boolean(stats && stats.showLoading !== false);
}

function timestampMillis(value) {
  if (value == null || value === "") return 0;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric < 100000000000 ? numeric * 1000 : numeric;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function finalizeMessages(messages) {
  return messages
    .filter((message) => !message?.pendingReply)
    .map((message) => ({
      ...message,
      pendingLocal: false,
      pendingReply: false,
      streamingReply: false
    }));
}

function messageSignature(messages) {
  return JSON.stringify(messages.map((message) => [
    message?.id || "",
    message?.role || "",
    message?.kind || "",
    String(message?.text || ""),
    Boolean(message?.pendingLocal),
    Boolean(message?.pendingReply),
    Boolean(message?.streamingReply),
    Boolean(message?.liveNotification),
    Boolean(message?.classificationPending),
    String(message?.turnId || ""),
    String(message?.clientUserMessageId || ""),
    JSON.stringify(message?.images || []),
    JSON.stringify(message?.reasoningParts || []),
    JSON.stringify(message?.imageGeneration || null),
    String(message?.phase || ""),
    String(message?.delivery || ""),
    JSON.stringify(message?.questions || null),
    JSON.stringify(message?.questionReplies || null),
    JSON.stringify(message?.automationHeartbeat || null)
  ]));
}
