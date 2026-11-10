import assert from "node:assert/strict";
import test from "node:test";
import { classifyInteractionRequest, interactionKey, validateInteractionResponse, approvalChoices, publicInteractionRequest, fileApprovalChanges } from "../public/interaction-contracts.js";

const request = (method, params = {}, id = 0) => ({ id, method, params: { threadId: "thread-A", turnId: "turn-A", ...params } });
const permissions = request("item/permissions/requestApproval", { permissions: { network: { enabled: true }, fileSystem: { read: ["C:/project/input"], write: ["C:/project/output"] } } });
const question = request("item/tool/requestUserInput", { isBlocking: false, questions: [{ id: "choice", header: "Choice", question: "Pick", isOther: true, options: [{ label: "A", description: "First" }] }] });
const form = request("mcpServer/elicitation/request", { mode: "form", serverName: "test", message: "Input", requestedSchema: { type: "object", properties: { name: { type: "string", minLength: 2, maxLength: 10 }, count: { type: "integer", minimum: 1, maximum: 5 }, ready: { type: "boolean" } }, required: ["name", "ready"], additionalProperties: false } });

test("request identity accepts numeric zero and distinguishes string IDs", () => {
  assert.notEqual(interactionKey(0), interactionKey("0"));
  assert.throws(() => interactionKey(null));
  assert.throws(() => interactionKey({}));
});

test("classifies supported human requests and retains technical ownership", () => {
  for (const value of [permissions, question, form]) assert.equal(classifyInteractionRequest(value).support, "web");
  for (const method of ["attestation/generate", "account/chatgptAuthTokens/refresh", "item/tool/call", "currentTime/read"]) {
    assert.equal(classifyInteractionRequest(request(method)).support, "ignore");
  }
  assert.equal(classifyInteractionRequest(request("mcpServer/elicitation/request", { mode: "openai/userVerification", challenge: "private" })).support, "desktop");
});

test("modern and legacy decisions follow their actual wire contracts", () => {
  const modern = request("item/commandExecution/requestApproval", { command: "echo fixture", availableDecisions: ["accept", "decline"] });
  assert.deepEqual(validateInteractionResponse(modern, { decision: "accept" }), { decision: "accept" });
  assert.throws(() => validateInteractionResponse(modern, { decision: "acceptForSession" }));
  assert.throws(() => validateInteractionResponse(modern, { decision: "accept", permissions: {} }));
  const legacy = request("execCommandApproval", { command: ["echo", "fixture"] });
  assert.equal(approvalChoices(legacy)[0].result.decision, "approved");
  assert.deepEqual(validateInteractionResponse(legacy, { decision: { denied: { rejection: "No" } } }), { decision: { denied: { rejection: "No" } } });
  assert.throws(() => validateInteractionResponse(legacy, { decision: "accept" }));
});

test("file approval needs a complete preview and never grants a session root", () => {
  const modern = request("item/fileChange/requestApproval", { itemId: "file-I" });
  assert.equal(classifyInteractionRequest(modern).support, "desktop");
  const preview = { ...modern, displayContext: { fileChanges: [{ path: "C:/project/a.txt", kind: "update", diff: "-old\n+new", movePath: null }] } };
  assert.equal(classifyInteractionRequest(preview).support, "web");
  const rootGrant = { ...preview, params: { ...preview.params, grantRoot: "C:/" } };
  assert.equal(classifyInteractionRequest(rootGrant).support, "desktop");
  assert.throws(() => validateInteractionResponse(rootGrant, { decision: "accept" }));
  const legacy = request("applyPatchApproval", { fileChanges: { "C:/project/a.txt": { type: "update", unified_diff: "-old\n+new", move_path: "C:/project/b.txt" } } });
  assert.deepEqual(fileApprovalChanges(legacy), [{ path: "C:/project/a.txt", kind: "update", diff: "-old\n+new", movePath: "C:/project/b.txt" }]);
  assert.equal(classifyInteractionRequest(legacy).support, "web");
  assert.equal(classifyInteractionRequest({ ...legacy, params: { ...legacy.params, grantRoot: "C:/" } }).support, "desktop");
});

test("command approval requires visible context and supported command kind", () => {
  assert.equal(classifyInteractionRequest(request("item/commandExecution/requestApproval")).support, "desktop");
  const network = request("item/commandExecution/requestApproval", { command: null, networkApprovalContext: { host: "example.test", protocol: "https" } });
  assert.equal(classifyInteractionRequest(network).support, "web");
  assert.equal(classifyInteractionRequest({ ...network, params: { ...network.params, kind: "writeStdin" } }).support, "desktop");
  assert.equal(classifyInteractionRequest(request(network.method, { command: "echo fixture", additionalPermissions: { fileSystem: { entries: [{ access: "write", path: { type: "special", value: { kind: "root" } } }] } } })).support, "desktop");
});

test("permissions grant only exact requested subsets with turn scope", () => {
  assert.deepEqual(validateInteractionResponse(permissions, { permissions: {}, scope: "turn" }), { permissions: {}, scope: "turn" });
  assert.deepEqual(validateInteractionResponse(permissions, { permissions: { fileSystem: { read: ["C:/project/input"] } }, scope: "turn" }), { permissions: { fileSystem: { read: ["C:/project/input"] } }, scope: "turn" });
  for (const result of [
    { permissions: { fileSystem: { write: ["C:/private"] } } },
    { permissions: { fileSystem: { read: ["C:/project/input"], newRule: true } } },
    { permissions: {}, scope: "session" },
    { permissions: {}, strictAutoReview: false },
    { permissions: {}, injected: true }
  ]) assert.throws(() => validateInteractionResponse(permissions, result));
  const noNetwork = request("item/permissions/requestApproval", { permissions: { fileSystem: { read: ["C:/x"] } } });
  assert.throws(() => validateInteractionResponse(noNetwork, { permissions: { network: { enabled: true } } }));
});

test("filesystem special/glob grants stay Desktop-only until supported safely", () => {
  const special = request("item/permissions/requestApproval", { permissions: { fileSystem: { entries: [{ access: "write", path: { type: "special", value: { kind: "root" } } }] } } });
  assert.equal(classifyInteractionRequest(special).support, "desktop");
  assert.throws(() => validateInteractionResponse(special, { permissions: special.params.permissions }));
});

test("questions validate IDs, Other, choices and bounded answers", () => {
  assert.deepEqual(validateInteractionResponse(question, { answers: { choice: { answers: ["Custom"] } } }), { answers: { choice: { answers: ["Custom"] } } });
  const fixed = structuredClone(question); fixed.params.questions[0].isOther = false;
  assert.throws(() => validateInteractionResponse(fixed, { answers: { choice: { answers: ["Custom"] } } }));
  assert.throws(() => validateInteractionResponse(question, { answers: { unknown: { answers: ["A"] } } }));
  assert.throws(() => validateInteractionResponse(question, { answers: { choice: { answers: ["x".repeat(17000)] } } }));
  assert.deepEqual(validateInteractionResponse(question, { answers: {} }), { answers: {} });
});

test("typed MCP form validation rejects coercion, unknown fields, enums and missing required", () => {
  assert.deepEqual(validateInteractionResponse(form, { action: "accept", content: { name: "Name", count: 3, ready: false } }), { action: "accept", content: { name: "Name", count: 3, ready: false } });
  for (const content of [{ name: "x", ready: true }, { name: "Name" }, { name: "Name", count: "3", ready: true }, { name: "Name", count: 6, ready: true }, { name: "Name", ready: true, injected: "x" }]) {
    assert.throws(() => validateInteractionResponse(form, { action: "accept", content }));
  }
  assert.deepEqual(validateInteractionResponse(form, { action: "cancel", content: null }), { action: "cancel", content: null });
  assert.throws(() => validateInteractionResponse(form, { action: "decline", content: { name: "leak" } }));
});

test("unsupported MCP schemas and unsafe URLs do not become fake web forms", () => {
  for (const requestedSchema of [
    { type: "object", properties: { x: { $ref: "https://untrusted.test/schema" } } },
    { type: "object", properties: { x: { type: "string", pattern: "(a+)+$" } } },
    { type: "object", properties: { nested: { type: "object" } } }
  ]) assert.equal(classifyInteractionRequest(request(form.method, { ...form.params, requestedSchema })).support, "desktop");
  const url = request(form.method, { mode: "url", serverName: "test", message: "Sign in", elicitationId: "flow", url: "https://example.test/login" });
  assert.equal(classifyInteractionRequest(url).support, "web");
  assert.deepEqual(validateInteractionResponse(url, { action: "accept", content: null }), { action: "accept", content: null });
  for (const bad of ["javascript:alert(1)", "http://example.test", "https://user:password@example.test", "https://localhost/login", "https://example.test/login?redirect_uri=http%3A%2F%2F127.0.0.1%3A1455%2Fcallback", "https://example.test/login?redirect_uri=codex%3A%2F%2Fcallback"]) {
    assert.equal(classifyInteractionRequest({ ...url, params: { ...url.params, url: bad } }).support, "desktop");
  }
});

test("malformed request identity/context and incomplete MCP flows cannot be answered", () => {
  assert.equal(publicInteractionRequest({ id: null, method: question.method, params: question.params }), null);
  assert.equal(classifyInteractionRequest({ ...question, params: { questions: question.params.questions } }).support, "desktop");
  assert.equal(classifyInteractionRequest(request(form.method, { mode: "url", url: "https://example.test", message: "Missing flow id", serverName: "fixture" })).support, "desktop");
});
