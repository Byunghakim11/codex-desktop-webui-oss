import assert from "node:assert/strict";
import test from "node:test";
import {
  activeTurnIdFromLatest,
  anchoredHistoryScrollTop,
  createLatestFrameBatcher,
  createReadinessGate,
  createRecentThreadCache,
  disclosureIdentity,
  findTransientMessageAliasIndex,
  HISTORY_PREFETCH_PX,
  initialThreadCandidates,
  ACTIVE_THREAD_SYNC_MS,
  IDLE_THREAD_SYNC_MS,
  liveFollowState,
  mergeRecentMessages,
  restoreFirstUsableThread,
  shouldAutoLoadOlderTurns,
  shouldRefreshCachedThread,
  selectThreadCachePrewarmIds,
  shouldRenderThreadLoadOverlay,
  threadSyncDelay,
  turnLifecycle,
  updateDisclosureState
} from "../public/thread-sync.js";

test("initial thread restore skips stale IDs and falls back in stable order", () => {
  const threads = [
    { id: "recent", updatedAt: 30 },
    { id: "last-good", updatedAt: 20 },
    { id: "linked", updatedAt: 10 }
  ];
  assert.deepEqual(
    initialThreadCandidates({ threads, urlThreadId: "linked", lastThreadId: "last-good" }).map((entry) => entry.id),
    ["linked", "last-good", "recent"]
  );
  assert.deepEqual(
    initialThreadCandidates({ threads, urlThreadId: "stale", lastThreadId: "missing" }).map((entry) => entry.id),
    ["recent"]
  );
  assert.deepEqual(
    initialThreadCandidates({ threads, urlThreadId: "recent", lastThreadId: "recent" }).map((entry) => entry.id),
    ["recent"]
  );
});

test("initial thread restore continues after a candidate fails to load", async () => {
  const attempted = [];
  const candidates = [{ id: "stale" }, { id: "last-good" }, { id: "recent" }];
  const restored = await restoreFirstUsableThread(candidates, async (thread) => {
    attempted.push(thread.id);
    return thread.id === "last-good";
  });
  assert.equal(restored.id, "last-good");
  assert.deepEqual(attempted, ["stale", "last-good"]);
});

test("thread sync uses active, idle, and hidden-page rates", () => {
  assert.equal(threadSyncDelay({ visible: true, working: true }), ACTIVE_THREAD_SYNC_MS);
  assert.equal(ACTIVE_THREAD_SYNC_MS, 3000);
  assert.equal(threadSyncDelay({ visible: true, working: false }), IDLE_THREAD_SYNC_MS);
  assert.equal(IDLE_THREAD_SYNC_MS, 15000);
  assert.equal(threadSyncDelay({ visible: false, working: true }), null);
});

test("older history auto-load requires explicit scroll intent and an available cursor", () => {
  assert.equal(shouldAutoLoadOlderTurns({ armed: false, scrollTop: 0, hasCursor: true, loading: false }), false);
  assert.equal(shouldAutoLoadOlderTurns({ armed: true, scrollTop: HISTORY_PREFETCH_PX - 1, hasCursor: true, loading: false }), true);
  assert.equal(shouldAutoLoadOlderTurns({ armed: true, scrollTop: 0, hasCursor: false, loading: false }), false);
  assert.equal(shouldAutoLoadOlderTurns({ armed: true, scrollTop: 0, hasCursor: true, loading: true }), false);
});

test("older history insertion preserves the visible viewport anchor", () => {
  assert.equal(anchoredHistoryScrollTop({ beforeHeight: 1200, beforeTop: 36, afterHeight: 1800 }), 636);
  assert.equal(anchoredHistoryScrollTop({ beforeHeight: 1200, beforeTop: 0, afterHeight: 900 }), 0);
});

test("explicit reading suspends live follow until the viewport returns to the bottom", () => {
  assert.equal(liveFollowState({ current: true, userReading: true, nearBottom: true }), false);
  assert.equal(liveFollowState({ current: false, userReading: false, nearBottom: false }), false);
  assert.equal(liveFollowState({ current: false, userReading: false, nearBottom: true }), true);
});

test("disclosure identity and open state survive live rerenders", () => {
  const key = disclosureIdentity({ threadId: "thread-1", prefix: "reasoning", messageId: "item-7" });
  assert.equal(key, "thread-1:reasoning:item-7");
  const opened = updateDisclosureState(new Set(), key, true);
  assert.equal(opened.has(key), true);
  assert.equal(updateDisclosureState(opened, key, false).has(key), false);
});

test("recent reconciliation preserves older history and adopts new items", () => {
  const current = [
    { id: "old", role: "user", text: "older" },
    { id: "u1", role: "user", text: "question" },
    { pendingReply: true, role: "assistant", text: "" }
  ];
  const recent = [
    { id: "u1", role: "user", text: "question" },
    { id: "a1", role: "assistant", text: "answer" }
  ];
  const result = mergeRecentMessages(current, recent);
  assert.equal(result.changed, true);
  assert.deepEqual(result.messages.map((message) => message.id), ["old", "u1", "a1"]);
});

test("recent reconciliation never shortens a live streaming message", () => {
  const current = [
    { id: "a1", role: "assistant", text: "a longer live delta", streamingReply: true },
    { pendingLocal: true, role: "user", text: "sent from phone" }
  ];
  const recent = [
    { id: "a1", role: "assistant", text: "short" },
    { id: "u2", role: "user", text: "sent from phone" }
  ];
  const result = mergeRecentMessages(current, recent);
  assert.equal(result.messages.find((message) => message.id === "a1").text, "a longer live delta");
  assert.equal(result.messages.some((message) => message.pendingLocal), false);
  assert.equal(result.messages.at(-1).id, "u2");
});

test("active reconciliation preserves notification-only tail records until authority catches up", () => {
  const current = [
    { id: "u1", role: "user", text: "question" },
    { id: "tool-live", role: "tool", text: "working" }
  ];
  const recent = [{ id: "u1", role: "user", text: "question" }];
  const result = mergeRecentMessages(current, recent, { preserveLiveState: true });
  assert.deepEqual(result.messages.map((message) => message.id), ["u1", "tool-live"]);
});

test("terminal reconciliation clears optimistic and streaming state", () => {
  const current = [
    { id: "u1", role: "user", text: "question", pendingLocal: true },
    { id: "a1", role: "assistant", text: "done", streamingReply: true },
    { id: "pending", role: "assistant", text: "", pendingReply: true }
  ];
  const recent = [
    { id: "u1", role: "user", text: "question" },
    { id: "a1", role: "assistant", text: "done" }
  ];
  const result = mergeRecentMessages(current, recent, { preserveLiveState: false });
  assert.deepEqual(result.messages.map((message) => message.id), ["u1", "a1"]);
  assert.equal(result.messages.some((message) => message.pendingLocal || message.pendingReply || message.streamingReply), false);
});

test("multiple user messages inside one turn survive authoritative reconciliation", () => {
  const current = [
    { id: "u1", role: "user", text: "initial" },
    { role: "user", text: "steer this", pendingLocal: true }
  ];
  const recent = [
    { id: "u1", role: "user", text: "initial" },
    { id: "u2", role: "user", text: "steer this" }
  ];
  const result = mergeRecentMessages(current, recent, { preserveLiveState: true });
  assert.deepEqual(result.messages.map((message) => message.id), ["u1", "u2"]);
});

test("client message ids reconcile identical steering messages one-for-one", () => {
  const current = [
    { role: "user", text: "same guide", clientUserMessageId: "client-1", pendingLocal: true },
    { role: "user", text: "same guide", clientUserMessageId: "client-2", pendingLocal: true }
  ];
  const recent = [
    { id: "u2", role: "user", text: "same guide", clientUserMessageId: "client-2" }
  ];
  const result = mergeRecentMessages(current, recent, { preserveLiveState: true });
  assert.deepEqual(
    result.messages.map((message) => message.clientUserMessageId),
    ["client-1", "client-2"]
  );
  assert.equal(result.messages[0].pendingLocal, true);
  assert.equal(result.messages[1].id, "u2");
});

test("active reconciliation collapses different live and authoritative IDs in the same turn", () => {
  const current = [
    { id: "live-u", turnId: "turn-1", role: "user", text: "question", liveNotification: true },
    { id: "live-a", turnId: "turn-1", role: "assistant", text: "answer", liveNotification: true }
  ];
  const recent = [
    { id: "auth-u", turnId: "turn-1", role: "user", text: "question" },
    { id: "auth-a", turnId: "turn-1", role: "assistant", text: "answer" }
  ];
  const result = mergeRecentMessages(current, recent, { preserveLiveState: true });
  assert.deepEqual(result.messages.map((message) => message.id), ["auth-u", "auth-a"]);
});

test("live alias reconciliation consumes identical messages one-for-one", () => {
  const current = [
    { id: "live-1", turnId: "turn-1", role: "assistant", text: "same", liveNotification: true },
    { id: "live-2", turnId: "turn-1", role: "assistant", text: "same", liveNotification: true }
  ];
  const recent = [
    { id: "auth-1", turnId: "turn-1", role: "assistant", text: "same" }
  ];
  const result = mergeRecentMessages(current, recent, { preserveLiveState: true });
  assert.equal(result.messages.length, 2);
  assert.deepEqual(new Set(result.messages.map((message) => message.id)), new Set(["auth-1", "live-2"]));
});

test("same text in different turns is not treated as a live alias", () => {
  const current = [
    { id: "live-old", turnId: "turn-old", role: "assistant", text: "same", liveNotification: true }
  ];
  const recent = [
    { id: "auth-new", turnId: "turn-new", role: "assistant", text: "same" }
  ];
  const result = mergeRecentMessages(current, recent, { preserveLiveState: true });
  assert.deepEqual(result.messages.map((message) => message.id), ["live-old", "auth-new"]);
});

test("completed notifications replace their transient delta alias before authority catches up", () => {
  const messages = [
    { id: "delta-id", turnId: "turn-1", role: "assistant", text: "done", liveNotification: true },
    { id: "older", turnId: "turn-0", role: "assistant", text: "done" }
  ];
  assert.equal(findTransientMessageAliasIndex(messages, {
    id: "completed-id",
    turnId: "turn-1",
    role: "assistant",
    text: "done",
    liveNotification: true
  }), 0);
  assert.equal(findTransientMessageAliasIndex(messages, {
    id: "completed-id",
    turnId: "turn-2",
    role: "assistant",
    text: "done",
    liveNotification: true
  }), -1);
});

test("same-text pending messages reconcile only with the matching image", () => {
  const current = [
    { role: "user", text: "", images: [{ kind: "source", source: "C:\\a.png" }], pendingLocal: true },
    { role: "user", text: "", images: [{ kind: "source", source: "C:\\b.png" }], pendingLocal: true }
  ];
  const recent = [
    { id: "u-b", role: "user", text: "", images: [{ kind: "source", source: "C:\\b.png" }] }
  ];
  const result = mergeRecentMessages(current, recent, { preserveLiveState: true });
  assert.equal(result.messages.length, 2);
  assert.equal(result.messages[0].images[0].source, "C:\\a.png");
  assert.equal(result.messages[1].id, "u-b");
});

test("structured message state changes trigger an authoritative rerender", () => {
  const current = [{
    id: "image-1",
    role: "assistant",
    text: "",
    imageGeneration: { pending: true, failed: false, status: "running" }
  }];
  const recent = [{
    id: "image-1",
    role: "assistant",
    text: "",
    imageGeneration: { pending: false, failed: false, status: "completed" }
  }];
  const result = mergeRecentMessages(current, recent, { preserveLiveState: false });
  assert.equal(result.changed, true);
  assert.equal(result.messages[0].imageGeneration.status, "completed");
});

test("turn lifecycle normalizes active and terminal status shapes", () => {
  assert.equal(turnLifecycle({ type: "inProgress" }), "active");
  assert.equal(turnLifecycle("running"), "active");
  assert.equal(turnLifecycle("completed"), "terminal");
  assert.equal(turnLifecycle("interrupted"), "terminal");
  assert.equal(turnLifecycle("ready"), "unknown");
});

test("authoritative newest turn sets and clears the active turn id", () => {
  assert.equal(
    activeTurnIdFromLatest("stale-turn", { id: "running-turn", status: "inProgress" }),
    "running-turn"
  );
  assert.equal(activeTurnIdFromLatest("stale-turn", { id: "done-turn", status: "completed" }), null);
  assert.equal(activeTurnIdFromLatest("stale-turn", { id: "unknown-turn", status: "ready" }), "stale-turn");
});

test("readiness gate releases queued work exactly once", async () => {
  const gate = createReadinessGate();
  let releases = 0;
  const waiting = gate.promise.then(() => {
    releases += 1;
  });

  assert.equal(gate.ready, false);
  assert.equal(gate.resolve(), true);
  assert.equal(gate.resolve(), false);
  await waiting;
  assert.equal(gate.ready, true);
  assert.equal(releases, 1);
});

test("latest-frame batcher coalesces burst deltas and preserves scroll intent", () => {
  const callbacks = new Map();
  const rendered = [];
  let nextHandle = 1;
  const batcher = createLatestFrameBatcher({
    scheduleFrame(callback) {
      const handle = nextHandle++;
      callbacks.set(handle, callback);
      return handle;
    },
    cancelFrame(handle) {
      callbacks.delete(handle);
    },
    render(value) {
      rendered.push(value);
    }
  });

  batcher.schedule({ itemId: "a1", text: "a", scroll: false });
  batcher.schedule({ itemId: "a1", text: "ab", scroll: true });
  assert.equal(callbacks.size, 1);
  callbacks.values().next().value();
  assert.deepEqual(rendered, [{ itemId: "a1", text: "ab", scroll: true }]);
});

test("recent thread cache is bounded and refreshes least-recently-used entries", () => {
  const cache = createRecentThreadCache(2);
  cache.set("a", { turns: ["a"] });
  cache.set("b", { turns: ["b"] });
  assert.deepEqual(cache.get("a"), { turns: ["a"] });
  cache.set("c", { turns: ["c"] });
  assert.equal(cache.get("b"), null);
  assert.deepEqual(cache.get("a"), { turns: ["a"] });
  assert.equal(cache.size, 2);
  cache.clear();
  assert.equal(cache.size, 0);
});

test("cached newest page refreshes only for newer or working threads", () => {
  assert.equal(shouldRefreshCachedThread({ cachedTimestamp: 100, threadTimestamp: 100, working: false }), false);
  assert.equal(shouldRefreshCachedThread({ cachedTimestamp: 100, threadTimestamp: 101, working: false }), true);
  assert.equal(shouldRefreshCachedThread({ cachedTimestamp: 100, threadTimestamp: 100, working: true }), true);
  assert.equal(shouldRefreshCachedThread({ cachedTimestamp: null, threadTimestamp: 100, working: false }), true);
  assert.equal(shouldRefreshCachedThread({ cachedTimestamp: 1_800_000_000, threadTimestamp: 1_800_000_000_000, working: false }), false);
  assert.equal(shouldRefreshCachedThread({ cachedTimestamp: "2026-08-21T10:00:00Z", threadTimestamp: "2026-08-21T10:00:01Z", working: false }), true);
});

test("cache prewarming prioritizes every active conversation before recent idle conversations", () => {
  const threads = [
    { id: "idle-new" },
    { id: "running-a" },
    { id: "idle-old" },
    { id: "waiting-b" },
    { id: "ephemeral-agent", ephemeral: true },
    { id: "current" }
  ];
  const activity = new Map([
    ["running-a", { state: "running" }],
    ["waiting-b", { state: "waiting" }]
  ]);
  assert.deepEqual(selectThreadCachePrewarmIds({
    threads,
    activityByThread: activity,
    currentThreadId: "current",
    limit: 4
  }), ["running-a", "waiting-b", "idle-new", "idle-old"]);
});

test("cached content remains visible while settings traffic continues", () => {
  assert.equal(shouldRenderThreadLoadOverlay({ showLoading: true }), true);
  assert.equal(shouldRenderThreadLoadOverlay({ showLoading: false }), false);
  assert.equal(shouldRenderThreadLoadOverlay(null), false);
});
