import assert from "node:assert/strict";
import test from "node:test";
import { InteractionViewState } from "../public/interactive-requests.js";

const request = id => ({ id, method: "item/tool/requestUserInput", params: { threadId: "A", questions: [{ id: "q", question: "Fixture", isSecret: true }] } });

test("view supports ID zero, no duplicate submit, and never retains secret answers", () => {
  const state = new InteractionViewState(); state.connected = true; state.ingest(request(0));
  const result = state.begin(0, { answers: { q: { answers: ["temporary-private-answer"] } } });
  assert.equal(result.answers.q.answers[0], "temporary-private-answer");
  assert.equal(state.entries.values().next().value.status, "submitting");
  assert.doesNotMatch(JSON.stringify([...state.entries.values()]), /temporary-private-answer/);
  assert.throws(() => state.begin(0, { answers: {} }));
  state.fail(0, Object.assign(new Error(), { code: "INTERACTION_UNCERTAIN" }));
  state.reconcile([request(0)], { connected: true, authoritative: true, epoch: "A" });
  assert.equal(state.entries.values().next().value.status, "uncertain");
});

test("resolved events win over delayed failures and replayed snapshots", () => {
  const state = new InteractionViewState(); state.connected = true; state.ingest(request(0));
  state.begin(0, { answers: {} }); state.resolve(0); state.fail(0, new Error("late"));
  state.reconcile([request(0)], { authoritative: true, connected: true, epoch: "A" });
  assert.equal(state.entries.size, 0);
  state.reconcile([request(0)], { authoritative: true, connected: true, epoch: "B" });
  assert.equal(state.entries.size, 1);
});

test("disconnect and a non-authoritative snapshot cannot re-arm stale requests", () => {
  const state = new InteractionViewState(); state.connected = true; state.ingest(request(0));
  state.setConnected(false); state.setConnected(true);
  state.reconcile([], { authoritative: false, connected: true });
  assert.equal(state.entries.values().next().value.status, "unverified");
  state.reconcile([request(0)], { authoritative: true, connected: true, epoch: "A" });
  assert.equal(state.entries.values().next().value.status, "pending");
});
