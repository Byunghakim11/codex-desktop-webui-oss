export const THREAD_ACTIVITY = Object.freeze({
  IDLE: "idle",
  RUNNING: "running",
  WAITING: "waiting",
  COMPLETED: "completed",
  FAILED: "failed"
});

export function createThreadActivity(overrides = {}) {
  return {
    state: THREAD_ACTIVITY.IDLE,
    unread: false,
    turnId: "",
    pendingCount: 0,
    resumeState: THREAD_ACTIVITY.IDLE,
    updatedAt: 0,
    ...overrides
  };
}

export function reduceThreadActivity(current, event = {}) {
  const previous = createThreadActivity(current);
  const updatedAt = normalizeTimestamp(event.updatedAt) || Date.now();

  if (event.type === "turn-started") {
    return createThreadActivity({
      state: THREAD_ACTIVITY.RUNNING,
      unread: false,
      turnId: String(event.turnId || previous.turnId || ""),
      pendingCount: previous.pendingCount,
      resumeState: THREAD_ACTIVITY.RUNNING,
      updatedAt
    });
  }

  if (event.type === "waiting-started") {
    return createThreadActivity({
      ...previous,
      state: THREAD_ACTIVITY.WAITING,
      pendingCount: previous.pendingCount + 1,
      resumeState: previous.state === THREAD_ACTIVITY.WAITING
        ? previous.resumeState
        : previous.state === THREAD_ACTIVITY.RUNNING
          ? THREAD_ACTIVITY.RUNNING
          : THREAD_ACTIVITY.IDLE,
      updatedAt
    });
  }

  if (event.type === "waiting-resolved") {
    const pendingCount = Math.max(0, previous.pendingCount - 1);
    return createThreadActivity({
      ...previous,
      state: pendingCount > 0
        ? THREAD_ACTIVITY.WAITING
        : previous.resumeState,
      pendingCount,
      updatedAt
    });
  }

  if (event.type === "turn-completed") {
    const state = terminalActivity(event.status);
    return createThreadActivity({
      state,
      unread: Boolean(event.unread),
      turnId: "",
      pendingCount: 0,
      resumeState: THREAD_ACTIVITY.IDLE,
      updatedAt
    });
  }

  if (event.type === "opened") {
    return createThreadActivity({
      ...previous,
      state: [THREAD_ACTIVITY.COMPLETED, THREAD_ACTIVITY.FAILED].includes(previous.state)
        ? THREAD_ACTIVITY.IDLE
        : previous.state,
      unread: false,
      updatedAt: previous.updatedAt
    });
  }

  if (event.type === "thread-updated") {
    const snapshotState = snapshotActivity(event.status);
    const state = [THREAD_ACTIVITY.RUNNING, THREAD_ACTIVITY.WAITING].includes(previous.state)
      ? previous.state
      : snapshotState === THREAD_ACTIVITY.RUNNING
        ? THREAD_ACTIVITY.RUNNING
        : snapshotState === THREAD_ACTIVITY.FAILED
          ? THREAD_ACTIVITY.FAILED
          : THREAD_ACTIVITY.COMPLETED;
    return createThreadActivity({
      ...previous,
      state,
      unread: true,
      resumeState: state === THREAD_ACTIVITY.RUNNING ? THREAD_ACTIVITY.RUNNING : previous.resumeState,
      updatedAt
    });
  }

  if (event.type === "thread-snapshot") {
    if (previous.state === THREAD_ACTIVITY.WAITING) return previous;
    const snapshotState = snapshotActivity(event.status);
    if (previous.unread && [THREAD_ACTIVITY.COMPLETED, THREAD_ACTIVITY.FAILED].includes(previous.state)) {
      return previous;
    }
    return createThreadActivity({
      ...previous,
      state: snapshotState,
      unread: false,
      turnId: snapshotState === THREAD_ACTIVITY.RUNNING ? previous.turnId : "",
      resumeState: snapshotState === THREAD_ACTIVITY.RUNNING ? THREAD_ACTIVITY.RUNNING : THREAD_ACTIVITY.IDLE,
      updatedAt: normalizeTimestamp(event.updatedAt) || previous.updatedAt
    });
  }

  return previous;
}

export function activityPriority(activity) {
  const state = activity?.state || THREAD_ACTIVITY.IDLE;
  if (state === THREAD_ACTIVITY.WAITING) return 0;
  if (state === THREAD_ACTIVITY.RUNNING) return 1;
  if (activity?.unread && state === THREAD_ACTIVITY.FAILED) return 2;
  if (activity?.unread && state === THREAD_ACTIVITY.COMPLETED) return 3;
  return 4;
}

export function completionNotificationKey(threadId, turnId, status) {
  return [threadId, turnId || "latest", normalizeStatus(status) || "completed"].join(":");
}

export function shouldNotifyCompletion({ threadId, currentThreadId, turnId, status, seenKeys }) {
  if (!threadId || threadId === currentThreadId) return false;
  const key = completionNotificationKey(threadId, turnId, status);
  return !seenKeys?.has(key);
}

function terminalActivity(status) {
  const normalized = normalizeStatus(status);
  return ["completed", "complete", "done", "success", "succeeded"].includes(normalized)
    ? THREAD_ACTIVITY.COMPLETED
    : THREAD_ACTIVITY.FAILED;
}

function snapshotActivity(status) {
  const normalized = normalizeStatus(status);
  if (["inprogress", "in-progress", "running", "active", "working"].includes(normalized)) {
    return THREAD_ACTIVITY.RUNNING;
  }
  if (["failed", "error", "interrupted", "cancelled", "canceled"].includes(normalized)) {
    return THREAD_ACTIVITY.FAILED;
  }
  return THREAD_ACTIVITY.IDLE;
}

function normalizeStatus(status) {
  const value = status && typeof status === "object"
    ? status.type || status.status || status.state || ""
    : status;
  return String(value || "").trim().toLowerCase().replace(/[_\s]+/g, "-");
}

function normalizeTimestamp(value) {
  if (!value) return 0;
  if (typeof value === "number") return value < 100000000000 ? value * 1000 : value;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}
