import test from "node:test";
import assert from "node:assert/strict";
import { InteractionSession } from "../server/interaction-session.js";

const request = id => ({ id, method: "item/commandExecution/requestApproval", params: { threadId: "thread-A", command: "echo fixture" } });
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

test("invalid answers never send; one in-flight reply blocks duplicates until broker ack", async () => {
  const gate = deferred(); let sends = 0;
  const session = new InteractionSession({ sendResponse: () => { sends++; return gate.promise; } });
  session.setConnected(true); session.receive(request(0));
  await assert.rejects(session.submit(0, { decision: "acceptForSession" })); assert.equal(sends, 0);
  const pending = session.submit(0, { decision: "accept" });
  assert.equal(session.state(0), "submitting");
  await assert.rejects(session.submit(0, { decision: "decline" }), e => e.code === "INTERACTION_IN_PROGRESS");
  gate.resolve({}); await pending;
  assert.equal(sends, 1); assert.equal(session.requests.size, 0);
});

test("uncertain transport never recreates an actionable approval after reconnect", async () => {
  const session = new InteractionSession({ sendResponse: async () => { throw new Error("lost ack"); } });
  session.setConnected(true); session.receive(request(0));
  await assert.rejects(session.submit(0, { decision: "accept" }));
  assert.equal(session.state(0), "uncertain");
  session.setConnected(false); session.setConnected(true);
  session.reconcile({ epoch: "epoch-A", requests: [request(0)] });
  assert.equal(session.state(0), "uncertain");
  await assert.rejects(session.submit(0, { decision: "accept" }), e => e.code === "INTERACTION_UNCERTAIN");
});

test("authoritative native resolution during a failed reply never resurrects the card", async () => {
  const gate = deferred(); const session = new InteractionSession({ sendResponse: () => gate.promise });
  session.setConnected(true); session.receive(request(0));
  const pending = session.submit(0, { decision: "accept" }); session.resolve(0);
  gate.reject(new Error("late failure")); await assert.rejects(pending);
  assert.equal(session.requests.size, 0);
  session.receive(request(0)); assert.equal(session.requests.size, 0);
});

test("broker snapshots prune resolved requests and epochs allow legitimately reused IDs", () => {
  const session = new InteractionSession({ sendResponse: async () => ({}) });
  session.setConnected(true); session.reconcile({ epoch: "A", requests: [request(0)] });
  assert.equal(session.state(0), "pending");
  session.reconcile({ epoch: "A", requests: [] }); assert.equal(session.requests.size, 0);
  session.reconcile({ epoch: "A", requests: [request(0)] }); assert.equal(session.requests.size, 0);
  session.reconcile({ epoch: "B", requests: [request(0)] }); assert.equal(session.state(0), "pending");
});

test("old brokers cannot make stale pending approvals actionable after IPC loss", async () => {
  const session = new InteractionSession({ sendResponse: async () => ({}) });
  session.setConnected(true); session.receive(request(0)); session.setConnected(false); session.setConnected(true);
  assert.equal(session.state(0), "unverified");
  await assert.rejects(session.submit(0, { decision: "accept" }), e => e.code === "BRIDGE_UNAVAILABLE");
  session.receive(request(1)); assert.equal(session.state(1), "pending");
});
