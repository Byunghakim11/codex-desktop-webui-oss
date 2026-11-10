import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { canReceiveThreadContext } from "../server/thread-notification-scope.js";

test("unscoped tokens receive global and thread notifications", () => {
  assert.equal(canReceiveThreadContext({ visibleThreadIds: new Set() }, null), true);
  assert.equal(canReceiveThreadContext(
    { threadFilterCwds: [], visibleThreadIds: new Set() },
    { threadId: "thread-a" }
  ), true);
});

test("scoped tokens only receive known or in-scope thread notifications", () => {
  const allowedRoot = path.join(process.cwd(), "allowed");
  const scope = {
    threadFilterCwds: [allowedRoot],
    visibleThreadIds: new Set(["known-thread"])
  };
  assert.equal(canReceiveThreadContext(scope, { threadId: "known-thread" }), true);
  assert.equal(canReceiveThreadContext(scope, {
    threadId: "new-allowed-thread",
    thread: { cwd: path.join(allowedRoot, "project") }
  }), true);
  assert.equal(scope.visibleThreadIds.has("new-allowed-thread"), true);
  assert.equal(canReceiveThreadContext(scope, {
    threadId: "outside-thread",
    thread: { cwd: path.join(process.cwd(), "outside") }
  }), false);
  assert.equal(canReceiveThreadContext(scope, { threadId: "unknown-thread" }), false);
});
