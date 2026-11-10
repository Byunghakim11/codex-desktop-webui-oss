import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildHeartbeatRrule,
  createHeartbeatService,
  extractAutomationMetadata,
  intervalMinutesFromRrule,
  parseAutomationToml,
  readAutomationIndex
} from "../server/native-heartbeats.js";

const THREAD_ID = "thread-1";
const OTHER_THREAD_ID = "thread-2";
const THREAD = { id: THREAD_ID, cwd: "C:\\work\\project" };
const SCOPE = { id: "scope-1", authMode: "token", tokenHash: "d".repeat(64) };
const clone = value => JSON.parse(JSON.stringify(value));

async function tempDir(t, prefix = "native-heartbeats-") {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return dir;
}

function record(overrides = {}) {
  return {
    id: "auto-1",
    name: "Morning check",
    prompt: "Review the build and summarize failures",
    rrule: "FREQ=MINUTELY;INTERVAL=30",
    status: "ACTIVE",
    kind: "heartbeat",
    destination: "thread",
    targetThreadId: THREAD_ID,
    notificationPolicy: null,
    ...overrides
  };
}

function fakeAutomation({ records = [record()], createError = null } = {}) {
  const calls = [];
  const map = new Map(records.map(entry => [entry.id, clone(entry)]));
  let created = 0;
  async function callNative(method, params) {
    if (method !== "mcpServer/tool/call") throw Object.assign(new Error("method not found"), { code: "-32601" });
    calls.push(clone(params));
    const args = params.arguments;
    if (args.mode === "create") {
      if (createError) throw createError;
      created += 1;
      const id = `auto-new-${created}`;
      const next = {
        id,
        name: args.name,
        prompt: args.prompt,
        rrule: args.rrule,
        status: args.status,
        kind: "heartbeat",
        destination: "thread",
        targetThreadId: args.targetThreadId,
        notificationPolicy: Object.hasOwn(args, "notificationPolicy") ? args.notificationPolicy : null
      };
      map.set(id, next);
      return { isError: false, content: [{ type: "text", text: JSON.stringify({ id }) }] };
    }
    if (args.mode === "view") {
      const existing = map.get(args.id);
      if (!existing) throw Object.assign(new Error("automation not found"), { code: "-32004" });
      return { isError: false, content: [{ type: "text", text: JSON.stringify(existing) }] };
    }
    if (args.mode === "update") {
      const existing = map.get(args.id);
      if (!existing) throw Object.assign(new Error("automation not found"), { code: "-32004" });
      const next = { ...existing, ...clone(args) };
      delete next.mode;
      map.set(args.id, next);
      return { isError: false, content: [{ type: "text", text: JSON.stringify({ id: args.id }) }] };
    }
    if (args.mode === "delete") {
      map.delete(args.id);
      return { isError: false, content: [{ type: "text", text: "Deleted automation" }] };
    }
    throw new Error("unexpected automation mode");
  }
  return { call: callNative, calls, map };
}

async function serviceFor(t, { native = fakeAutomation(), dataDir, codexHome = "", listHeartbeatRecords = null, authorizeThread = null } = {}) {
  const dir = dataDir || await tempDir(t);
  const service = createHeartbeatService({
    callNative: native.call,
    authorizeThread: authorizeThread || (async (scope, threadId) => (threadId === THREAD_ID ? THREAD : null)),
    dataDir: dir,
    codexHome,
    listHeartbeatRecords
  });
  return { service, native, dir };
}

const createCalls = native => native.calls.filter(params => params.tool === "automation_update" && params.arguments.mode === "create");
const updateCalls = native => native.calls.filter(params => params.tool === "automation_update" && params.arguments.mode === "update");
const deleteCalls = native => native.calls.filter(params => params.tool === "automation_update" && params.arguments.mode === "delete");
const mutationCalls = native => native.calls.filter(params => params.tool === "automation_update" && ["create", "update", "delete"].includes(params.arguments.mode));
const denied = error => error.status === 403;
const revokedError = () => Object.assign(new Error("scope revoked"), { status: 403, code: "SCOPE_REVOKED" });

// Wraps a fake native transport so a simulated revocation fires while the service awaits a view.
function revocableNative({ revokeOnView = true } = {}) {
  const native = fakeAutomation();
  const base = native.call;
  const state = { revoked: false, revokeOnView };
  native.call = async (method, params) => {
    if (state.revokeOnView && params?.arguments?.mode === "view") state.revoked = true;
    return base(method, params);
  };
  return { native, state };
}

test("heartbeat RRULEs are derived from bounded human minute intervals", () => {
  assert.equal(buildHeartbeatRrule(1), "FREQ=MINUTELY;INTERVAL=1");
  assert.equal(buildHeartbeatRrule(30), "FREQ=MINUTELY;INTERVAL=30");
  assert.equal(buildHeartbeatRrule(59), "FREQ=MINUTELY;INTERVAL=59");
  assert.equal(buildHeartbeatRrule(60), "FREQ=HOURLY;INTERVAL=1");
  assert.equal(buildHeartbeatRrule(120), "FREQ=HOURLY;INTERVAL=2");
  assert.equal(buildHeartbeatRrule(1440), "FREQ=DAILY");
  for (const value of [0, 1441, -1, 1.5, "30", null]) assert.throws(() => buildHeartbeatRrule(value), error => error.status === 400);
  assert.equal(intervalMinutesFromRrule("FREQ=MINUTELY;INTERVAL=45"), 45);
  assert.equal(intervalMinutesFromRrule("FREQ=HOURLY;INTERVAL=3"), 180);
  assert.equal(intervalMinutesFromRrule("FREQ=DAILY"), 1440);
  assert.equal(intervalMinutesFromRrule("FREQ=WEEKLY;BYDAY=MO"), null);
});

test("create sends heartbeat automation_update fields and returns no prompt or raw rrule", async t => {
  const { service, native } = await serviceFor(t);
  const result = await service.create(SCOPE, {
    threadId: THREAD_ID,
    params: { name: "Check build", prompt: "Summarize failures", intervalMinutes: 30, notificationPolicy: "failed_runs_only" },
    requestId: "req-1"
  });
  assert.equal(result.replayed, false);
  assert.deepEqual(result.heartbeat, {
    id: "auto-new-1",
    name: "Check build",
    status: "ACTIVE",
    kind: "heartbeat",
    intervalMinutes: 30,
    notificationPolicy: "failed_runs_only",
    targetThreadId: THREAD_ID,
    source: "native"
  });
  const text = JSON.stringify(result);
  assert.equal(text.includes("FREQ="), false);
  assert.equal(text.includes("Summarize failures"), false);

  const [call] = createCalls(native);
  assert.equal(call.server, "codex_app");
  assert.equal(call.threadId, THREAD_ID);
  assert.equal(call.tool, "automation_update");
  assert.deepEqual(call.arguments, {
    name: "Check build",
    prompt: "Summarize failures",
    rrule: "FREQ=MINUTELY;INTERVAL=30",
    status: "ACTIVE",
    kind: "heartbeat",
    mode: "create",
    destination: "thread",
    targetThreadId: THREAD_ID,
    notificationPolicy: "failed_runs_only"
  });
  assert.equal(Object.hasOwn(call, "_meta"), false);
  assert.equal(Object.hasOwn(call.arguments, "hostId"), false);
});

test("create requestId replays the stored result and never duplicates a loop", async t => {
  const { service, native } = await serviceFor(t);
  const params = { name: "Check build", prompt: "Summarize failures", intervalMinutes: 60 };
  const first = await service.create(SCOPE, { threadId: THREAD_ID, params, requestId: "req-1" });
  const second = await service.create(SCOPE, { threadId: THREAD_ID, params, requestId: "req-1" });
  assert.equal(second.replayed, true);
  assert.deepEqual(second.heartbeat, first.heartbeat);
  assert.equal(createCalls(native).length, 1);
});

test("concurrent creates reserve the request id before asynchronous persistence",async t=>{
  const {service,native}=await serviceFor(t);
  const request={threadId:THREAD_ID,requestId:"same-concurrent-id",params:{name:"Synthetic only",prompt:"Synthetic loop",intervalMinutes:60}};
  const results=await Promise.allSettled(Array.from({length:8},()=>service.create(SCOPE,request)));
  assert.equal(results.filter(row=>row.status==="fulfilled").length,1);
  assert.equal(createCalls(native).length,1);
  assert.ok(results.filter(row=>row.status==="rejected").every(row=>row.reason.code==="REQUEST_IN_FLIGHT"));
});

test("distinct concurrent creates retain every replay record",async t=>{
  const {service,native}=await serviceFor(t);
  const requests=Array.from({length:8},(_,index)=>({threadId:THREAD_ID,requestId:`distinct-${index}`,params:{name:`Synthetic ${index}`,prompt:'Synthetic only',intervalMinutes:60}}));
  await Promise.all(requests.map(request=>service.create(SCOPE,request)));
  assert.equal(createCalls(native).length,8);
  const replays=await Promise.all(requests.map(request=>service.create(SCOPE,request)));
  assert.ok(replays.every(result=>result.replayed));assert.equal(createCalls(native).length,8);
});

test("unknown create outcome is persisted and never auto-retried", async t => {
  const native = fakeAutomation({
    createError: { isError: true, content: [{ type: "text", text: "internal error" }] }
  });
  const { service } = await serviceFor(t, { native });
  const params = { name: "Check build", prompt: "Summarize failures", intervalMinutes: 5 };
  await assert.rejects(
    service.create(SCOPE, { threadId: THREAD_ID, params, requestId: "req-unknown" }),
    error => error.status === 503 && error.code === "NATIVE_OUTCOME_UNKNOWN" && error.retryable === false
  );
  await assert.rejects(
    service.create(SCOPE, { threadId: THREAD_ID, params, requestId: "req-unknown" }),
    error => error.status === 503 && error.code === "NATIVE_OUTCOME_UNKNOWN"
  );
  assert.equal(createCalls(native).length, 1);
});

test("pause preserves a custom existing RRULE and full view fields", async t => {
  const native = fakeAutomation({ records: [record({ rrule: "FREQ=WEEKLY;BYDAY=MO", status: "ACTIVE" })] });
  const { service } = await serviceFor(t, { native });
  const result = await service.setStatus(SCOPE, { threadId: THREAD_ID, params: { id: "auto-1" }, status: "PAUSED" });
  assert.equal(result.heartbeat.status, "PAUSED");
  assert.equal(result.heartbeat.intervalMinutes, null);
  const [call] = updateCalls(native);
  assert.deepEqual(call.arguments, {
    name: "Morning check",
    prompt: "Review the build and summarize failures",
    rrule: "FREQ=WEEKLY;BYDAY=MO",
    status: "PAUSED",
    kind: "heartbeat",
    mode: "update",
    id: "auto-1",
    destination: "thread",
    targetThreadId: THREAD_ID,
    notificationPolicy: null
  });
});

test("update rebuilds RRULE from a human interval and keeps unrelated fields", async t => {
  const { service, native } = await serviceFor(t);
  const result = await service.update(SCOPE, { threadId: THREAD_ID, params: { id: "auto-1", intervalMinutes: 120 } });
  assert.equal(result.heartbeat.intervalMinutes, 120);
  const [call] = updateCalls(native);
  assert.equal(call.arguments.rrule, "FREQ=HOURLY;INTERVAL=2");
  assert.equal(call.arguments.name, "Morning check");
  assert.equal(call.arguments.prompt, "Review the build and summarize failures");
});

test("an automation id bound to another thread is rejected before any mutation", async t => {
  const native = fakeAutomation({ records: [record({ targetThreadId: OTHER_THREAD_ID })] });
  const { service } = await serviceFor(t, { native });
  await assert.rejects(
    service.setStatus(SCOPE, { threadId: THREAD_ID, params: { id: "auto-1" }, status: "PAUSED" }),
    error => error.status === 403 && error.code === "TARGET_MISMATCH"
  );
  await assert.rejects(
    service.view(SCOPE, { threadId: THREAD_ID, params: { id: "auto-1" } }),
    error => error.status === 403 && error.code === "TARGET_MISMATCH"
  );
  assert.deepEqual(updateCalls(native), []);
  assert.equal(native.calls.filter(call => call.arguments.mode === "view").every(call => call.arguments.id === "auto-1"), true);
});

test("a scope revoked while the native view is in flight denies pause, update and delete", async t => {
  for (const operation of ["pause", "update", "delete"]) {
    const { native, state } = revocableNative();
    let authorizeAttempts = 0;
    const authorizeThread = async (scope, threadId) => {
      if (threadId !== THREAD_ID) return null;
      authorizeAttempts += 1;
      if (state.revoked) throw revokedError();
      return THREAD;
    };
    const { service } = await serviceFor(t, { native, authorizeThread });
    let expectedState;
    if (operation === "delete") {
      state.revokeOnView = false;
      expectedState = await service.confirmationState(SCOPE, { threadId: THREAD_ID, params: { id: "auto-1" } });
      state.revokeOnView = true;
      authorizeAttempts = 0;
    }
    const run = {
      pause: () => service.setStatus(SCOPE, { threadId: THREAD_ID, params: { id: "auto-1" }, status: "PAUSED" }),
      update: () => service.update(SCOPE, { threadId: THREAD_ID, params: { id: "auto-1", intervalMinutes: 60 } }),
      delete: () => service.remove(SCOPE, { threadId: THREAD_ID, params: { id: "auto-1" }, expectedState })
    }[operation];
    await assert.rejects(run(), denied, `${operation} must be denied once the scope is revoked`);
    assert.deepEqual(mutationCalls(native), [], `${operation} must not emit a native mutation`);
    assert.equal(authorizeAttempts, 2, `${operation} must re-authorize immediately before the mutation`);
    assert.equal(native.map.has("auto-1"), true, `${operation} must leave the native automation untouched`);
  }
});

test("a revoked scope after the create intent is persisted never emits a native create", async t => {
  const native = fakeAutomation();
  let authorizeAttempts = 0;
  const authorizeThread = async (scope, threadId) => {
    if (threadId !== THREAD_ID) return null;
    authorizeAttempts += 1;
    if (authorizeAttempts === 2) throw revokedError();
    return THREAD;
  };
  const { service, dir } = await serviceFor(t, { native, authorizeThread });
  const params = { name: "Check build", prompt: "Summarize failures", intervalMinutes: 30 };
  await assert.rejects(service.create(SCOPE, { threadId: THREAD_ID, params, requestId: "req-revoked" }), denied);
  assert.equal(authorizeAttempts, 2);
  assert.equal(createCalls(native).length, 0);
  assert.deepEqual(mutationCalls(native), []);
  const requests = JSON.parse(await fs.readFile(path.join(dir, "native-heartbeats", "requests.json"), "utf8"));
  assert.equal(requests.requests["req-revoked"].status, "unknown");
  assert.equal(Object.hasOwn(requests.requests["req-revoked"], "heartbeat"), false);
  await assert.rejects(
    service.create(SCOPE, { threadId: THREAD_ID, params, requestId: "req-revoked" }),
    error => error.status === 503 && error.code === "NATIVE_OUTCOME_UNKNOWN" && error.retryable === false
  );
  assert.equal(createCalls(native).length, 0);
  assert.deepEqual(mutationCalls(native), []);
});

test("a thread cwd change while the native view is in flight blocks stale loop mutation", async t => {
  for (const operation of ["update", "delete"]) {
    const native = fakeAutomation();
    let authorizeAttempts = 0;
    const authorizeThread = async (scope, threadId) => {
      if (threadId !== THREAD_ID) return null;
      authorizeAttempts += 1;
      return authorizeAttempts === 1 ? THREAD : { ...THREAD, cwd: "C:\\work\\relocated" };
    };
    const { service } = await serviceFor(t, { native, authorizeThread });
    let expectedState;
    if (operation === "delete") {
      expectedState = await service.confirmationState(SCOPE, { threadId: THREAD_ID, params: { id: "auto-1" } });
      // The fixture changes cwd during this mutation's fresh read, rather than
      // counting the earlier confirmation read as the mutation's first check.
      authorizeAttempts = 0;
    }
    const run = {
      update: () => service.update(SCOPE, { threadId: THREAD_ID, params: { id: "auto-1", intervalMinutes: 60 } }),
      delete: () => service.remove(SCOPE, { threadId: THREAD_ID, params: { id: "auto-1" }, expectedState })
    }[operation];
    await assert.rejects(run(), error => error.status === 409, `${operation} must refuse a stale loop context`);
    assert.deepEqual(mutationCalls(native), [], `${operation} must not mutate the relocated thread context`);
    assert.equal(native.map.get("auto-1").rrule, "FREQ=MINUTELY;INTERVAL=30");
    assert.equal(native.map.get("auto-1").status, "ACTIVE");
    assert.equal(authorizeAttempts >= 2, true, `${operation} must re-check the authorized thread before mutating`);
  }
});

test("delete requires a state binding and removes the local id registry entry", async t => {
  const { service, native } = await serviceFor(t);
  await assert.rejects(
    service.remove(SCOPE, { threadId: THREAD_ID, params: { id: "auto-1" }, expectedState: "f".repeat(64) }),
    error => error.status === 409 && error.code === "CONFIRMATION_STALE"
  );
  assert.equal(native.calls.some(call => call.arguments.mode === "delete"), false);
  const state = await service.confirmationState(SCOPE, { threadId: THREAD_ID, params: { id: "auto-1" } });
  const result = await service.remove(SCOPE, { threadId: THREAD_ID, params: { id: "auto-1" }, expectedState: state });
  assert.deepEqual(result, { deleted: true, id: "auto-1" });
});

test("the native index is read-only and filters to the authorized thread only", async t => {
  const codexHome = await tempDir(t, "native-codex-home-");
  async function writeAutomation(dir, body) {
    const target = path.join(codexHome, "automations", dir);
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, "automation.toml"), body, "utf8");
  }
  await writeAutomation("auto-1", [
    'name = "Morning check"',
    'prompt = """Line one',
    'Line two \\"quoted\\" and \\u00e9"""',
    'rrule = "FREQ=MINUTELY;INTERVAL=15"',
    'status = "ACTIVE"',
    'kind = "heartbeat"',
    `targetThreadId = "${THREAD_ID}"`,
    'notificationPolicy = "failed_runs_only"'
  ].join("\n"));
  await writeAutomation("auto-2", [
    'name = "Other thread loop"',
    'prompt = "do not leak"',
    'rrule = "FREQ=MINUTELY;INTERVAL=5"',
    'status = "PAUSED"',
    'kind = "heartbeat"',
    `targetThreadId = "${OTHER_THREAD_ID}"`
  ].join("\n"));

  const before = await snapshot(codexHome);
  const { service } = await serviceFor(t, { codexHome });
  const result = await service.list(SCOPE, { threadId: THREAD_ID });
  assert.equal(result.complete, false);
  assert.deepEqual(result.heartbeats, [{
    id: "auto-1",
    name: "Morning check",
    status: "ACTIVE",
    kind: "heartbeat",
    intervalMinutes: 15,
    targetThreadId: THREAD_ID,
    source: "index"
  }]);
  const text = JSON.stringify(result);
  assert.equal(text.includes("do not leak"), false);
  assert.equal(text.includes("FREQ="), false);
  assert.equal(text.includes("OTHER"), false);
  assert.deepEqual(await snapshot(codexHome), before);
});

async function snapshot(root) {
  const output = [];
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      output.push(path.relative(root, full));
      if (entry.isDirectory()) await walk(full);
    }
  }
  await walk(root);
  return output.sort();
}

test("unsupported TOML fails closed instead of risking a misparse", async t => {
  const codexHome = await tempDir(t, "native-codex-home-bad-");
  const target = path.join(codexHome, "automations", "auto-bad");
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(path.join(target, "automation.toml"), 'when = 2026-01-01T00:00:00Z\n', "utf8");
  await assert.rejects(
    readAutomationIndex({ codexHome }),
    error => error.code === "HEARTBEAT_INDEX_UNSUPPORTED" && error.status === 500
  );
  const { service } = await serviceFor(t, { codexHome });
  await assert.rejects(service.list(SCOPE, { threadId: THREAD_ID }), error => error.code === "HEARTBEAT_INDEX_UNSUPPORTED");
});

test("injected listHeartbeatRecords is structurally validated for tests", async t => {
  const seen = [];
  const { service } = await serviceFor(t, {
    listHeartbeatRecords: async ({ threadId }) => {
      seen.push(threadId);
      return [
        { id: "auto-9", name: "Injected", status: "PAUSED", kind: "heartbeat", targetThreadId: THREAD_ID, prompt: "hidden", rrule: "FREQ=MINUTELY;INTERVAL=9" },
        { id: "auto-10", name: "Other", status: "ACTIVE", kind: "heartbeat", targetThreadId: OTHER_THREAD_ID },
        { id: "auto-11", name: "Cron", status: "ACTIVE", kind: "cron", targetThreadId: THREAD_ID }
      ];
    }
  });
  const result = await service.list(SCOPE, { threadId: THREAD_ID });
  assert.deepEqual(seen, [THREAD_ID]);
  assert.equal(result.heartbeats.length, 1);
  assert.equal(result.heartbeats[0].id, "auto-9");
  assert.equal(JSON.stringify(result).includes("hidden"), false);
});

test("a stored WebUI id complements but does not claim native completeness", async t => {
  const { service, native, dir } = await serviceFor(t);
  await service.create(SCOPE, {
    threadId: THREAD_ID,
    params: { name: "WebUI loop", prompt: "Check status", intervalMinutes: 10 },
    requestId: "req-registry"
  });
  assert.equal(native.map.size, 2);
  const listed = await service.list(SCOPE, { threadId: THREAD_ID });
  const entry = listed.heartbeats.find(item => item.id === "auto-new-1");
  assert.equal(entry.source, "webui-registry");
  assert.equal(entry.status, null);
  assert.equal(listed.complete, false);
  const ids = JSON.parse(await fs.readFile(path.join(dir, "native-heartbeats", "ids.json"), "utf8"));
  assert.equal(ids.ids["auto-new-1"].threadId, THREAD_ID);
});

test("TOML parser handles complete escaped and triple-quoted strings", () => {
  const text = [
    "# leading comment",
    'name = "A \\"quoted\\" \\u00e9 \\U0001F600"',
    'literal = \'C:\\raw\\path\'',
    'flags = [1, 2, 3]',
    'enabled = true',
    '[automation]',
    "prompt = '''line1",
    "line2'''",
    'rrule = "FREQ=MINUTELY;INTERVAL=5"',
    'status = "PAUSED"',
    'kind = "heartbeat"',
    'targetThreadId = "thread-1"',
    'nested.key = "dotted"'
  ].join("\n");
  const parsed = parseAutomationToml(text);
  assert.equal(parsed.name, "A \"quoted\" \u00e9 \u{1F600}");
  assert.equal(parsed.literal, "C:\\raw\\path");
  assert.deepEqual(parsed.flags, [1, 2, 3]);
  assert.equal(parsed.enabled, true);
  assert.equal(parsed.automation.prompt, "line1\nline2");
  assert.equal(parsed.automation.status, "PAUSED");
  assert.equal(parsed.automation.nested.key, "dotted");
  assert.equal(Object.getPrototypeOf(parsed), null);

  const meta = extractAutomationMetadata(parsed, "dir-id");
  assert.equal(meta.id, "dir-id");
  assert.equal(meta.targetThreadId, THREAD_ID);

  for (const bad of [
    'a = "unterminated',
    "a = 1\na = 2\n",
    "[[array_table]]\na = 1\n",
    "__proto__ = 1\n",
    "a = {x = 1}\n",
    "a = 0x10\n",
    "a = 1.5\n",
    'a = "bad \\q escape"\n',
    "[unclosed\na = 1\n"
  ]) {
    assert.throws(() => parseAutomationToml(bad), error => error.code === "HEARTBEAT_INDEX_UNSUPPORTED", bad);
  }
});

test("no timer-based scheduler is created by the heartbeat module", async () => {
  const source = await fs.readFile(new URL("../server/native-heartbeats.js", import.meta.url), "utf8");
  assert.equal(source.includes("setInterval"), false);
  assert.equal(source.includes("setTimeout"), false);
  assert.equal(source.includes("cron"), false);
});
