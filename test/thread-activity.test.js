import test from "node:test";
import assert from "node:assert/strict";

import {
  THREAD_ACTIVITY,
  activityPriority,
  completionNotificationKey,
  createThreadActivity,
  reduceThreadActivity,
  shouldNotifyCompletion
} from "../public/thread-activity.js";

test("thread activity projects running, waiting, completion and read transitions", () => {
  let activity = reduceThreadActivity(null, { type: "turn-started", turnId: "turn-1" });
  assert.equal(activity.state, THREAD_ACTIVITY.RUNNING);
  assert.equal(activity.turnId, "turn-1");

  activity = reduceThreadActivity(activity, { type: "waiting-started" });
  assert.equal(activity.state, THREAD_ACTIVITY.WAITING);
  assert.equal(activity.pendingCount, 1);

  activity = reduceThreadActivity(activity, { type: "waiting-resolved" });
  assert.equal(activity.state, THREAD_ACTIVITY.RUNNING);

  activity = reduceThreadActivity(activity, { type: "turn-completed", status: "completed", unread: true });
  assert.equal(activity.state, THREAD_ACTIVITY.COMPLETED);
  assert.equal(activity.unread, true);

  activity = reduceThreadActivity(activity, { type: "opened" });
  assert.equal(activity.state, THREAD_ACTIVITY.IDLE);
  assert.equal(activity.unread, false);
});

test("activity priority keeps attention and running rows above idle rows", () => {
  assert.ok(activityPriority(createThreadActivity({ state: THREAD_ACTIVITY.WAITING }))
    < activityPriority(createThreadActivity({ state: THREAD_ACTIVITY.RUNNING })));
  assert.ok(activityPriority(createThreadActivity({ state: THREAD_ACTIVITY.COMPLETED, unread: true }))
    < activityPriority(createThreadActivity()));
});

test("completion notifications ignore the visible thread and deduplicate turn status", () => {
  const seenKeys = new Set([completionNotificationKey("thread-a", "turn-1", "completed")]);
  assert.equal(shouldNotifyCompletion({
    threadId: "thread-a",
    currentThreadId: "thread-b",
    turnId: "turn-1",
    status: "completed",
    seenKeys
  }), false);
  assert.equal(shouldNotifyCompletion({
    threadId: "thread-a",
    currentThreadId: "thread-a",
    turnId: "turn-2",
    status: "completed",
    seenKeys
  }), false);
  assert.equal(shouldNotifyCompletion({
    threadId: "thread-a",
    currentThreadId: "thread-b",
    turnId: "turn-2",
    status: "failed",
    seenKeys
  }), true);
});

test("thread list status objects restore active conversations after reconnect", () => {
  const activity = reduceThreadActivity(null, {
    type: "thread-snapshot",
    status: { type: "active", activeFlags: [] },
    updatedAt: 1_800_000_000
  });
  assert.equal(activity.state, THREAD_ACTIVITY.RUNNING);
});

test("authoritative idle snapshots clear stale running state", () => {
  const running = reduceThreadActivity(null, { type: "turn-started" });
  const idle = reduceThreadActivity(running, { type: "thread-snapshot", status: { type: "idle" } });
  assert.equal(idle.state, THREAD_ACTIVITY.IDLE);
});

test("approval resolution returns to running even when the start event omitted a turn id", () => {
  let activity = reduceThreadActivity(null, { type: "turn-started" });
  activity = reduceThreadActivity(activity, { type: "waiting-started" });
  activity = reduceThreadActivity(activity, { type: "waiting-resolved" });
  assert.equal(activity.state, THREAD_ACTIVITY.RUNNING);
});

test("a newer cached-thread manifest remains unread until the conversation is opened", () => {
  let activity = reduceThreadActivity(null, {
    type: "thread-updated",
    status: { type: "idle" },
    updatedAt: 1_800_000_000
  });
  assert.equal(activity.state, THREAD_ACTIVITY.COMPLETED);
  assert.equal(activity.unread, true);

  activity = reduceThreadActivity(activity, { type: "thread-snapshot", status: { type: "idle" } });
  assert.equal(activity.unread, true);

  activity = reduceThreadActivity(activity, { type: "opened" });
  assert.equal(activity.state, THREAD_ACTIVITY.IDLE);
  assert.equal(activity.unread, false);
});
