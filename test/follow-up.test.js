import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  buildInterruptRequest,
  buildPromptRequest,
  shouldAdvanceQueueAfterTurn,
  waitForPendingImageUploads
} from "../public/follow-up.js";

const input = [
  { type: "text", text: "guide this run", text_elements: [] },
  { type: "localImage", path: "D:\\image.png" }
];

test("idle prompt starts a new turn without overriding shared thread settings", () => {
  assert.deepEqual(buildPromptRequest({
    threadId: "thread-1",
    activeTurnId: null,
    clientUserMessageId: "client-message-1",
    input
  }), {
    mode: "start",
    method: "turn/start",
    params: { threadId: "thread-1", input, clientUserMessageId: "client-message-1" }
  });
});

test("active prompt steers the exact turn and preserves text plus images", () => {
  assert.deepEqual(buildPromptRequest({
    threadId: "thread-1",
    activeTurnId: "turn-active",
    clientUserMessageId: "client-message-2",
    input
  }), {
    mode: "steer",
    method: "turn/steer",
    params: {
      threadId: "thread-1",
      expectedTurnId: "turn-active",
      input,
      clientUserMessageId: "client-message-2"
    }
  });
});

test("active prompt can enter the authoritative thread queue", () => {
  assert.deepEqual(buildPromptRequest({
    threadId: "thread-1",
    activeTurnId: "turn-active",
    clientUserMessageId: "client-message-3",
    input,
    queue: true
  }), {
    mode: "queue",
    method: "thread/queue/add",
    params: {
      threadId: "thread-1",
      input,
      clientUserMessageId: "client-message-3"
    }
  });
});

test("active response interruption targets the exact thread and turn", () => {
  assert.deepEqual(buildInterruptRequest({
    threadId: "thread-1",
    activeTurnId: "turn-active"
  }), {
    method: "turn/interrupt",
    params: { threadId: "thread-1", turnId: "turn-active" }
  });
  assert.throws(
    () => buildInterruptRequest({ threadId: "thread-1", activeTurnId: null }),
    /active thread and turn/i
  );
});

test("stopping a response does not immediately start its queued follow-up", () => {
  assert.equal(shouldAdvanceQueueAfterTurn("completed"), true);
  assert.equal(shouldAdvanceQueueAfterTurn("failed"), true);
  assert.equal(shouldAdvanceQueueAfterTurn("interrupted"), false);
  assert.equal(shouldAdvanceQueueAfterTurn("cancelled"), false);
});

test("guided image submission waits for every in-flight upload", async () => {
  let finishFirst;
  let finishSecond;
  const first = new Promise((resolve) => finishFirst = resolve);
  const second = new Promise((resolve) => finishSecond = resolve);
  let settled = false;
  const waiting = waitForPendingImageUploads([
    { status: "uploading", readyPromise: first },
    { status: "preparing", readyPromise: second },
    { status: "ready", readyPromise: Promise.resolve() }
  ]).then((result) => {
    settled = true;
    return result;
  });

  finishFirst();
  await Promise.resolve();
  assert.equal(settled, false);
  finishSecond();
  assert.equal(await waiting, true);
});

test("mobile composer keeps one action slot and exposes guide, queue, and stop actions in a menu", () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const css = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");

  assert.match(html, /id="followUpMenu"[^>]*role="menu"/);
  assert.match(html, /data-follow-up-mode="steer"/);
  assert.match(html, /data-follow-up-mode="queue"/);
  assert.match(html, /data-follow-up-mode="stop"/);
  assert.doesNotMatch(html, /id="queueButton"/);
  assert.doesNotMatch(css, /\.queue-button/);
  assert.match(css, /grid-template-columns:\s*40px 40px minmax\(0, 1fr\) 58px/);
});
