import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createNativeThreadActionsService } from "../server/native-thread-actions.js";

const THREAD_ID = "thread-1";
const OTHER_THREAD_ID = "thread-2";
const CHILD_ID = "thread-child";
const WORK_CWD = "/work/project";
const SHARE_URL = "https://chatgpt.com/share/abc-123";
const SCOPE = { id: "scope-1", authMode: "token", tokenHash: "a".repeat(64) };
const OTHER_SCOPE = { id: "scope-2", authMode: "token", tokenHash: "b".repeat(64) };

// The exact public action surface. `thread.pin`/`thread.unpin` live in the existing
// native-actions service, not in this standalone thread-actions backend.
const ACTION_METADATA = [
  { id: "thread.rename", mutating: true, destructive: false, requiresConfirmation: false, requiresRequestId: false, externalSnapshot: false },
  { id: "thread.read", mutating: true, destructive: false, requiresConfirmation: false, requiresRequestId: false, externalSnapshot: false },
  { id: "thread.unread", mutating: true, destructive: false, requiresConfirmation: false, requiresRequestId: false, externalSnapshot: false },
  { id: "thread.archive", mutating: true, destructive: false, requiresConfirmation: false, requiresRequestId: false, externalSnapshot: false },
  { id: "thread.unarchive", mutating: true, destructive: false, requiresConfirmation: false, requiresRequestId: false, externalSnapshot: false },
  { id: "thread.fork", mutating: true, destructive: false, requiresConfirmation: false, requiresRequestId: true, externalSnapshot: false },
  { id: "thread.project.list", mutating: false, destructive: false, requiresConfirmation: false, requiresRequestId: false, externalSnapshot: false },
  { id: "thread.project.move", mutating: true, destructive: false, requiresConfirmation: false, requiresRequestId: false, externalSnapshot: false },
  { id: "thread.share", mutating: true, destructive: false, requiresConfirmation: true, requiresRequestId: true, externalSnapshot: true },
  { id: "thread.delete", mutating: true, destructive: true, requiresConfirmation: true, requiresRequestId: true, externalSnapshot: false }
];

const clone = value => JSON.parse(JSON.stringify(value));

async function tempDir(t, prefix = "native-thread-actions-") {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return dir;
}

function mcpText(value) {
  return { isError: false, content: [{ type: "text", text: JSON.stringify(value) }] };
}

function mcpRawText(text) {
  return { isError: false, content: [{ type: "text", text }] };
}

function mcpError() {
  return { isError: true, content: [{ type: "text", text: "native tool exploded" }] };
}

// Fake MCP engine: only mcpServer/tool/call exists, dispatched by a fixed per-test tool table.
function fakeNative(tools = {}) {
  const calls = [];
  async function callNative(method, params) {
    calls.push({ method, params: clone(params) });
    if (method !== "mcpServer/tool/call") {
      throw Object.assign(new Error("method not found"), { code: "-32601" });
    }
    const handler = tools[params.tool];
    if (!handler) throw new Error(`unexpected tool ${params.tool}`);
    return handler(params);
  }
  return { call: callNative, calls };
}

function authorizer(threads, hook = null) {
  let count = 0;
  const ids = [];
  const authorize = async (scope, threadId) => {
    count += 1;
    ids.push(threadId);
    if (hook) await hook(scope, threadId, count);
    const thread = threads[threadId];
    if (!thread) throw Object.assign(new Error("forbidden"), { status: 403, code: "THREAD_FORBIDDEN" });
    return clone(thread);
  };
  authorize.count = () => count;
  authorize.ids = ids;
  return authorize;
}

function threadRecord(id, overrides = {}) {
  return { id, cwd: WORK_CWD, name: `Chat ${id}`, updatedAt: "2026-01-01T00:00:00.000Z", status: "active", ...overrides };
}

function threadsFixture(extra = {}) {
  return {
    [THREAD_ID]: threadRecord(THREAD_ID, { name: "Original chat" }),
    ...extra
  };
}

async function serviceFor(t, { threads, tools, authorize: authorizeOverride, confirmations, now } = {}) {
  const dataDir = await tempDir(t);
  const native = fakeNative(tools);
  const threadMap = threads || threadsFixture();
  const authorize = authorizeOverride || authorizer(threadMap);
  const service = createNativeThreadActionsService({
    callNative: native.call,
    authorizeThread: authorize,
    dataDir,
    confirmations,
    now
  });
  return { service, native, dataDir, threads: threadMap, authorize };
}

const toolNames = native => native.calls.map(call => call.params.tool);
const toolCall = (native, tool) => native.calls.find(call => call.params.tool === tool);

function assertNativeCall(call, tool, args) {
  assert.equal(call.method, "mcpServer/tool/call");
  assert.deepEqual(call.params, {
    server: "codex_app",
    threadId: THREAD_ID,
    tool,
    arguments: args
  });
  assert.deepEqual(Object.keys(call.params).sort(), ["arguments", "server", "threadId", "tool"]);
  for (const forbidden of ["_meta", "host", "hostId", "source", "serverId", "method"]) {
    assert.equal(Object.hasOwn(call.params, forbidden), false, `native payload must not carry ${forbidden}`);
  }
}

async function expectCode(promise, status, code) {
  await assert.rejects(promise, error => {
    assert.equal(error?.status, status, `expected status ${status} for ${code}, got ${error?.status} (${error?.code})`);
    assert.equal(error?.code, code);
    return true;
  });
}

function throwsCode(fn, status, code) {
  assert.throws(fn, error => {
    assert.equal(error?.status, status, `expected status ${status} for ${code}, got ${error?.status} (${error?.code})`);
    assert.equal(error?.code, code);
    return true;
  });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Reads the private wx-claim ledger so tests can prove pending/unknown/success transitions.
async function ledgerRecords(dataDir) {
  const dir = path.join(dataDir, "native-thread-actions");
  let names;
  try {
    names = await fs.readdir(dir);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const records = [];
  for (const name of names.sort()) {
    records.push(JSON.parse(await fs.readFile(path.join(dir, name), "utf8")));
  }
  return records;
}

// ---------------------------------------------------------------------------------------------
// Surface.
// ---------------------------------------------------------------------------------------------

test("supports and describe expose the exact static action allowlist", async t => {
  const { service, native } = await serviceFor(t);

  assert.deepEqual(ACTION_METADATA.map(entry => entry.id), [
    "thread.rename",
    "thread.read",
    "thread.unread",
    "thread.archive",
    "thread.unarchive",
    "thread.fork",
    "thread.project.list",
    "thread.project.move",
    "thread.share",
    "thread.delete"
  ]);
  for (const entry of ACTION_METADATA) assert.equal(service.supports(entry.id), true, entry.id);
  for (const action of ["thread.pin", "thread.unpin", "goal.set", "share_thread", "", null, 42, {}]) {
    assert.equal(service.supports(action), false, String(action));
  }
  assert.equal(Object.isFrozen(service), true);

  const described = await service.describe(SCOPE, { threadId: THREAD_ID });
  assert.deepEqual(described, { threadId: THREAD_ID, actions: ACTION_METADATA });
  for (const action of described.actions) {
    assert.equal(Object.hasOwn(action, "tool"), false, "tool names never leave the module");
  }
  assert.equal(native.calls.length, 0);

  await expectCode(service.describe(SCOPE, { threadId: "missing-thread" }), 403, "THREAD_FORBIDDEN");
  await expectCode(service.describe(SCOPE, {}), 400, "INVALID_THREAD_ID");
});

test("service construction requires native, authorization, and a data dir", () => {
  throwsCode(() => createNativeThreadActionsService({}), 500, "NATIVE_UNAVAILABLE");
  throwsCode(() => createNativeThreadActionsService({ callNative: async () => ({}) }), 403, "AUTHORIZATION_REQUIRED");
  throwsCode(
    () => createNativeThreadActionsService({ callNative: async () => ({}), authorizeThread: async () => ({}) }),
    500,
    "DATA_DIR_REQUIRED"
  );
});

// ---------------------------------------------------------------------------------------------
// Param validation: no host/_meta/tool injection, bounded ids and text.
// ---------------------------------------------------------------------------------------------

test("execute refuses unknown actions and injected routing fields before any native call", async t => {
  const { service, native } = await serviceFor(t);

  await expectCode(service.execute(SCOPE, { action: "thread.pin", threadId: THREAD_ID, params: {} }), 400, "UNKNOWN_ACTION");
  await expectCode(service.execute(SCOPE, { action: undefined, threadId: THREAD_ID }), 400, "UNKNOWN_ACTION");

  const injections = [
    { _meta: { approval: true } },
    { hostId: "host-1" },
    { host: "host-1" },
    { source: "user" },
    { server: "codex_app" },
    { tool: "delete_thread" },
    { serverId: "codex_app" },
    { threadId: OTHER_THREAD_ID },
    { environment: { type: "same-directory" } },
    { beforeThreadId: OTHER_THREAD_ID }
  ];
  for (const params of injections) {
    await expectCode(service.execute(SCOPE, { action: "thread.read", threadId: THREAD_ID, params }), 400, "INVALID_PARAMS");
  }
  await expectCode(
    service.execute(SCOPE, { action: "thread.rename", threadId: THREAD_ID, params: { title: "ok", hostId: "h" } }),
    400,
    "INVALID_PARAMS"
  );
  await expectCode(service.execute(SCOPE, { action: "thread.read", threadId: THREAD_ID, params: [] }), 400, "INVALID_PARAMS");
  await expectCode(service.execute(SCOPE, { action: "thread.read", threadId: THREAD_ID, params: "x" }), 400, "INVALID_PARAMS");
  await expectCode(
    service.execute(SCOPE, { action: "thread.read", threadId: THREAD_ID, params: JSON.parse('{"__proto__":{"admin":true}}') }),
    400,
    "INVALID_PARAMS"
  );
  assert.equal(native.calls.length, 0);
});

test("thread ids, request ids, titles, project ids, and confirmation text stay bounded", async t => {
  const { service, native } = await serviceFor(t);

  for (const threadId of ["", "x".repeat(201), "bad\u0000id", "bad\nid", 42, null]) {
    await expectCode(service.execute(SCOPE, { action: "thread.read", threadId, params: {} }), 400, "INVALID_THREAD_ID");
  }

  for (const title of [42, "", "   ", null]) {
    await expectCode(service.execute(SCOPE, { action: "thread.rename", threadId: THREAD_ID, params: { title } }), 400, "INVALID_TITLE");
  }
  await expectCode(
    service.execute(SCOPE, { action: "thread.rename", threadId: THREAD_ID, params: { title: "😀".repeat(301) } }),
    400,
    "TITLE_TOO_LONG"
  );

  for (const projectId of [42, "a/b", "x".repeat(201), undefined]) {
    await expectCode(
      service.execute(SCOPE, { action: "thread.project.move", threadId: THREAD_ID, params: { projectId } }),
      400,
      "INVALID_PROJECT_ID"
    );
  }
  await expectCode(service.execute(SCOPE, { action: "thread.project.move", threadId: THREAD_ID, params: {} }), 400, "INVALID_PROJECT_ID");

  for (const confirmationText of ["", 42, "x".repeat(513), null]) {
    await expectCode(
      service.execute(SCOPE, { action: "thread.delete", threadId: THREAD_ID, params: { confirmationText } }),
      400,
      "INVALID_CONFIRMATION_TEXT"
    );
  }

  await expectCode(service.execute(SCOPE, { action: "thread.fork", threadId: THREAD_ID, params: {} }), 400, "REQUEST_ID_REQUIRED");
  for (const requestId of ["bad id!", "x".repeat(129), 42]) {
    await expectCode(
      service.execute(SCOPE, { action: "thread.fork", threadId: THREAD_ID, params: {}, requestId }),
      400,
      "INVALID_REQUEST_ID"
    );
  }

  for (const params of [{}, { reviewed: false }, { reviewed: "true" }, { reviewed: 1 }]) {
    await expectCode(
      service.execute(SCOPE, { action: "thread.share", threadId: THREAD_ID, params, requestId: "req-share-params" }),
      400,
      "REVIEW_REQUIRED"
    );
  }
  await expectCode(
    service.execute(SCOPE, { action: "thread.share", threadId: THREAD_ID, params: { reviewed: true, extra: 1 }, requestId: "req-share-extra" }),
    400,
    "INVALID_PARAMS"
  );

  assert.equal(native.calls.length, 0);
});

// ---------------------------------------------------------------------------------------------
// Exact native payloads.
// ---------------------------------------------------------------------------------------------

test("rename sends the exact allowlisted payload and verifies the applied title", async t => {
  const threads = threadsFixture();
  const longTitle = "😀".repeat(300);
  const tools = {
    set_thread_title: params => {
      threads[THREAD_ID].name = params.arguments.title;
      return mcpText({ ok: true });
    }
  };
  const { service, native, authorize } = await serviceFor(t, { threads, tools });

  const result = await service.execute(SCOPE, { action: "thread.rename", threadId: THREAD_ID, params: { title: longTitle } });
  assert.deepEqual(result, { ok: true, action: "thread.rename", threadId: THREAD_ID, title: longTitle, verified: true });
  assert.equal(native.calls.length, 1);
  assertNativeCall(native.calls[0], "set_thread_title", { source: "codex", threadId: THREAD_ID, title: longTitle });
  assert.equal(authorize.count(), 3, "initial auth, pre-mutation re-auth, post-mutation verification");
});

test("rename reports RENAME_NOT_APPLIED when native acknowledges without changing the title", async t => {
  const tools = { set_thread_title: () => mcpText({ ok: true }) };
  const { service, native } = await serviceFor(t, { tools });

  await expectCode(
    service.execute(SCOPE, { action: "thread.rename", threadId: THREAD_ID, params: { title: "New name" } }),
    409,
    "RENAME_NOT_APPLIED"
  );
  assert.equal(native.calls.length, 1);
});

test("read, unread, archive, unarchive, and project.list use exact payloads and sanitize output", async t => {
  const projects = [
    { id: "proj-1", name: "Alpha", path: "/work/project", secret: "do-not-leak" },
    { id: "bad id", name: "Bad" },
    { id: 7, name: "Numeric" },
    { id: "proj-2", name: "x".repeat(201) }
  ];
  const tools = {
    set_thread_read_state: () => mcpText({ ok: true }),
    set_thread_archived: () => mcpText({ ok: true }),
    list_projects: () => mcpText(projects)
  };
  const { service, native } = await serviceFor(t, { tools });

  assert.deepEqual(await service.execute(SCOPE, { action: "thread.read", threadId: THREAD_ID, params: {} }), {
    ok: true,
    action: "thread.read",
    threadId: THREAD_ID,
    read: true
  });
  assert.deepEqual(await service.execute(SCOPE, { action: "thread.unread", threadId: THREAD_ID, params: {} }), {
    ok: true,
    action: "thread.unread",
    threadId: THREAD_ID,
    read: false
  });
  assert.deepEqual(await service.execute(SCOPE, { action: "thread.archive", threadId: THREAD_ID, params: {} }), {
    ok: true,
    action: "thread.archive",
    threadId: THREAD_ID,
    archived: true
  });
  assert.deepEqual(await service.execute(SCOPE, { action: "thread.unarchive", threadId: THREAD_ID, params: {} }), {
    ok: true,
    action: "thread.unarchive",
    threadId: THREAD_ID,
    archived: false
  });
  const listed = await service.execute(SCOPE, { action: "thread.project.list", threadId: THREAD_ID, params: {} });
  assert.deepEqual(listed, {
    ok: true,
    action: "thread.project.list",
    threadId: THREAD_ID,
    projects: [
      { id: "proj-1", name: "Alpha", path: "/work/project" },
      { id: "proj-2" }
    ]
  });

  assert.deepEqual(native.calls.map(call => call.params.tool), [
    "set_thread_read_state",
    "set_thread_read_state",
    "set_thread_archived",
    "set_thread_archived",
    "list_projects"
  ]);
  assertNativeCall(native.calls[0], "set_thread_read_state", { source: "codex", threadId: THREAD_ID, read: true });
  assertNativeCall(native.calls[1], "set_thread_read_state", { source: "codex", threadId: THREAD_ID, read: false });
  assertNativeCall(native.calls[2], "set_thread_archived", { source: "codex", threadId: THREAD_ID, archived: true });
  assertNativeCall(native.calls[3], "set_thread_archived", { source: "codex", threadId: THREAD_ID, archived: false });
  assertNativeCall(native.calls[4], "list_projects", {});
});

test("project.move validates the native project list and sends the exact payload", async t => {
  const tools = {
    list_projects: () => mcpText([{ id: "proj-1", name: "Alpha", path: WORK_CWD }]),
    move_thread_to_project: () => mcpText({ ok: true })
  };
  const { service, native } = await serviceFor(t, { tools });

  const result = await service.execute(SCOPE, { action: "thread.project.move", threadId: THREAD_ID, params: { projectId: "proj-1" } });
  assert.deepEqual(result, { ok: true, action: "thread.project.move", threadId: THREAD_ID, projectId: "proj-1" });
  assert.deepEqual(toolNames(native), ["list_projects", "move_thread_to_project"]);
  assertNativeCall(native.calls[1], "move_thread_to_project", { source: "codex", threadId: THREAD_ID, projectId: "proj-1" });

  const beforeMissing = native.calls.length;
  await expectCode(
    service.execute(SCOPE, { action: "thread.project.move", threadId: THREAD_ID, params: { projectId: "missing" } }),
    404,
    "PROJECT_NOT_FOUND"
  );
  assert.equal(native.calls.length, beforeMissing + 1, "only the project list is read");

  const beforeNull = native.calls.length;
  const cleared = await service.execute(SCOPE, { action: "thread.project.move", threadId: THREAD_ID, params: { projectId: null } });
  assert.equal(cleared.projectId, null);
  assert.equal(native.calls.length, beforeNull + 1, "moving out of a project needs no project lookup");
  assertNativeCall(native.calls[beforeNull], "move_thread_to_project", { source: "codex", threadId: THREAD_ID, projectId: null });

  await expectCode(
    service.execute(SCOPE, { action: "thread.project.move", threadId: THREAD_ID, params: { projectId: "proj-1", path: "/" } }),
    400,
    "INVALID_PARAMS"
  );
});

// ---------------------------------------------------------------------------------------------
// Fresh authorization.
// ---------------------------------------------------------------------------------------------

test("every mutation re-authorizes and aborts when the thread cwd changed", async t => {
  const threads = threadsFixture();
  const tools = { set_thread_read_state: () => mcpText({ ok: true }) };
  const authorize = authorizer(threads, (scope, threadId, count) => {
    if (count === 2) threads[THREAD_ID].cwd = "/work/swapped";
  });
  const { service, native } = await serviceFor(t, { threads, tools, authorize });

  await expectCode(service.execute(SCOPE, { action: "thread.read", threadId: THREAD_ID, params: {} }), 409, "THREAD_CONTEXT_CHANGED");
  assert.equal(native.calls.length, 0);
  assert.ok(authorize.count() >= 2, "authorization runs again immediately before the mutation");
});

test("authorization failures and malformed authorized threads are refused", async t => {
  const tools = { set_thread_read_state: () => mcpText({ ok: true }) };
  const cases = [
    async () => {
      throw Object.assign(new Error("forbidden"), { status: 403, code: "THREAD_FORBIDDEN" });
    },
    async () => {
      throw new Error("authorizer exploded");
    },
    async () => ({ id: OTHER_THREAD_ID, cwd: WORK_CWD }),
    async () => ({ id: THREAD_ID }),
    async () => ({ id: THREAD_ID, cwd: "" })
  ];
  for (const authorize of cases) {
    const { service, native } = await serviceFor(t, { tools, authorize });
    await expectCode(service.execute(SCOPE, { action: "thread.read", threadId: THREAD_ID, params: {} }), 403, "THREAD_FORBIDDEN");
    assert.equal(native.calls.length, 0);
  }
});

// ---------------------------------------------------------------------------------------------
// Fork: child verification, honest statuses, ledger.
// ---------------------------------------------------------------------------------------------

test("fork re-authorizes the child, requires the same cwd, and never issues a follow-up turn", async t => {
  const threads = threadsFixture({ [CHILD_ID]: threadRecord(CHILD_ID, { name: "Forked chat" }) });
  const tools = { fork_thread: () => mcpText({ child: { id: CHILD_ID } }) };
  const { service, native, authorize } = await serviceFor(t, { threads, tools });

  const result = await service.execute(SCOPE, { action: "thread.fork", threadId: THREAD_ID, params: {}, requestId: "req-fork-ok" });
  assert.deepEqual(result, {
    ok: true,
    action: "thread.fork",
    threadId: THREAD_ID,
    childThreadId: CHILD_ID,
    childVerified: true
  });
  assert.deepEqual(toolNames(native), ["fork_thread"], "no message/send/turn-start follow-up is allowed");
  assertNativeCall(native.calls[0], "fork_thread", { threadId: THREAD_ID, environment: { type: "same-directory" } });
  assert.ok(authorize.ids.includes(CHILD_ID), "the child chat is re-authorized through the same authorizer");
});

test("fork accepts only known child id shapes from the native result", async t => {
  const shapes = [
    { child: { id: CHILD_ID } },
    { thread: { threadId: CHILD_ID } },
    { newThreadId: CHILD_ID },
    { childThreadId: CHILD_ID }
  ];
  for (const [index, payload] of shapes.entries()) {
    const threads = threadsFixture({ [CHILD_ID]: threadRecord(CHILD_ID) });
    const tools = { fork_thread: () => mcpText(payload) };
    const { service, native } = await serviceFor(t, { threads, tools });
    const result = await service.execute(SCOPE, {
      action: "thread.fork",
      threadId: THREAD_ID,
      params: {},
      requestId: `req-fork-shape-${index}`
    });
    assert.equal(result.ok, true);
    assert.equal(result.childThreadId, CHILD_ID);
    assert.equal(result.childVerified, true);
    assert.equal(native.calls.length, 1);
  }
});

test("fork refuses a child chat whose cwd differs or that cannot be re-authorized", async t => {
  const cases = [
    threadsFixture({ [CHILD_ID]: threadRecord(CHILD_ID, { cwd: "/work/elsewhere" }) }),
    threadsFixture()
  ];
  for (const [index, threads] of cases.entries()) {
    const tools = { fork_thread: () => mcpText({ child: { id: CHILD_ID } }) };
    const { service, native } = await serviceFor(t, { threads, tools });
    const requestId = `req-fork-unverified-${index}`;
    await expectCode(
      service.execute(SCOPE, { action: "thread.fork", threadId: THREAD_ID, params: {}, requestId }),
      409,
      "FORK_CHILD_UNVERIFIED"
    );
    assert.equal(native.calls.length, 1);
    await expectCode(
      service.execute(SCOPE, { action: "thread.fork", threadId: THREAD_ID, params: {}, requestId }),
      503,
      "NATIVE_OUTCOME_UNKNOWN"
    );
    assert.equal(native.calls.length, 1, "an unverified child is never retried automatically");
  }
});

test("fork reports pending or unknown native approvals instead of claiming success", async t => {
  const pendingPayloads = [{ status: "pending" }, { status: "awaiting_approval" }, { requiresApproval: true }, { approved: false }];
  for (const [index, payload] of pendingPayloads.entries()) {
    const threads = threadsFixture({ [CHILD_ID]: threadRecord(CHILD_ID) });
    const tools = { fork_thread: () => mcpText(payload) };
    const { service, native } = await serviceFor(t, { threads, tools });
    const result = await service.execute(SCOPE, {
      action: "thread.fork",
      threadId: THREAD_ID,
      params: {},
      requestId: `req-fork-pending-${index}`
    });
    assert.deepEqual(result, { ok: false, action: "thread.fork", threadId: THREAD_ID, status: "pending", childThreadId: null });
    assert.equal(native.calls.length, 1);
  }

  const unknownResponses = [() => mcpText({ ok: true }), () => mcpText({}), () => mcpRawText("Forked chat created")];
  for (const [index, response] of unknownResponses.entries()) {
    const tools = { fork_thread: response };
    const { service, native } = await serviceFor(t, { tools });
    const result = await service.execute(SCOPE, {
      action: "thread.fork",
      threadId: THREAD_ID,
      params: {},
      requestId: `req-fork-unknown-${index}`
    });
    assert.deepEqual(result, { ok: false, action: "thread.fork", threadId: THREAD_ID, status: "unknown", childThreadId: null });
    assert.equal(native.calls.length, 1);
  }
});

test("fork claims a wx ledger file and never auto-retries an unknown outcome", async t => {
  const tools = {
    fork_thread: () => {
      throw Object.assign(new Error("socket closed"), { code: "ECONNRESET" });
    }
  };
  const { service, native, dataDir } = await serviceFor(t, { tools });

  await expectCode(
    service.execute(SCOPE, { action: "thread.fork", threadId: THREAD_ID, params: {}, requestId: "req-fork-unknown" }),
    503,
    "NATIVE_OUTCOME_UNKNOWN"
  );
  assert.equal(native.calls.length, 1);
  const records = await ledgerRecords(dataDir);
  assert.equal(records.length, 1);
  assert.equal(records[0].status, "unknown");
  assert.equal(records[0].action, "thread.fork");
  assert.equal(records[0].threadId, THREAD_ID);

  await expectCode(
    service.execute(SCOPE, { action: "thread.fork", threadId: THREAD_ID, params: {}, requestId: "req-fork-unknown" }),
    503,
    "NATIVE_OUTCOME_UNKNOWN"
  );
  assert.equal(native.calls.length, 1);
});

test("concurrent duplicate request ids call native once and replay the stored result", async t => {
  const started = deferred();
  const gate = deferred();
  const threads = threadsFixture({
    [OTHER_THREAD_ID]: threadRecord(OTHER_THREAD_ID),
    [CHILD_ID]: threadRecord(CHILD_ID)
  });
  const tools = {
    fork_thread: async () => {
      started.resolve();
      await gate.promise;
      return mcpText({ child: { id: CHILD_ID } });
    }
  };
  const { service, native, dataDir } = await serviceFor(t, { threads, tools });

  const first = service.execute(SCOPE, { action: "thread.fork", threadId: THREAD_ID, params: {}, requestId: "req-fork-race" });
  await started.promise;
  const pendingRecords = await ledgerRecords(dataDir);
  assert.equal(pendingRecords.length, 1);
  assert.equal(pendingRecords[0].status, "pending");

  await expectCode(
    service.execute(SCOPE, { action: "thread.fork", threadId: THREAD_ID, params: {}, requestId: "req-fork-race" }),
    503,
    "NATIVE_OUTCOME_UNKNOWN"
  );
  assert.equal(native.calls.length, 1, "the concurrent duplicate never fires a second native mutation");

  gate.resolve();
  const firstResult = await first;
  assert.equal(firstResult.ok, true);
  assert.equal(firstResult.childThreadId, CHILD_ID);

  const replay = await service.execute(SCOPE, { action: "thread.fork", threadId: THREAD_ID, params: {}, requestId: "req-fork-race" });
  assert.deepEqual(replay, { ...firstResult, replayed: true });
  assert.equal(native.calls.length, 1);

  const records = await ledgerRecords(dataDir);
  assert.equal(records[0].status, "success");

  await expectCode(
    service.execute(SCOPE, { action: "thread.fork", threadId: OTHER_THREAD_ID, params: {}, requestId: "req-fork-race" }),
    409,
    "REQUEST_ID_CONFLICT"
  );
});

// ---------------------------------------------------------------------------------------------
// Share: validated official URL only, honest approvals, immutable replay.
// ---------------------------------------------------------------------------------------------

test("share returns only a validated official HTTPS url and replays it immutably", async t => {
  const tools = { share_thread: () => mcpText({ url: SHARE_URL, extra: "ignored" }) };
  const { service, native } = await serviceFor(t, { tools });

  const prepared = await service.prepareConfirmation(SCOPE, {
    action: "thread.share",
    threadId: THREAD_ID,
    params: { reviewed: true }
  });
  assert.equal(prepared.action, "thread.share");
  assert.equal(prepared.threadId, THREAD_ID);
  assert.equal(prepared.summary.destructive, false);
  assert.equal(prepared.summary.includesDescendants, false);
  assert.equal(prepared.summary.externalSnapshot, true);
  assert.equal(prepared.summary.title, "Original chat");

  const result = await service.execute(SCOPE, {
    action: "thread.share",
    threadId: THREAD_ID,
    params: { reviewed: true },
    requestId: "req-share-ok",
    confirmationId: prepared.confirmationId
  });
  assert.deepEqual(result, { ok: true, action: "thread.share", threadId: THREAD_ID, shareUrl: SHARE_URL });
  assert.equal(native.calls.length, 1);
  assertNativeCall(native.calls[0], "share_thread", { threadId: THREAD_ID });

  // The cached ledger result is the validated URL, not a mutable caller/native echo.
  result.shareUrl = "https://evil.example/steal";
  const replay = await service.execute(SCOPE, {
    action: "thread.share",
    threadId: THREAD_ID,
    params: { reviewed: true },
    requestId: "req-share-ok",
    confirmationId: prepared.confirmationId
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.shareUrl, SHARE_URL);
  assert.equal(native.calls.length, 1);

  const canonical = { share_thread: () => mcpText({ shareUrl: "https://WWW.CHATGPT.COM:443/share/AbC" }) };
  const second = await serviceFor(t, { tools: canonical });
  const preparedSecond = await second.service.prepareConfirmation(SCOPE, {
    action: "thread.share",
    threadId: THREAD_ID,
    params: { reviewed: true }
  });
  const canonicalResult = await second.service.execute(SCOPE, {
    action: "thread.share",
    threadId: THREAD_ID,
    params: { reviewed: true },
    requestId: "req-share-canonical",
    confirmationId: preparedSecond.confirmationId
  });
  assert.equal(canonicalResult.shareUrl, "https://www.chatgpt.com/share/AbC");
});

test("share rejects non-official, insecure, credential-bearing, port-shifted, or text-only urls", async t => {
  const cases = [
    { label: "http", response: () => mcpText({ url: "http://chatgpt.com/share/abc" }) },
    { label: "foreign host", response: () => mcpText({ url: "https://evil.example/share/abc" }) },
    { label: "lookalike host", response: () => mcpText({ url: "https://chatgpt.com.evil.example/share/abc" }) },
    { label: "credentials", response: () => mcpText({ url: "https://user:pass@chatgpt.com/share/abc" }) },
    { label: "non-default port", response: () => mcpText({ url: "https://chatgpt.com:8443/share/abc" }) },
    { label: "javascript", response: () => mcpText({ url: "javascript:alert(1)" }) },
    { label: "nested insecure", response: () => mcpText({ share: { url: "http://chatgpt.com/share/abc" } }) },
    { label: "oversized", response: () => mcpText({ url: `https://chatgpt.com/share/${"a".repeat(2048)}` }) },
    { label: "text only", response: () => mcpRawText(`created ${SHARE_URL}`) }
  ];
  for (const [index, entry] of cases.entries()) {
    const tools = { share_thread: entry.response };
    const { service, native, dataDir } = await serviceFor(t, { tools });
    const prepared = await service.prepareConfirmation(SCOPE, {
      action: "thread.share",
      threadId: THREAD_ID,
      params: { reviewed: true }
    });
    const result = await service.execute(SCOPE, {
      action: "thread.share",
      threadId: THREAD_ID,
      params: { reviewed: true },
      requestId: `req-share-bad-${index}`,
      confirmationId: prepared.confirmationId
    });
    assert.deepEqual(result, { ok: false, action: "thread.share", threadId: THREAD_ID, status: "unknown" }, entry.label);
    assert.equal(Object.hasOwn(result, "shareUrl"), false, entry.label);
    assert.equal(native.calls.length, 1, entry.label);
    const records = await ledgerRecords(dataDir);
    assert.equal(records[0].status, "unknown", entry.label);
  }

  const tools = {
    share_thread: () => {
      throw new Error("bridge closed");
    }
  };
  const { service, native } = await serviceFor(t, { tools });
  const prepared = await service.prepareConfirmation(SCOPE, {
    action: "thread.share",
    threadId: THREAD_ID,
    params: { reviewed: true }
  });
  await expectCode(
    service.execute(SCOPE, {
      action: "thread.share",
      threadId: THREAD_ID,
      params: { reviewed: true },
      requestId: "req-share-throw",
      confirmationId: prepared.confirmationId
    }),
    503,
    "NATIVE_OUTCOME_UNKNOWN"
  );
  assert.equal(native.calls.length, 1);
});

test("share reports pending native approval instead of minting a link", async t => {
  for (const [index, payload] of [{ status: "pending" }, { requiresApproval: true }, { approved: false }].entries()) {
    const tools = { share_thread: () => mcpText(payload) };
    const { service, native } = await serviceFor(t, { tools });
    const prepared = await service.prepareConfirmation(SCOPE, {
      action: "thread.share",
      threadId: THREAD_ID,
      params: { reviewed: true }
    });
    const requestId = `req-share-pending-${index}`;
    const result = await service.execute(SCOPE, {
      action: "thread.share",
      threadId: THREAD_ID,
      params: { reviewed: true },
      requestId,
      confirmationId: prepared.confirmationId
    });
    assert.deepEqual(result, { ok: false, action: "thread.share", threadId: THREAD_ID, status: "pending" });
    assert.equal(Object.hasOwn(result, "shareUrl"), false);
    assert.equal(native.calls.length, 1);
    await expectCode(
      service.execute(SCOPE, {
        action: "thread.share",
        threadId: THREAD_ID,
        params: { reviewed: true },
        requestId,
        confirmationId: prepared.confirmationId
      }),
      503,
      "NATIVE_OUTCOME_UNKNOWN"
    );
    assert.equal(native.calls.length, 1);
  }
});

// ---------------------------------------------------------------------------------------------
// Folder-scoped tokens.
// ---------------------------------------------------------------------------------------------

test("folder-scoped tokens cannot share or delete a chat", async t => {
  const root = await tempDir(t, "native-thread-actions-root-");
  const scope = { ...SCOPE, threadFilterCwds: [root] };
  const tools = {
    share_thread: () => mcpText({ url: SHARE_URL }),
    delete_thread: () => mcpText({ status: "deleted", deleted: true })
  };
  const { service, native } = await serviceFor(t, { tools });

  await expectCode(
    service.prepareConfirmation(scope, { action: "thread.share", threadId: THREAD_ID, params: { reviewed: true } }),
    403,
    "THREAD_SCOPE_FORBIDDEN"
  );
  await expectCode(
    service.prepareConfirmation(scope, { action: "thread.delete", threadId: THREAD_ID, params: { confirmationText: THREAD_ID } }),
    403,
    "THREAD_SCOPE_FORBIDDEN"
  );
  await expectCode(
    service.execute(scope, {
      action: "thread.share",
      threadId: THREAD_ID,
      params: { reviewed: true },
      requestId: "req-share-scoped",
      confirmationId: "0".repeat(32)
    }),
    403,
    "THREAD_SCOPE_FORBIDDEN"
  );
  await expectCode(
    service.execute(scope, {
      action: "thread.delete",
      threadId: THREAD_ID,
      params: { confirmationText: THREAD_ID },
      requestId: "req-delete-scoped",
      confirmationId: "0".repeat(32)
    }),
    403,
    "THREAD_SCOPE_FORBIDDEN"
  );
  assert.equal(native.calls.length, 0);
});

test("folder-scoped project moves are limited to projects whose real path is inside an allowed root", async t => {
  const root = await tempDir(t, "native-thread-actions-root-");
  const outside = await tempDir(t, "native-thread-actions-outside-");
  const insideProject = path.join(root, "inside-project");
  const outsideProject = path.join(outside, "outside-project");
  await fs.mkdir(insideProject);
  await fs.mkdir(outsideProject);

  const scope = { ...SCOPE, threadFilterCwds: [root] };
  const tools = {
    list_projects: () => mcpText([
      { id: "inside", name: "Inside", path: insideProject },
      { id: "outside", name: "Outside", path: outsideProject },
      { id: "missing", name: "Missing", path: path.join(root, "does-not-exist") },
      { id: "pathless", name: "Pathless" }
    ]),
    move_thread_to_project: () => mcpText({ ok: true })
  };
  const { service, native } = await serviceFor(t, { tools });

  const moved = await service.execute(scope, {
    action: "thread.project.move",
    threadId: THREAD_ID,
    params: { projectId: "inside" }
  });
  const listing=await service.execute(scope,{action:"thread.project.list",threadId:THREAD_ID,params:{}});
  assert.deepEqual(listing.projects.map(project=>project.id),["inside"],"restricted scopes never see outside, missing or pathless projects");
  assert.equal(moved.ok, true);
  assertNativeCall(toolCall(native,"move_thread_to_project"), "move_thread_to_project", {
    source: "codex",
    threadId: THREAD_ID,
    projectId: "inside"
  });

  for (const projectId of ["outside", "missing", "pathless"]) {
    const before = native.calls.length;
    await expectCode(
      service.execute(scope, { action: "thread.project.move", threadId: THREAD_ID, params: { projectId } }),
      403,
      "PROJECT_FORBIDDEN"
    );
    assert.equal(native.calls.length, before + 1, "only the project list is read");
  }

  const beforeNull = native.calls.length;
  const cleared = await service.execute(scope, {
    action: "thread.project.move",
    threadId: THREAD_ID,
    params: { projectId: null }
  });
  assert.equal(cleared.projectId, null);
  assert.equal(native.calls.length, beforeNull + 1);
  assertNativeCall(native.calls[beforeNull], "move_thread_to_project", {
    source: "codex",
    threadId: THREAD_ID,
    projectId: null
  });
});

// ---------------------------------------------------------------------------------------------
// Delete: confirmation text and honest native approval status.
// ---------------------------------------------------------------------------------------------

test("delete requires a matching confirmation text and reports only proven deletion", async t => {
  const tools = { delete_thread: () => mcpText({ status: "deleted", deleted: true }) };
  const { service, native } = await serviceFor(t, { tools });

  const prepared = await service.prepareConfirmation(SCOPE, {
    action: "thread.delete",
    threadId: THREAD_ID,
    params: { confirmationText: THREAD_ID }
  });
  assert.equal(prepared.summary.destructive, true);
  assert.equal(prepared.summary.includesDescendants, true);
  assert.equal(prepared.summary.externalSnapshot, false);

  const result = await service.execute(SCOPE, {
    action: "thread.delete",
    threadId: THREAD_ID,
    params: { confirmationText: THREAD_ID },
    requestId: "req-delete-ok",
    confirmationId: prepared.confirmationId
  });
  assert.deepEqual(result, { ok: true, action: "thread.delete", threadId: THREAD_ID, status: "deleted", deleted: true });
  assert.equal(native.calls.length, 1);
  assertNativeCall(native.calls[0], "delete_thread", { source: "codex", threadId: THREAD_ID });

  // The chat name is an accepted confirmation text as well.
  const preparedByName = await service.prepareConfirmation(SCOPE, {
    action: "thread.delete",
    threadId: THREAD_ID,
    params: { confirmationText: "Original chat" }
  });
  const named = await service.execute(SCOPE, {
    action: "thread.delete",
    threadId: THREAD_ID,
    params: { confirmationText: "Original chat" },
    requestId: "req-delete-name",
    confirmationId: preparedByName.confirmationId
  });
  assert.equal(named.ok, true);
  assert.equal(native.calls.length, 2);

  const preparedWrong = await service.prepareConfirmation(SCOPE, {
    action: "thread.delete",
    threadId: THREAD_ID,
    params: { confirmationText: THREAD_ID }
  });
  await expectCode(
    service.execute(SCOPE, {
      action: "thread.delete",
      threadId: THREAD_ID,
      params: { confirmationText: "some other chat" },
      requestId: "req-delete-wrong",
      confirmationId: preparedWrong.confirmationId
    }),
    400,
    "CONFIRMATION_TEXT_MISMATCH"
  );
  assert.equal(native.calls.length, 2);
});

test("delete never reports success while native approval is pending or ambiguous", async t => {
  const pendingPayloads = [{ status: "pending" }, { status: "awaiting_approval", requiresApproval: true }, { approved: false }];
  for (const [index, payload] of pendingPayloads.entries()) {
    const tools = { delete_thread: () => mcpText(payload) };
    const { service, native, dataDir } = await serviceFor(t, { tools });
    const prepared = await service.prepareConfirmation(SCOPE, {
      action: "thread.delete",
      threadId: THREAD_ID,
      params: { confirmationText: THREAD_ID }
    });
    const requestId = `req-delete-pending-${index}`;
    const result = await service.execute(SCOPE, {
      action: "thread.delete",
      threadId: THREAD_ID,
      params: { confirmationText: THREAD_ID },
      requestId,
      confirmationId: prepared.confirmationId
    });
    assert.deepEqual(result, { ok: false, action: "thread.delete", threadId: THREAD_ID, status: "pending", deleted: false });
    assert.equal(native.calls.length, 1);
    const records = await ledgerRecords(dataDir);
    assert.equal(records[0].status, "unknown");
    await expectCode(
      service.execute(SCOPE, {
        action: "thread.delete",
        threadId: THREAD_ID,
        params: { confirmationText: THREAD_ID },
        requestId,
        confirmationId: prepared.confirmationId
      }),
      503,
      "NATIVE_OUTCOME_UNKNOWN"
    );
    assert.equal(native.calls.length, 1);
  }

  const ambiguousResponses = [() => mcpText({ ok: true }), () => mcpText({ status: "done" }), () => mcpRawText("Chat deleted")];
  for (const [index, response] of ambiguousResponses.entries()) {
    const tools = { delete_thread: response };
    const { service, native } = await serviceFor(t, { tools });
    const prepared = await service.prepareConfirmation(SCOPE, {
      action: "thread.delete",
      threadId: THREAD_ID,
      params: { confirmationText: THREAD_ID }
    });
    const result = await service.execute(SCOPE, {
      action: "thread.delete",
      threadId: THREAD_ID,
      params: { confirmationText: THREAD_ID },
      requestId: `req-delete-unknown-${index}`,
      confirmationId: prepared.confirmationId
    });
    assert.deepEqual(result, { ok: false, action: "thread.delete", threadId: THREAD_ID, status: "unknown", deleted: false });
    assert.equal(Object.hasOwn(result, "deleted") && result.deleted, false);
    assert.equal(native.calls.length, 1);
  }
});

// ---------------------------------------------------------------------------------------------
// Confirmation receipts: single use, exact binding, stale state.
// ---------------------------------------------------------------------------------------------

test("confirmation receipts are single use and bound to principal, action, thread, params, and state", async t => {
  // Params digest mismatch: a released ledger still allows a correct retry of the same request id.
  {
    const tools = { delete_thread: () => mcpText({ status: "deleted", deleted: true }) };
    const { service, native } = await serviceFor(t, { tools });
    const prepared = await service.prepareConfirmation(SCOPE, {
      action: "thread.delete",
      threadId: THREAD_ID,
      params: { confirmationText: THREAD_ID }
    });
    await expectCode(
      service.execute(SCOPE, {
        action: "thread.delete",
        threadId: THREAD_ID,
        params: { confirmationText: "Original chat" },
        requestId: "req-conf-params",
        confirmationId: prepared.confirmationId
      }),
      409,
      "CONFIRMATION_PARAMS_MISMATCH"
    );
    assert.equal(native.calls.length, 0);
    const retried = await service.execute(SCOPE, {
      action: "thread.delete",
      threadId: THREAD_ID,
      params: { confirmationText: THREAD_ID },
      requestId: "req-conf-params",
      confirmationId: prepared.confirmationId
    });
    assert.equal(retried.ok, true);
    assert.equal(native.calls.length, 1);
  }

  // Thread binding.
  {
    const threads = threadsFixture({ [OTHER_THREAD_ID]: threadRecord(OTHER_THREAD_ID) });
    const tools = { delete_thread: () => mcpText({ status: "deleted", deleted: true }) };
    const { service, native } = await serviceFor(t, { threads, tools });
    const prepared = await service.prepareConfirmation(SCOPE, {
      action: "thread.delete",
      threadId: THREAD_ID,
      params: { confirmationText: THREAD_ID }
    });
    await expectCode(
      service.execute(SCOPE, {
        action: "thread.delete",
        threadId: OTHER_THREAD_ID,
        params: { confirmationText: OTHER_THREAD_ID },
        requestId: "req-conf-target",
        confirmationId: prepared.confirmationId
      }),
      409,
      "CONFIRMATION_TARGET_MISMATCH"
    );
    assert.equal(native.calls.length, 0);
  }

  // Action binding.
  {
    const tools = { share_thread: () => mcpText({ url: SHARE_URL }) };
    const { service, native } = await serviceFor(t, { tools });
    const prepared = await service.prepareConfirmation(SCOPE, {
      action: "thread.delete",
      threadId: THREAD_ID,
      params: { confirmationText: THREAD_ID }
    });
    await expectCode(
      service.execute(SCOPE, {
        action: "thread.share",
        threadId: THREAD_ID,
        params: { reviewed: true },
        requestId: "req-conf-action",
        confirmationId: prepared.confirmationId
      }),
      409,
      "CONFIRMATION_ACTION_MISMATCH"
    );
    assert.equal(native.calls.length, 0);
  }

  // State binding: the receipt is stale once the thread state changes.
  {
    const threads = threadsFixture();
    const tools = { share_thread: () => mcpText({ url: SHARE_URL }) };
    const { service, native } = await serviceFor(t, { threads, tools });
    const prepared = await service.prepareConfirmation(SCOPE, {
      action: "thread.share",
      threadId: THREAD_ID,
      params: { reviewed: true }
    });
    threads[THREAD_ID].status = "archived";
    await expectCode(
      service.execute(SCOPE, {
        action: "thread.share",
        threadId: THREAD_ID,
        params: { reviewed: true },
        requestId: "req-conf-stale",
        confirmationId: prepared.confirmationId
      }),
      409,
      "CONFIRMATION_STALE"
    );
    assert.equal(native.calls.length, 0);
  }

  // Single use.
  {
    const tools = { share_thread: () => mcpText({ url: SHARE_URL }) };
    const { service, native } = await serviceFor(t, { tools });
    const prepared = await service.prepareConfirmation(SCOPE, {
      action: "thread.share",
      threadId: THREAD_ID,
      params: { reviewed: true }
    });
    await service.execute(SCOPE, {
      action: "thread.share",
      threadId: THREAD_ID,
      params: { reviewed: true },
      requestId: "req-conf-once-1",
      confirmationId: prepared.confirmationId
    });
    await expectCode(
      service.execute(SCOPE, {
        action: "thread.share",
        threadId: THREAD_ID,
        params: { reviewed: true },
        requestId: "req-conf-once-2",
        confirmationId: prepared.confirmationId
      }),
      409,
      "CONFIRMATION_REPLAY"
    );
    assert.equal(native.calls.length, 1);
  }

  // Principal binding.
  {
    const tools = { share_thread: () => mcpText({ url: SHARE_URL }) };
    const { service, native } = await serviceFor(t, { tools });
    const prepared = await service.prepareConfirmation(SCOPE, {
      action: "thread.share",
      threadId: THREAD_ID,
      params: { reviewed: true }
    });
    await expectCode(
      service.execute(OTHER_SCOPE, {
        action: "thread.share",
        threadId: THREAD_ID,
        params: { reviewed: true },
        requestId: "req-conf-principal",
        confirmationId: prepared.confirmationId
      }),
      403,
      "CONFIRMATION_PRINCIPAL_MISMATCH"
    );
    assert.equal(native.calls.length, 0);
  }

  // Receipts are only minted for confirmation actions.
  {
    const { service } = await serviceFor(t);
    await expectCode(
      service.execute(SCOPE, { action: "thread.share", threadId: THREAD_ID, params: { reviewed: true }, requestId: "req-conf-missing" }),
      400,
      "CONFIRMATION_REQUIRED"
    );
    await expectCode(
      service.prepareConfirmation(SCOPE, { action: "thread.read", threadId: THREAD_ID, params: {} }),
      400,
      "CONFIRMATION_NOT_REQUIRED"
    );
    await expectCode(
      service.prepareConfirmation(SCOPE, { action: "thread.nope", threadId: THREAD_ID, params: {} }),
      400,
      "UNKNOWN_ACTION"
    );
    await expectCode(
      service.prepareConfirmation(SCOPE, { action: "thread.share", threadId: THREAD_ID, params: { reviewed: false } }),
      400,
      "REVIEW_REQUIRED"
    );
  }
});

test("a request id cannot be rebound to different params after a successful mutation", async t => {
  const tools = { delete_thread: () => mcpText({ status: "deleted", deleted: true }) };
  const { service, native } = await serviceFor(t, { tools });

  const prepared = await service.prepareConfirmation(SCOPE, {
    action: "thread.delete",
    threadId: THREAD_ID,
    params: { confirmationText: THREAD_ID }
  });
  await service.execute(SCOPE, {
    action: "thread.delete",
    threadId: THREAD_ID,
    params: { confirmationText: THREAD_ID },
    requestId: "req-digest",
    confirmationId: prepared.confirmationId
  });
  assert.equal(native.calls.length, 1);

  const preparedAgain = await service.prepareConfirmation(SCOPE, {
    action: "thread.delete",
    threadId: THREAD_ID,
    params: { confirmationText: "Original chat" }
  });
  await expectCode(
    service.execute(SCOPE, {
      action: "thread.delete",
      threadId: THREAD_ID,
      params: { confirmationText: "Original chat" },
      requestId: "req-digest",
      confirmationId: preparedAgain.confirmationId
    }),
    409,
    "REQUEST_ID_CONFLICT"
  );
  assert.equal(native.calls.length, 1);
});

// ---------------------------------------------------------------------------------------------
// Native failures.
// ---------------------------------------------------------------------------------------------

test("native failures are typed and never leak raw payloads", async t => {
  {
    const tools = { list_projects: () => mcpError() };
    const { service } = await serviceFor(t, { tools });
    await expectCode(
      service.execute(SCOPE, { action: "thread.project.list", threadId: THREAD_ID, params: {} }),
      502,
      "NATIVE_TOOL_ERROR"
    );
  }
  {
    const tools = { list_projects: () => ({ isError: false, content: [] }) };
    const { service } = await serviceFor(t, { tools });
    await expectCode(
      service.execute(SCOPE, { action: "thread.project.list", threadId: THREAD_ID, params: {} }),
      502,
      "NATIVE_INVALID_RESULT"
    );
  }
  {
    const tools = {
      list_projects: () => {
        throw Object.assign(new Error("method not found"), { code: "-32601" });
      }
    };
    const { service } = await serviceFor(t, { tools });
    await expectCode(
      service.execute(SCOPE, { action: "thread.project.list", threadId: THREAD_ID, params: {} }),
      501,
      "NATIVE_UNSUPPORTED"
    );
  }
  {
    const tools = { list_projects: () => mcpRawText("not json") };
    const { service } = await serviceFor(t, { tools });
    await expectCode(
      service.execute(SCOPE, { action: "thread.project.list", threadId: THREAD_ID, params: {} }),
      501,
      "NATIVE_UNSUPPORTED"
    );
  }
});
