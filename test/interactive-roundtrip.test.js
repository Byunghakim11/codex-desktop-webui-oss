import test from "node:test";
import assert from "node:assert/strict";
import { startInteractiveFixture } from "../test-support/interactive-fixture.js";

test("web questions, permissions, MCP forms and declines round-trip through the shared broker", { timeout: 45000 }, async t => {
  const fixture = await startInteractiveFixture(); t.after(() => fixture.close());
  const browser = await fixture.connect(); t.after(() => browser.close());
  const questions = [{ id: "q", header: "Question", question: "Choose", isOther: true, options: [{ label: "A", description: "First" }] }];
  await fixture.trigger({ id: 0, method: "item/tool/requestUserInput", params: { questions, isBlocking: false } });
  assert.equal((await browser.next(m => m.type === "server-request" && m.request.id === 0)).request.params.questions[0].isOther, true);
  const answer = { answers: { q: { answers: ["Custom fixture answer"] } } };
  await browser.respond(0, answer);
  assert.deepEqual((await fixture.nextResponse(0)).result, answer);

  const permissions = { network: { enabled: true }, fileSystem: { read: [fixture.rootDir] } };
  await fixture.trigger({ id: 10, method: "item/permissions/requestApproval", params: { permissions, cwd: fixture.rootDir } });
  await browser.next(m => m.type === "server-request" && m.request.id === 10);
  const forged = await browser.respond(10, { permissions: { fileSystem: { write: ["C:/outside"] } } }, true);
  assert.equal(forged.code, "INVALID_INTERACTION_RESPONSE");
  await browser.respond(10, { permissions: {}, scope: "turn" });
  assert.deepEqual((await fixture.nextResponse(10)).result.permissions, {});

  await fixture.trigger({ id: 11, method: "item/commandExecution/requestApproval", params: { command: "echo SYNTHETIC", availableDecisions: ["accept", "decline"] } });
  await browser.next(m => m.type === "server-request" && m.request.id === 11);
  await browser.respond(11, { decision: "decline" });
  assert.equal((await fixture.nextResponse(11)).result.decision, "decline");

  await fixture.trigger({ id: 12, method: "mcpServer/elicitation/request", params: { serverName: "fixture", mode: "form", message: "Synthetic form", requestedSchema: { type: "object", properties: { ready: { type: "boolean" } }, required: ["ready"], additionalProperties: false } } });
  await browser.next(m => m.type === "server-request" && m.request.id === 12);
  await browser.respond(12, { action: "accept", content: { ready: false } });
  assert.deepEqual((await fixture.nextResponse(12)).result, { action: "accept", content: { ready: false } });
});

test("pending approvals survive WebUI restart; Desktop wins once and sensitive fallback stays private", { timeout: 45000 }, async t => {
  const fixture = await startInteractiveFixture(); t.after(() => fixture.close());
  let browser = await fixture.connect();
  await fixture.trigger({ id: 20, method: "item/commandExecution/requestApproval", params: { command: "echo SYNTHETIC" } });
  await browser.next(m => m.type === "server-request" && m.request.id === 20); browser.close();
  await fixture.restartWebUi(); browser = await fixture.connect(); t.after(() => browser.close());
  assert.equal(browser.hello.interactionsAuthoritative, true);
  assert.ok(browser.hello.pendingServerRequests.some(r => r.id === 20));
  fixture.respondNative(20, { decision: "decline" });
  await browser.next(m => m.type === "server-request-resolved" && m.id === 20);
  const duplicate = await browser.respond(20, { decision: "accept" }, true);
  assert.equal(duplicate.code, "REQUEST_RESOLVED");
  await fixture.trigger({ id: 21, method: "mcpServer/elicitation/request", params: { mode: "openai/userVerification", serverName: "fixture", challenge: "DO_NOT_DISCLOSE_CHALLENGE" } });
  const fallback = await browser.next(m => m.type === "server-request" && m.request.id === 21);
  assert.equal(fallback.request.desktopOnly, true);
  assert.doesNotMatch(JSON.stringify(fallback), /DO_NOT_DISCLOSE_CHALLENGE/);
  assert.equal((await browser.respond(21, { action: "accept" }, true)).code, "REQUEST_RESOLVED");
});

test("folder-scoped clients cannot widen filesystem permissions", { timeout: 45000 }, async t => {
  const fixture = await startInteractiveFixture(); t.after(() => fixture.close());
  const browser = await fixture.connect(fixture.folderToken); t.after(() => browser.close());
  await browser.rpc("thread/read", { threadId: "thread-fixture", includeTurns: false });
  await fixture.trigger({ id: 30, method: "item/permissions/requestApproval", params: { permissions: { fileSystem: { read: [fixture.rootDir] } } } });
  const fallback = await browser.next(m => m.type === "server-request" && m.request.id === 30);
  assert.equal(fallback.request.desktopOnly, true);
  assert.equal((await browser.respond(30, { permissions: { fileSystem: { read: [fixture.rootDir] } } }, true)).code, "REQUEST_RESOLVED");
  await fixture.trigger({ id: 31, method: "item/commandExecution/requestApproval", params: { command: "echo SYNTHETIC", additionalPermissions: { fileSystem: { write: ["C:/outside"] } } } });
  assert.equal((await browser.next(m => m.type === "server-request" && m.request.id === 31)).request.desktopOnly, true);
  assert.equal((await browser.respond(31, { decision: "accept" }, true)).code, "REQUEST_RESOLVED");
});

test("file approvals expose correlated complete changes and reject session grants", { timeout: 45000 }, async t => {
  const fixture = await startInteractiveFixture(); t.after(() => fixture.close());
  const browser = await fixture.connect(); t.after(() => browser.close());
  const p = { threadId: "thread-fixture", turnId: "T", itemId: "I" };
  await fixture.trigger({ id: 40, method: "item/fileChange/requestApproval", params: p });
  assert.equal((await browser.next(m => m.type === "server-request" && m.request.id === 40)).request.desktopOnly, true);
  assert.equal((await browser.respond(40, { decision: "accept" }, true)).code, "REQUEST_RESOLVED");
  await fixture.notify("item/fileChange/patchUpdated", { ...p, changes: [{ path: "C:/fixture/a", kind: { type: "update" }, diff: "-old\n+new" }] });
  const updated = await browser.next(m => m.type === "server-request" && m.request.id === 40 && m.request.displayContext);
  assert.equal(updated.request.displayContext.fileChanges[0].diff, "-old\n+new");
  await browser.respond(40, { decision: "accept" });
  assert.equal((await fixture.nextResponse(40)).result.decision, "accept");
  for (const [id, method, params] of [[41, "item/fileChange/requestApproval", p], [42, "applyPatchApproval", { fileChanges: { "C:/fixture/a": { type: "add", content: "fixture" } } }]]) {
    await fixture.trigger({ id, method, params: { ...params, grantRoot: "C:/" } });
    assert.equal((await browser.next(m => m.type === "server-request" && m.request.id === id)).request.desktopOnly, true);
    assert.equal((await browser.respond(id, { decision: method === "applyPatchApproval" ? "approved" : "accept" }, true)).code, "REQUEST_RESOLVED");
  }
});
