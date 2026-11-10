import test from "node:test";
import assert from "node:assert/strict";
import { InteractionRegistry } from "../server/interaction-registry.js";

const approval = id => ({ id, method: "item/commandExecution/requestApproval", params: { threadId: "thread-A", command: "echo fixture" } });

test("registry snapshot replays human requests but never technical secrets", () => {
  const registry = new InteractionRegistry();
  registry.add(approval(0));
  registry.add({ id: 1, method: "account/chatgptAuthTokens/refresh", params: { secret: "do-not-share" } });
  registry.add({ id: 2, method: "mcpServer/elicitation/request", params: { threadId: "thread-A", mode: "openai/userVerification", challenge: "do-not-share" } });
  const snapshot = registry.snapshot();
  assert.equal(snapshot.length, 2);
  assert.equal(snapshot[0].id, 0);
  assert.equal(snapshot[1].desktopOnly, true);
  assert.doesNotMatch(JSON.stringify(snapshot), /do-not-share/);
});

test("invalid response never claims a pending request, and only one response wins", () => {
  const registry = new InteractionRegistry(); registry.add(approval(0));
  assert.throws(() => registry.claim(0, { decision: "acceptForSession" }));
  assert.equal(registry.snapshot().length, 1);
  assert.deepEqual(registry.claim(0, { decision: "accept" }), { decision: "accept" });
  assert.throws(() => registry.claim(0, { decision: "decline" }), error => error.code === "REQUEST_RESOLVED");
  assert.equal(registry.snapshot().length, 0);
});

test("native resolution removes pending state including ID zero and distinct string IDs", () => {
  const registry = new InteractionRegistry(); registry.add(approval(0)); registry.add(approval("0"));
  registry.resolve(0);
  assert.deepEqual(registry.snapshot().map(r => r.id), ["0"]);
  registry.resolve("0"); assert.equal(registry.snapshot().length, 0);
});

test("unsupported human requests cannot be claimed by the web", () => {
  const registry = new InteractionRegistry();
  registry.add({ id: 7, method: "mcpServer/elicitation/request", params: { threadId: "thread-A", mode: "openai/userVerification" } });
  assert.throws(() => registry.claim(7, { action: "accept", content: {} }));
  assert.equal(registry.snapshot().length, 1);
});

test("file previews correlate exact thread, turn and item before approval", () => {
  const registry = new InteractionRegistry();
  const request = { id: 8, method: "item/fileChange/requestApproval", params: { threadId: "A", turnId: "T", itemId: "I" } };
  registry.add(request);
  assert.equal(registry.get(8).desktopOnly, true);
  const update = { method: "item/fileChange/patchUpdated", params: { threadId: "B", turnId: "T", itemId: "I", changes: [{ path: "C:/project/a", kind: { type: "update" }, diff: "-old\n+new" }] } };
  assert.deepEqual(registry.observe(update), []);
  assert.equal(registry.get(8).desktopOnly, true);
  update.params.threadId = "A";
  assert.equal(registry.observe(update)[0].desktopOnly, undefined);
  assert.equal(registry.snapshot()[0].displayContext.fileChanges[0].diff, "-old\n+new");
  assert.deepEqual(registry.claim(8, { decision: "accept" }), { decision: "accept" });
});

test("changed or evicted file preview cannot silently approve different content", () => {
  const registry = new InteractionRegistry();
  let updates;
  const update = (itemId, diff) => ({ method: "item/fileChange/patchUpdated", params: { threadId: "A", turnId: "T", itemId, changes: [{ path: "C:/a", kind: { type: "update" }, diff }] } });
  for (let id = 0; id < 129; id++) {
    registry.observe(update(String(id), "initial"));
    updates = registry.add({ id, method: "item/fileChange/requestApproval", params: { threadId: "A", turnId: "T", itemId: String(id) } });
  }
  assert.equal(updates[0].id, 0);
  assert.equal(updates[0].desktopOnly, true);
  assert.equal(registry.get(0).desktopOnly, true);
  assert.throws(() => registry.claim(0, { decision: "accept" }));
  registry.observe(update("128", "changed"));
  assert.equal(registry.get(128).desktopOnly, true);
  assert.throws(() => registry.claim(128, { decision: "accept" }));
});
