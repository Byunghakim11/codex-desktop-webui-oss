import test from "node:test";
import assert from "node:assert/strict";
import {
  ACTION_DEFINITIONS,
  NATIVE_CAPABILITIES,
  callCodexAppTool,
  describeActions,
  digest,
  getActionDefinition,
  parseGoalResult,
  parseToolResult,
  validateGoalSetParams,
  validateHeartbeatCreateParams,
  validateHeartbeatIdParams,
  validateHeartbeatUpdateParams,
  validatePinParams,
  validateRequestId,
  NativeActionError
} from "../server/native-capabilities.js";

const goal = {
  objective: "Verify contracts",
  status: "active",
  tokenBudget: 50000,
  origin: "user",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:05:00.000Z",
  usage: { tokensUsed: 1234, timeUsedSeconds: 55 },
  hiddenPath: "C:\\secret\\project",
  credentials: { token: "nope" }
};

test("parseGoalResult allowlists fields and keeps usage out of the state version", () => {
  const first = parseGoalResult({ goal });
  assert.deepEqual(first.goal, {
    objective: "Verify contracts",
    status: "active",
    tokenBudget: 50000,
    origin: "user",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:05:00.000Z",
    usage: { tokensUsed: 1234, timeUsedSeconds: 55 }
  });
  assert.match(first.version, /^[0-9a-f]{64}$/);
  const changedUsage = parseGoalResult({ goal: { ...goal, usage: { tokensUsed: 999999 } } });
  assert.equal(changedUsage.version, first.version);
  const changedObjective = parseGoalResult({ goal: { ...goal, objective: "different" } });
  assert.notEqual(changedObjective.version, first.version);
  const cleared = parseGoalResult({ goal: null });
  assert.equal(cleared.goal, null);
  assert.equal(cleared.version, "none");
  assert.deepEqual(parseGoalResult(null), { goal: null, version: "none" });
});

test("parseGoalResult fails closed on unknown status, bad budget and oversized objective", () => {
  assert.throws(() => parseGoalResult({ goal: { ...goal, status: "unknown" } }), error => error.status === 502);
  assert.throws(() => parseGoalResult({ goal: { ...goal, tokenBudget: Number.MAX_SAFE_INTEGER + 1 } }), error => error.status === 502);
  assert.throws(() => parseGoalResult({ goal: { ...goal, objective: "x".repeat(4001) } }), error => error.status === 502);
  assert.throws(() => parseGoalResult("raw"), error => error.status === 502);
  assert.equal(parseGoalResult({ goal: { ...goal, objective: "x".repeat(4000) } }).goal.objective.length, 4000);
});

test("goal params accept only the documented editable fields", () => {
  assert.deepEqual(validateGoalSetParams({ status: "complete", expectedVersion: "none" }), { status: "complete", expectedVersion: "none" });
  assert.deepEqual(validateGoalSetParams({ tokenBudget: null }), { tokenBudget: null });
  assert.equal(validateGoalSetParams({ objective: "  keep spaces  " }).objective, "  keep spaces  ");
  for (const params of [
    {},
    { objective: "" },
    { objective: 5 },
    { status: "blocked" },
    { status: "active", origin: "user" },
    { tokenBudget: 0 },
    { tokenBudget: 1.5 },
    { tokenBudget: "5" },
    { expectedVersion: "bad" },
    { threadId: "thread-1" },
    { hostId: "host-1" },
    { server: "codex_app" },
    { tool: "automation_update" },
    { _meta: {} }
  ]) {
    assert.throws(() => validateGoalSetParams(params), error => error.status === 400, JSON.stringify(params));
  }
  assert.deepEqual(validatePinParams({}), {});
  assert.throws(() => validatePinParams({ sectionId: "pinned" }), error => error.status === 400);
});

test("heartbeat validators bound untrusted text, intervals and ids", () => {
  assert.deepEqual(
    validateHeartbeatCreateParams({ name: "Check build", prompt: "Summarize failures", intervalMinutes: 30, notificationPolicy: "failed_runs_only" }),
    { name: "Check build", prompt: "Summarize failures", intervalMinutes: 30, notificationPolicy: "failed_runs_only" }
  );
  for (const params of [
    { name: "", prompt: "x", intervalMinutes: 5 },
    { name: "   ", prompt: "x", intervalMinutes: 5 },
    { name: "n", prompt: "", intervalMinutes: 5 },
    { name: "n", prompt: "p", intervalMinutes: 0 },
    { name: "n", prompt: "p", intervalMinutes: 1441 },
    { name: "n", prompt: "p", intervalMinutes: 1.5 },
    { name: "n", prompt: "p", intervalMinutes: 5, status: "active" },
    { name: "n", prompt: "p", intervalMinutes: 5, notificationPolicy: "all" },
    { name: "n", prompt: "p", intervalMinutes: 5, targetThreadId: "thread-2" },
    { name: "n", prompt: "p", intervalMinutes: 5, rrule: "FREQ=MINUTELY;INTERVAL=5" },
    { name: "x".repeat(201), prompt: "p", intervalMinutes: 5 }
  ]) {
    assert.throws(() => validateHeartbeatCreateParams(params), error => error.status === 400, JSON.stringify(params));
  }
  assert.deepEqual(validateHeartbeatIdParams({ id: "auto-1" }), { id: "auto-1" });
  for (const id of ["", "../escape", "a/b", "a\\b", "x".repeat(201)]) {
    assert.throws(() => validateHeartbeatIdParams({ id }), error => error.status === 400);
  }
  assert.deepEqual(validateHeartbeatUpdateParams({ id: "auto-1", status: "PAUSED" }), { id: "auto-1", status: "PAUSED" });
  assert.throws(() => validateHeartbeatUpdateParams({ id: "auto-1" }), error => error.status === 400);
  assert.equal(validateRequestId("req-1"), "req-1");
  assert.throws(() => validateRequestId(""), error => error.status === 400);
});

test("MCP tool calls hardcode the codex_app server and allowlisted tool names", async () => {
  const calls = [];
  const callNative = async (method, params) => { calls.push({ method, params }); return { isError: false, content: [{ type: "text", text: "{\"ok\":true}" }] }; };
  await callCodexAppTool({
    callNative,
    threadId: "thread-1",
    tool: "move_thread_to_sidebar_section",
    arguments: { source: "codex", threadId: "thread-1", sectionId: "pinned" }
  });
  assert.deepEqual(calls, [{
    method: "mcpServer/tool/call",
    params: {
      server: "codex_app",
      threadId: "thread-1",
      tool: "move_thread_to_sidebar_section",
      arguments: { source: "codex", threadId: "thread-1", sectionId: "pinned" }
    }
  }]);
  assert.throws(() => callCodexAppTool({ callNative, threadId: "t", tool: "delete_thread", arguments: {} }), error => error.code === "TOOL_NOT_ALLOWED");
  assert.throws(() => callCodexAppTool({ callNative, threadId: "t", tool: "list_threads" }), error => error.code === "INVALID_ARGUMENTS");
});

test("MCP results are parsed strictly and typed failures never expose raw text", () => {
  assert.deepEqual(parseToolResult({ isError: false, content: [{ type: "text", text: "{\"a\":1}" }] }), { json: { a: 1 }, text: "{\"a\":1}" });
  assert.equal(parseToolResult({ isError: false, content: [{ type: "text", text: "Moved" }] }).json, null);
  assert.throws(() => parseToolResult({ isError: true, content: [] }), error => error.status === 502 && error.code === "NATIVE_TOOL_ERROR");
  assert.throws(() => parseToolResult({ content: [] }), error => error.status === 502);
  assert.throws(() => parseToolResult({ isError: false, content: [] }), error => error.status === 502);
  assert.throws(() => parseToolResult({ isError: false, content: [{ type: "image", data: "raw" }] }), error => error.status === 502);
  assert.throws(() => parseToolResult(null), error => error.status === 502);
});

test("the action registry is static, per-action validated and has no RPC passthrough", () => {
  const ids = ACTION_DEFINITIONS.map(definition => definition.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const definition of ACTION_DEFINITIONS) {
    assert.equal(typeof definition.validate, "function", definition.id);
    assert.equal(typeof definition.mutating, "boolean");
    assert.equal(typeof definition.destructive, "boolean");
    assert.equal(typeof definition.requiresConfirmation, "boolean");
  }
  assert.equal(getActionDefinition("execute"), null);
  assert.equal(getActionDefinition("mcpServer/tool/call"), null);
  assert.equal(getActionDefinition("__proto__"), null);
  assert.equal(getActionDefinition("goal.clear").requiresConfirmation, true);
  assert.equal(getActionDefinition("heartbeat.delete").requiresConfirmation, true);
  assert.equal(getActionDefinition("thread.pin").requiresConfirmation, false);
  assert.equal(getActionDefinition("goal.get").mutating, false);

  const described = describeActions();
  assert.equal(described.some(action => Object.hasOwn(action, "validate")), false);
  const text = JSON.stringify(described);
  assert.equal(text.includes("FREQ="), false);
  assert.equal(text.includes("prompt"), false);
  assert.equal(NATIVE_CAPABILITIES.unsupported.includes("loop-scheduler"), true);
});

test("digest is canonical and stable", () => {
  assert.equal(digest({ b: 1, a: [2, 3] }), digest({ a: [2, 3], b: 1 }));
  assert.notEqual(digest({ a: 1 }), digest({ a: 2 }));
  assert.throws(() => digest({ a: Number.NaN }), error => error instanceof NativeActionError);
});
