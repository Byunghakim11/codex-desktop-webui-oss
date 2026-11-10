import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createNativeActionsService, NativeActionError } from "../server/native-actions.js";

const THREAD_ID = "thread-1";
const OTHER_THREAD_ID = "thread-2";
const OBJECTIVE = "Keep the native foundation green";
const SCOPE = { id: "scope-1", authMode: "token", tokenHash: "a".repeat(64) };
const THREAD = { id: THREAD_ID, cwd: "C:\\work\\project" };

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "native-actions-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return dir;
}

function goalFixture(overrides = {}) {
  return {
    objective: OBJECTIVE,
    status: "active",
    tokenBudget: 100000,
    origin: "user",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    usage: { tokensUsed: 1000, timeUsedSeconds: 60 },
    ...overrides
  };
}

const clone = value => JSON.parse(JSON.stringify(value));

function fakeNative({ goal = goalFixture(), tools = {} } = {}) {
  const calls = [];
  const state = { goal: goal ? clone(goal) : null };
  async function callNative(method, params) {
    calls.push({ method, params: clone(params) });
    if (method === "thread/goal/get") return { goal: state.goal ? clone(state.goal) : null };
    if (method === "thread/goal/set") {
      if (!state.goal) state.goal = { objective: null, status: "active", tokenBudget: null, createdAt: null, usage: {} };
      if (params.objective !== undefined) {
        state.goal.objective = params.objective;
        state.goal.usage = { tokensUsed: 0, timeUsedSeconds: 0 };
      }
      if (params.status !== undefined) state.goal.status = params.status;
      if (Object.hasOwn(params, "tokenBudget")) state.goal.tokenBudget = params.tokenBudget;
      if (params.origin) state.goal.origin = params.origin;
      return { goal: clone(state.goal) };
    }
    if (method === "thread/goal/clear") {
      state.goal = null;
      return {};
    }
    if (method === "mcpServer/tool/call") {
      const handler = tools[params.tool];
      if (!handler) throw new Error("unexpected mcp tool");
      return handler(params);
    }
    throw Object.assign(new Error("method not found"), { code: "-32601" });
  }
  return { call: callNative, calls, state };
}

async function serviceFor(t, { native = fakeNative(), authorize, dataDir } = {}) {
  const dir = dataDir || await tempDir(t);
  const service = createNativeActionsService({
    callNative: native.call,
    authorizeThread: authorize || (async (scope, threadId) => (threadId === THREAD_ID ? THREAD : null)),
    dataDir: dir
  });
  return { service, native, dir };
}

const setCalls = native => native.calls.filter(call => call.method === "thread/goal/set");

test("getGoal exposes allowlisted goal fields and a usage-independent version", async t => {
  const { service, native } = await serviceFor(t);
  const first = await service.getGoal(SCOPE, { threadId: THREAD_ID });
  assert.equal(first.ok, true);
  assert.equal(first.threadId, THREAD_ID);
  assert.equal(first.goal.objective, OBJECTIVE);
  assert.equal(first.goal.status, "active");
  assert.equal(first.goal.tokenBudget, 100000);
  assert.deepEqual(first.goal.usage, { tokensUsed: 1000, timeUsedSeconds: 60 });
  assert.equal(first.goal.origin, "user");
  assert.match(first.version, /^(?:none|[0-9a-f]{64})$/);

  native.state.goal.usage.tokensUsed = 999999;
  const second = await service.getGoal(SCOPE, { threadId: THREAD_ID });
  assert.equal(second.version, first.version);
  assert.equal(second.goal.usage.tokensUsed, 999999);
});

test("goal.set sends origin user and preserves native usage when the objective is unchanged", async t => {
  const { service, native } = await serviceFor(t);
  const current = await service.getGoal(SCOPE, { threadId: THREAD_ID });
  const result = await service.execute(SCOPE, {
    action: "goal.set",
    threadId: THREAD_ID,
    params: { status: "paused", expectedVersion: current.version }
  });
  assert.equal(result.ok, true);
  assert.equal(result.usageReset, false);
  assert.equal(result.goal.objective, OBJECTIVE);
  assert.equal(result.goal.status, "paused");
  assert.deepEqual(result.goal.usage, { tokensUsed: 1000, timeUsedSeconds: 60 });
  const [call] = setCalls(native);
  assert.deepEqual(call.params, { threadId: THREAD_ID, status: "paused", origin: "user" });
});

test("goal.set omits an unchanged objective and explicit tokenBudget null is forwarded", async t => {
  const { service, native } = await serviceFor(t);
  const current = await service.getGoal(SCOPE, { threadId: THREAD_ID });
  const result = await service.execute(SCOPE, {
    action: "goal.set",
    threadId: THREAD_ID,
    params: { objective: OBJECTIVE, tokenBudget: null, expectedVersion: current.version }
  });
  assert.equal(result.changed, true);
  assert.equal(result.usageReset, false);
  const [call] = setCalls(native);
  assert.deepEqual(call.params, { threadId: THREAD_ID, tokenBudget: null, origin: "user" });
  assert.equal(result.goal.tokenBudget, null);
});

test("goal.set rejects invalid objective, read-only status and unsafe token budgets", async t => {
  const { service, native } = await serviceFor(t);
  const current = await service.getGoal(SCOPE, { threadId: THREAD_ID });
  const version = current.version;
  const cases = [
    { objective: "" },
    { objective: "x".repeat(4001) },
    { status: "blocked" },
    { status: "budgetLimited" },
    { tokenBudget: 0 },
    { tokenBudget: -5 },
    { tokenBudget: 1.5 },
    { tokenBudget: Number.MAX_SAFE_INTEGER + 1 },
    { tokenBudget: "100" },
    { origin: "user" },
    { expectedVersion: "stale" }
  ];
  for (const extra of cases) {
    await assert.rejects(
      service.execute(SCOPE, { action: "goal.set", threadId: THREAD_ID, params: { status: "paused", expectedVersion: version, ...extra } }),
      error => error instanceof NativeActionError && error.status === 400
    );
  }
  assert.deepEqual(setCalls(native), []);
});

test("goal.set rejects stale or missing versions without a native mutation", async t => {
  const { service, native } = await serviceFor(t);
  await assert.rejects(
    service.execute(SCOPE, { action: "goal.set", threadId: THREAD_ID, params: { status: "paused" } }),
    error => error.status === 409 && error.code === "STALE_GOAL"
  );
  await assert.rejects(
    service.execute(SCOPE, { action: "goal.set", threadId: THREAD_ID, params: { status: "paused", expectedVersion: "none" } }),
    error => error.status === 409 && error.code === "STALE_GOAL"
  );
  native.state.goal.objective = "changed elsewhere";
  await assert.rejects(
    service.execute(SCOPE, { action: "goal.set", threadId: THREAD_ID, params: { status: "paused", expectedVersion: "a".repeat(64) } }),
    error => error.status === 409
  );
  assert.deepEqual(setCalls(native), []);
});

test("pause and resume send status only, keeping objective, budget and usage untouched", async t => {
  const { service, native } = await serviceFor(t);
  const current = await service.getGoal(SCOPE, { threadId: THREAD_ID });
  const paused = await service.execute(SCOPE, {
    action: "goal.pause",
    threadId: THREAD_ID,
    params: { expectedVersion: current.version }
  });
  assert.equal(paused.changed, true);
  assert.deepEqual(setCalls(native).at(-1).params, { threadId: THREAD_ID, status: "paused", origin: "user" });
  assert.equal(paused.goal.objective, OBJECTIVE);
  assert.equal(paused.goal.tokenBudget, 100000);
  assert.deepEqual(paused.goal.usage, { tokensUsed: 1000, timeUsedSeconds: 60 });

  const resumed = await service.execute(SCOPE, {
    action: "goal.resume",
    threadId: THREAD_ID,
    params: { expectedVersion: paused.version }
  });
  assert.equal(resumed.goal.status, "active");
  assert.deepEqual(setCalls(native).at(-1).params, { threadId: THREAD_ID, status: "active", origin: "user" });
});

test("goal.clear requires a single-use confirmation bound to the current state", async t => {
  const { service, native } = await serviceFor(t);
  await assert.rejects(
    service.execute(SCOPE, { action: "goal.clear", threadId: THREAD_ID, params: {} }),
    error => error.status === 400 && error.code === "CONFIRMATION_REQUIRED"
  );
  assert.equal(native.calls.some(call => call.method === "thread/goal/clear"), false);

  const prepared = await service.prepareConfirmation(SCOPE, { action: "goal.clear", threadId: THREAD_ID, params: {} });
  assert.match(prepared.confirmationId, /^[0-9a-f]{32}$/);
  const cleared = await service.execute(SCOPE, {
    action: "goal.clear",
    threadId: THREAD_ID,
    params: {},
    confirmationId: prepared.confirmationId
  });
  assert.equal(cleared.cleared, true);
  assert.equal(cleared.goal, null);
  assert.equal(native.calls.some(call => call.method === "thread/goal/clear"), true);

  await assert.rejects(
    service.execute(SCOPE, { action: "goal.clear", threadId: THREAD_ID, params: {}, confirmationId: prepared.confirmationId }),
    error => error.status === 409 && error.code === "CONFIRMATION_REPLAY"
  );
});

test("goal.clear confirmation rejects a changed goal but ignores usage-only changes", async t => {
  const { service, native } = await serviceFor(t);
  const prepared = await service.prepareConfirmation(SCOPE, { action: "goal.clear", threadId: THREAD_ID, params: {} });
  native.state.goal.usage.tokensUsed += 500;
  const ok = await service.execute(SCOPE, { action: "goal.clear", threadId: THREAD_ID, params: {}, confirmationId: prepared.confirmationId });
  assert.equal(ok.cleared, true);

  native.state.goal = goalFixture();
  const second = await service.prepareConfirmation(SCOPE, { action: "goal.clear", threadId: THREAD_ID, params: {} });
  native.state.goal.objective = "A different objective";
  await assert.rejects(
    service.execute(SCOPE, { action: "goal.clear", threadId: THREAD_ID, params: {}, confirmationId: second.confirmationId }),
    error => error.status === 409 && error.code === "CONFIRMATION_STALE"
  );
  assert.equal(native.calls.filter(call => call.method === "thread/goal/clear").length, 1);
});

test("marking a goal complete also requires a bound single-use confirmation", async t => {
  const { service, native } = await serviceFor(t);
  const current = await service.getGoal(SCOPE, { threadId: THREAD_ID });
  const params = { status: "complete", expectedVersion: current.version };
  await assert.rejects(
    service.execute(SCOPE, { action: "goal.set", threadId: THREAD_ID, params }),
    error => error.status === 400 && error.code === "CONFIRMATION_REQUIRED"
  );
  assert.deepEqual(setCalls(native), []);
  await assert.rejects(
    service.prepareConfirmation(SCOPE, { action: "goal.set", threadId: THREAD_ID, params: { status: "paused", expectedVersion: current.version } }),
    error => error.status === 400 && error.code === "CONFIRMATION_NOT_REQUIRED"
  );
  const prepared = await service.prepareConfirmation(SCOPE, { action: "goal.set", threadId: THREAD_ID, params });
  const completed = await service.execute(SCOPE, {
    action: "goal.set",
    threadId: THREAD_ID,
    params,
    confirmationId: prepared.confirmationId
  });
  assert.equal(completed.goal.status, "complete");
  assert.equal(setCalls(native).at(-1).params.status, "complete");
  // The goal version advanced, so a stale replay is rejected before any further mutation.
  await assert.rejects(
    service.execute(SCOPE, { action: "goal.set", threadId: THREAD_ID, params, confirmationId: prepared.confirmationId }),
    error => error.status === 409 && error.code === "STALE_GOAL"
  );
  assert.equal(setCalls(native).length, 1);
});

test("pin uses the hardcoded codex_app tool and strips unrelated thread metadata", async t => {
  const native = fakeNative({
    tools: {
      move_thread_to_sidebar_section: params => ({ isError: false, content: [{ type: "text", text: "Moved to pinned" }] }),
      list_threads: () => ({
        isError: false,
        content: [{
          type: "text",
          text: JSON.stringify({
            threads: [
              { id: THREAD_ID, title: "target", sectionId: "pinned", cwd: "C:\\work\\project" },
              { id: OTHER_THREAD_ID, title: "private other thread", cwd: "D:\\secret\\other" }
            ]
          })
        }]
      })
    }
  });
  const { service } = await serviceFor(t, { native });
  const result = await service.execute(SCOPE, { action: "thread.pin", threadId: THREAD_ID, params: {} });
  assert.equal(result.verified, true);
  assert.equal(result.sectionId, "pinned");
  assert.deepEqual(Object.keys(result).sort(), ["action", "ok", "sectionId", "threadId", "verified"]);
  assert.equal(JSON.stringify(result).includes("private other thread"), false);
  assert.equal(JSON.stringify(result).includes("D:\\\\secret"), false);

  const move = native.calls.find(call => call.method === "mcpServer/tool/call" && call.params.tool === "move_thread_to_sidebar_section");
  assert.deepEqual(move.params, {
    server: "codex_app",
    threadId: THREAD_ID,
    tool: "move_thread_to_sidebar_section",
    arguments: { source: "codex", threadId: THREAD_ID, sectionId: "pinned" }
  });
  assert.equal(Object.hasOwn(move.params, "_meta"), false);
  assert.equal(Object.hasOwn(move.params, "hostId"), false);

  const unpin = await service.execute(SCOPE, { action: "thread.unpin", threadId: THREAD_ID, params: {} });
  assert.equal(unpin.sectionId, null);
});

test("authorization is mandatory, target-bound and repeated before mutations", async t => {
  assert.throws(
    () => createNativeActionsService({ callNative: async () => ({}), dataDir: path.join(os.tmpdir(), "x") }),
    error => error.status === 403 && error.code === "AUTHORIZATION_REQUIRED"
  );
  const missing = await serviceFor(t, { authorize: async () => null });
  await assert.rejects(missing.service.getGoal(SCOPE, { threadId: THREAD_ID }), error => error.status === 403 && error.code === "THREAD_FORBIDDEN");
  assert.deepEqual(missing.native.calls, []);

  const mismatch = await serviceFor(t, { authorize: async () => ({ id: OTHER_THREAD_ID, cwd: "C:\\x" }) });
  await assert.rejects(mismatch.service.getGoal(SCOPE, { threadId: THREAD_ID }), error => error.status === 403);

  const noCwd = await serviceFor(t, { authorize: async scope => ({ id: scope, cwd: "" }) });
  await assert.rejects(noCwd.service.describe(SCOPE, { threadId: THREAD_ID }), error => error.status === 403);

  let authorizations = 0;
  const { service } = await serviceFor(t, {
    authorize: async (scope, threadId) => {
      authorizations += 1;
      return threadId === THREAD_ID ? THREAD : null;
    }
  });
  const current = await service.getGoal(SCOPE, { threadId: THREAD_ID });
  authorizations = 0;
  await service.execute(SCOPE, { action: "goal.set", threadId: THREAD_ID, params: { status: "paused", expectedVersion: current.version } });
  assert.ok(authorizations >= 2);
});

test("native failures are typed and never leak objectives, paths or raw messages", async t => {
  const calls = [];
  const unsupported = createNativeActionsService({
    callNative: async () => { calls.push(1); throw Object.assign(new Error("method not found: thread/goal/get"), { code: "-32601" }); },
    authorizeThread: async () => THREAD,
    dataDir: await tempDir(t)
  });
  await assert.rejects(
    unsupported.getGoal(SCOPE, { threadId: THREAD_ID }),
    error => error.status === 501 && error.code === "NATIVE_UNSUPPORTED" && error.message === "NATIVE_UNSUPPORTED"
  );

  const toolError = await serviceFor(t, {
    native: fakeNative({ tools: { move_thread_to_sidebar_section: () => ({ isError: true, content: [{ type: "text", text: "EACCES C:\\secret\\objective.txt" }] }) } })
  });
  await assert.rejects(
    toolError.service.execute(SCOPE, { action: "thread.pin", threadId: THREAD_ID, params: {} }),
    error => error.status === 502 && error.code === "NATIVE_TOOL_ERROR" && !JSON.stringify(error).includes("C:\\\\secret")
  );

  const secretObjective = "C:\\secret\\objective.txt should not leak";
  const native = fakeNative();
  const original = native.call;
  native.call = async (method, params) => {
    if (method === "thread/goal/set") {
      const error = new Error(`failed to write ${secretObjective}`);
      error.code = "-32000";
      throw error;
    }
    return original(method, params);
  };
  const { service } = await serviceFor(t, { native });
  const current = await service.getGoal(SCOPE, { threadId: THREAD_ID });
  await assert.rejects(
    service.execute(SCOPE, { action: "goal.set", threadId: THREAD_ID, params: { objective: secretObjective, expectedVersion: current.version } }),
    error => {
      assert.equal(error.status, 502);
      assert.equal(JSON.stringify(error).includes(secretObjective), false);
      return true;
    }
  );

  const unknown = await serviceFor(t);
  await assert.rejects(
    unknown.service.execute(SCOPE, { action: "thread.unsupported", threadId: THREAD_ID, params: {} }),
    error => error.status === 400 && error.code === "UNKNOWN_ACTION"
  );
  await assert.rejects(
    unknown.service.execute(SCOPE, { action: "thread.pin", threadId: THREAD_ID, params: { hostId: "host-x" } }),
    error => error.status === 400
  );
  for (const params of [{ server: "codex_app" }, { tool: "list_threads" }, { _meta: {} }]) {
    await assert.rejects(
      unknown.service.execute(SCOPE, { action: "thread.pin", threadId: THREAD_ID, params }),
      error => error.status === 400
    );
  }
});

test("describe returns safe metadata only", async t => {
  const { service } = await serviceFor(t);
  const described = await service.describe(SCOPE, { threadId: THREAD_ID });
  assert.equal(described.threadId, THREAD_ID);
  const ids = described.actions.map(action => action.id);
  for (const expected of ["goal.get", "goal.set", "goal.pause", "goal.resume", "goal.clear", "thread.pin", "thread.unpin", "heartbeat.create", "heartbeat.delete"]) {
    assert.ok(ids.includes(expected), expected);
  }
  const text = JSON.stringify(described);
  assert.equal(text.includes("FREQ="), false);
  assert.equal(text.includes("prompt"), false);
  assert.equal(described.capabilities.heartbeat.scheduler, "native-automation-only");
  assert.equal(described.capabilities.unsupported.includes("loop-scheduler"), true);
});
