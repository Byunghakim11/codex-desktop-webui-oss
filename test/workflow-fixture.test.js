import test from "node:test";
import assert from "node:assert/strict";
import { startInteractiveFixture } from "../test-support/interactive-fixture.js";
import { buildConversationSnapshot, prepareConversationText } from "../public/conversation-tools.js";
test("isolated workflow fixture loads two chats with ordinary and excluded native payloads", async t => {
  const fixture = await startInteractiveFixture({ workflowFixture: true }); t.after(() => fixture.close());
  const client = await fixture.connect();
  const list = await client.rpc("thread/list", {}); assert.equal(list.data.length, 2);
  const page = await client.rpc("thread/turns/list", { threadId: "thread-fixture", limit: 6 });
  assert.ok(page.data[0].items.some(item => item.type === "agentMessage" && item.text.includes("한국어")));
  assert.ok(page.data[0].items.some(item => item.delivery === "async"));
  const snapshot = buildConversationSnapshot({ threadKey: "thread-fixture", revision: 1, messages: page.data[0].items.map(item => ({ id: item.id, role: item.type === "userMessage" ? "user" : item.type === "agentMessage" ? "assistant" : "tool", text: item.text || item.content?.[0]?.text || "", delivery: item.delivery, phase: item.phase })) });
  const text = prepareConversationText(snapshot, { purpose: "markdown-export" }).text;
  assert.equal(snapshot.loadedMessageCount, 2);
  assert.ok(text.includes("console.log(value)"));
  assert.ok(text.includes("한국어")); assert.ok(!text.includes("NATIVE_EXCLUSION_SENTINEL"));
  client.close();
});
