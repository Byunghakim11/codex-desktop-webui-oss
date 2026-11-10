import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProjectWriteContexts } from "../server/project-write-context.js";
import { ProjectWrites, WRITE_LIMITS } from "../server/project-writes.js";

const ROOT = "C:\\project";
const ROOT_ID = "10-20-30";
const PARENT_ID = "40-50-60";
const REV = "a".repeat(64);
const VERSION_A = `v1.1-2-3.${"b".repeat(64)}`;
const VERSION_B = `v1.1-2-4.${"c".repeat(64)}`;
const RECOVERY_ID = "d".repeat(64);
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const opId = index => index.toString(16).padStart(32, "0");
const tick = () => new Promise(resolve => setImmediate(resolve));

test('unknown saves retain their payload fingerprint and reject changed replay bytes',async t=>{
 const writer=recordingWriter({onResult:()=>{throw Object.assign(Error('unknown'),{status:504,code:'COMMIT_UNKNOWN'});}});
 const env=await setup(t,{writer});const ctx=await env.issue('');
 const call=text=>env.writes.saveText({resolveScope:scopeA,contextId:ctx.contextId,path:'unknown.md',operationId:opId(801),text,expectedVersion:VERSION_A});
 assert.equal((await call('first')).status,'unknown');
 await assert.rejects(call('second'),error=>error.code==='OPERATION_CONFLICT');
 assert.equal((await call('first')).status,'unknown');assert.equal(writer.calls.length,1);
});

test('retained stages stay quota charged per owner across a service restart',async t=>{
 const writer=recordingWriter({onResult:()=>{throw Object.assign(Error('unknown'),{status:504,code:'COMMIT_UNKNOWN'});}});
 const env=await setup(t,{writer});const ctxA=await env.issue('');
 const scopeB=()=>({...scopeA(),id:'other-owner',tokenHash:'other-token',accessEmail:'b@example.com'});
 const ctxB=await env.issue('',scopeB);
 const call=(service,resolveScope,context,index)=>service.upload({resolveScope,contextId:context.contextId,path:`retained-${index}.bin`,operationId:opId(900+index),declaredSize:1,stream:(async function*(){yield Buffer.from('x');})()});
 for(let i=0;i<4;i++)assert.equal((await call(env.writes,scopeA,ctxA,i)).status,'unknown');
 await assert.rejects(call(env.writes,scopeA,ctxA,5),error=>error.code==='STAGE_BUSY');
 assert.equal((await call(env.writes,scopeB,ctxB,6)).status,'unknown');
 const restarted=new ProjectWrites({contexts:env.contexts,runWriter:writer,dataDir:env.dataDir});
 await assert.rejects(call(restarted,scopeA,ctxA,7),error=>error.code==='STAGE_BUSY');
 assert.equal((await call(restarted,scopeB,ctxB,8)).status,'unknown');
});

test('a stream exceeding its declared reservation is stopped immediately',async t=>{
 const env=await setup(t);const ctx=await env.issue('');let continued=false;
 const stream=(async function*(){yield Buffer.alloc(512*1024);continued=true;yield Buffer.from('extra');})();
 await assert.rejects(env.writes.upload({resolveScope:scopeA,contextId:ctx.contextId,path:'overspend.bin',operationId:opId(999),declaredSize:1,stream}),error=>error.code==='SIZE_MISMATCH');
 assert.equal(continued,false);assert.equal(env.runWriter.calls.length,0);assert.deepEqual(await env.list(env.staging),[]);
});

const scopeA = () => ({ id: "owner", authMode: "cloudflare-access", accessEmail: "a@example.com", tokenHash: "tok-a" });

function makeFiles(overrides = {}) {
  const state = { root: ROOT, revision: REV, ...overrides };
  return {
    state,
    async context(_scope, query) {
      return { root: state.byThread?.[query.threadId] || state.root, rootIdentity: ROOT_ID, rootRevision: state.revision, threadId: query.threadId, rootName: "project" };
    }
  };
}

// A scope source whose answer can be revoked mid-flight: a new token hash changes the scope binding
// and therefore makes every later authority check fail closed.
function scoped(source = scopeA) {
  const state = { revoked: false };
  const resolve = async () => (state.revoked ? { ...source(), tokenHash: "tok-revoked" } : source());
  return { state, resolve };
}

// The context operation ("issue") needs its own fake writer: it only has to authorise the prepared
// message and echo identities, exactly like the native helper does.
function issueWriter() {
  const calls = [];
  const writer = async ({ operation, authorizePrepared }) => {
    calls.push(operation);
    const allowed = await authorizePrepared({ operationId: operation.id, kind: operation.kind, relativePath: operation.relativePath, rootIdentity: ROOT_ID, parentIdentity: PARENT_ID });
    if (allowed !== true) throw Object.assign(new Error("AUTHORIZATION_DENIED"), { status: 403, code: "AUTHORIZATION_DENIED" });
    return { path: operation.relativePath, kind: "directory", rootIdentity: ROOT_ID, parentIdentity: PARENT_ID, targetIdentity: PARENT_ID };
  };
  writer.calls = calls;
  return writer;
}

function preparedFor(operation) {
  const prepared = { operationId: operation.id, kind: operation.kind === "mkdir" ? "directory" : "file", relativePath: operation.relativePath, rootIdentity: ROOT_ID, parentIdentity: PARENT_ID };
  if (operation.kind === "save-text") {
    prepared.currentVersion = operation.expectedVersion;
    prepared.newSize = 3;
  }
  if (operation.kind === "edit-open") {
    prepared.size = 3;
    prepared.editable = true;
    prepared.bom = false;
    prepared.eol = "lf";
    prepared.reason = null;
  }
  return prepared;
}

async function fakeResult(operation, extra = {}) {
  const bytes = operation.stagedPath ? await fs.readFile(operation.stagedPath) : Buffer.alloc(0);
  const base = { path: operation.relativePath, kind: operation.kind === "mkdir" ? "directory" : "file", rootIdentity: ROOT_ID, parentIdentity: PARENT_ID, targetIdentity: PARENT_ID, ...extra };
  if (operation.kind === "upload") return { ...base, size: bytes.length, version: VERSION_A };
  if (operation.kind === "save-text") return { ...base, size: bytes.length, version: VERSION_B, bom: false, eol: "lf" };
  if (operation.kind === "edit-open") return { ...base, editable: true, bom: false, eol: "lf", reason: null, version: VERSION_A, text: "hello\n", size: 6 };
  return base;
}

function recordingWriter({ onOperation, onResult = fakeResult } = {}) {
  const calls = [];
  const writer = async ({ dataDir, operation, authorizePrepared }) => {
    calls.push({ dataDir, operation: { ...operation } });
    onOperation?.(operation);
    const allowed = await authorizePrepared(preparedFor(operation));
    if (allowed !== true) throw Object.assign(new Error("AUTHORIZATION_DENIED"), { status: 403, code: "AUTHORIZATION_DENIED" });
    return onResult(operation);
  };
  writer.calls = calls;
  return writer;
}

// A writer whose native call parks until released, so the bounded queue is observable.
function gatedWriter({ onResult = fakeResult } = {}) {
  const calls = [];
  const gates = [];
  let open = false;
  const writer = async ({ operation, authorizePrepared }) => {
    calls.push({ operation: { ...operation } });
    const allowed = await authorizePrepared(preparedFor(operation));
    if (allowed !== true) throw Object.assign(new Error("AUTHORIZATION_DENIED"), { status: 403, code: "AUTHORIZATION_DENIED" });
    await new Promise(resolve => (open ? resolve() : gates.push(resolve)));
    return onResult(operation);
  };
  writer.calls = calls;
  writer.releaseAll = () => {
    open = true;
    for (const gate of gates.splice(0)) gate();
  };
  writer.waitFor = async count => {
    for (let attempt = 0; attempt < 1000; attempt++) {
      if (calls.length >= count) return;
      await new Promise(resolve=>setTimeout(resolve,5));
    }
    throw new Error(`native writer did not reach ${count} calls`);
  };
  return writer;
}

async function setup(t, { writer, files } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "project-writes-"));
  const fileState = files ?? makeFiles();
  const contexts = new ProjectWriteContexts({ files: fileState, runWriter: issueWriter(), dataDir });
  const runWriter = writer ?? recordingWriter();
  const writes = new ProjectWrites({ contexts, runWriter, dataDir });
  const real = await fs.realpath(dataDir);
  t.after(async () => { await fs.rm(dataDir, { recursive: true, force: true }); });
  return {
    dataDir,
    files: fileState,
    contexts,
    writes,
    runWriter,
    staging: path.join(real, "project-writes", "staging"),
    operations: path.join(real, "project-writes", "operations"),
    async list(dir) {
      try { return (await fs.readdir(dir)).sort(); } catch { return []; }
    },
    async issue(parentPath = "", resolveScope = scopeA, threadId = "thread-1") {
      const dto = await writes.issueContext({ resolveScope, query: { threadId, parentPath } });
      fileState.calls = 0;
      return dto;
    }
  };
}

test("constructor requires contexts, runWriter and dataDir", () => {
  const contexts = { issue() {}, get() {} };
  assert.throws(() => new ProjectWrites({ runWriter: () => {}, dataDir: "/tmp" }), TypeError);
  assert.throws(() => new ProjectWrites({ contexts, dataDir: "/tmp" }), TypeError);
  assert.throws(() => new ProjectWrites({ contexts, runWriter: () => {} }), TypeError);
  assert.throws(() => new ProjectWrites({ contexts, runWriter: () => {}, dataDir: "/tmp", now: 1 }), TypeError);
});

test("issueContext returns the authority DTO unchanged", async t => {
  const env = await setup(t);
  const dto = await env.writes.issueContext({ resolveScope: scopeA, query: { threadId: "thread-1", parentPath: "" } });
  assert.match(dto.contextId, /^[0-9a-f]{32}$/);
  assert.equal(dto.threadId, "thread-1");
  assert.equal(dto.rootRevision, REV);
  assert.equal(dto.parentPath, "");
  assert.deepEqual(Object.keys(dto).sort(), ["contextId", "expiresAt", "parentPath", "rootRevision", "threadId"]);
  assert.equal(JSON.stringify(dto).includes(ROOT), false);
});

test("mkdir dispatches the fixed operation shape and a safe DTO", async t => {
  const env = await setup(t);
  const context = await env.issue("");
  const dto = await env.writes.mkdir({ resolveScope: scopeA, contextId: context.contextId, path: "newdir", operationId: opId(1) });
  assert.deepEqual(Object.keys(dto).sort(), ["kind", "operationId", "path", "result", "status"]);
  assert.equal(dto.status, "succeeded");
  assert.equal(dto.kind, "mkdir");
  assert.equal(dto.operationId, opId(1));
  assert.equal(dto.path, "newdir");
  assert.deepEqual(dto.result, {});
  assert.equal(env.runWriter.calls.length, 1);
  const operation = env.runWriter.calls[0].operation;
  assert.deepEqual(Object.keys(operation).sort(), ["id", "kind", "relativePath", "root"]);
  assert.equal(operation.root, ROOT);
  assert.equal(operation.relativePath, "newdir");
  assert.equal(operation.id, opId(1));
  assert.deepEqual(await env.list(env.staging), []);
  // The ledger keeps the binding but never the project root.
  const ledger = await fs.readFile(path.join(env.operations, `${opId(1)}.json`), "utf8");
  assert.equal(JSON.parse(ledger).status, "succeeded");
  assert.equal(ledger.includes(ROOT), false);
  assert.equal(env.runWriter.calls[0].dataDir, env.dataDir);
});

test("upload stages the exact original bytes and reports size and version", async t => {
  const seen = {};
  const writer=recordingWriter({onResult:async operation=>{seen.hash=sha256(await fs.readFile(operation.stagedPath));return fakeResult(operation);}});
  const env = await setup(t,{writer});
  const context = await env.issue("");
  const payload = Buffer.from([0x00, 0x01, 0xfe, 0xff, 0x0a, 0x0d, 0x7f]);
  env.runWriter.calls.length = 0;
  const dto = await env.writes.upload({
    resolveScope: scopeA,
    contextId: context.contextId,
    path: "blob.bin",
    operationId: opId(2),
    stream: (async function* () { yield payload.subarray(0, 3); yield payload.subarray(3); })(),
    declaredSize: payload.length
  });
  assert.equal(dto.status, "succeeded");
  assert.equal(dto.kind, "upload");
  assert.deepEqual(dto.result, { size: payload.length, version: VERSION_A });
  const operation = env.runWriter.calls[0].operation;
  // No overwrite/force/truncate knobs exist in this contract: the helper always creates or replaces
  // under its own rules and only ever receives the staged payload it must hash.
  assert.deepEqual(Object.keys(operation).sort(), ["id", "kind", "relativePath", "root", "stagedHash", "stagedPath"]);
  assert.equal(operation.stagedHash, sha256(payload));
  assert.equal(operation.stagedPath.startsWith(env.staging + path.sep), true);
  assert.match(path.basename(operation.stagedPath), /^[0-9a-f]{64}-[0-9a-f]{32}\.stage$/);
  assert.equal(seen.hash, sha256(payload));
  assert.deepEqual(await env.list(env.staging), []);
});

test("save-text accepts an intentional empty document and forwards the exact version", async t => {
  const env = await setup(t);
  const context = await env.issue("");
  let staged = null;
  const writer = recordingWriter({ onOperation: () => {} });
  env.runWriter.calls.length = 0;
  const original = writer;
  const dto = await new ProjectWrites({ contexts: env.contexts, runWriter: async args => {
    staged = await fs.readFile(args.operation.stagedPath);
    return original(args);
  }, dataDir: env.dataDir }).saveText({ resolveScope: scopeA, contextId: context.contextId, path: "notes.md", operationId: opId(3), text: "", expectedVersion: VERSION_A });
  assert.equal(dto.status, "succeeded");
  assert.equal(dto.kind, "save-text");
  assert.deepEqual(dto.result, { size: 0, version: VERSION_B, bom: false, eol: "lf" });
  assert.equal(staged.length, 0);
  const operation = original.calls[0].operation;
  assert.deepEqual(Object.keys(operation).sort(), ["expectedVersion", "id", "kind", "recoveryBinding", "relativePath", "root", "stagedHash", "stagedPath"]);
  assert.equal(operation.expectedVersion, VERSION_A);
  assert.match(operation.recoveryBinding, /^[0-9a-f]{64}$/);
  assert.equal(operation.stagedHash, sha256(Buffer.alloc(0)));
  assert.deepEqual(await env.list(env.staging), []);
});

test("save-text rejects invalid text before anything durable exists", async t => {
  const env = await setup(t);
  const context = await env.issue("");
  const base = { resolveScope: scopeA, contextId: context.contextId, path: "a.txt", operationId: opId(4), expectedVersion: VERSION_A };
  await assert.rejects(env.writes.saveText({ ...base, text: "a\r\nb" }), { code: "INVALID_TEXT", status: 400 });
  await assert.rejects(env.writes.saveText({ ...base, text: "lone \ud800 surrogate" }), { code: "INVALID_TEXT", status: 400 });
  await assert.rejects(env.writes.saveText({ ...base, text: "\ufeffbody" }), { code: "INVALID_TEXT", status: 400 });
  await assert.rejects(env.writes.saveText({ ...base, text: "a".repeat(WRITE_LIMITS.textBytes + 1) }), { code: "TOO_LARGE", status: 413 });
  await assert.rejects(env.writes.saveText({ ...base, text: "ok", expectedVersion: "v1.bad" }), { code: "INVALID_ARGUMENT", status: 400 });
  assert.equal(env.runWriter.calls.length, 0);
  assert.deepEqual(await env.list(env.staging), []);
  assert.deepEqual(await env.list(env.operations), []);
});

test("only known fields are accepted, so root and stagedPath can never be caller chosen", async t => {
  const env = await setup(t);
  const context = await env.issue("");
  const base = { resolveScope: scopeA, contextId: context.contextId, path: "x", operationId: opId(5) };
  await assert.rejects(env.writes.mkdir({ ...base, root: "C:\\other" }), { code: "INVALID_ARGUMENT", status: 400 });
  await assert.rejects(env.writes.upload({ ...base, stagedPath: "/etc/passwd", stream: (async function* () {})() }), { code: "INVALID_ARGUMENT", status: 400 });
  await assert.rejects(env.writes.upload({ ...base, stream: (async function* () {})(), force: true }), { code: "INVALID_ARGUMENT", status: 400 });
  await assert.rejects(env.writes.mkdir({ ...base, operationId: "nothex" }), { code: "INVALID_OPERATION", status: 400 });
  assert.equal(env.runWriter.calls.length, 0);
});

test("a duplicate operation id is answered from the ledger without re-dispatch", async t => {
  const env = await setup(t);
  const context = await env.issue("");
  const payload = Buffer.from("payload");
  const call = bytes => env.writes.upload({
    resolveScope: scopeA,
    contextId: context.contextId,
    path: "up.bin",
    operationId: opId(6),
    stream: (async function* () { yield bytes; })(),
    declaredSize: bytes.length
  });
  const first = await call(payload);
  assert.equal(first.status, "succeeded");
  assert.equal(env.runWriter.calls.length, 1);
  const replay = await call(payload);
  assert.equal(replay.status, "succeeded");
  assert.equal(replay.cached, true);
  assert.equal(env.runWriter.calls.length, 1);
  // Same id, different bytes: conflict, no second dispatch, and no leftover stage.
  await assert.rejects(call(Buffer.from("other")), { code: "OPERATION_CONFLICT", status: 409 });
  assert.equal(env.runWriter.calls.length, 1);
  assert.deepEqual(await env.list(env.staging), []);
});

test("a replayed save-text with different text conflicts before staging", async t => {
  const env = await setup(t);
  const context = await env.issue("");
  const base = { resolveScope: scopeA, contextId: context.contextId, path: "s.txt", operationId: opId(7), expectedVersion: VERSION_A };
  await env.writes.saveText({ ...base, text: "first" });
  assert.equal(env.runWriter.calls.length, 1);
  const replay = await env.writes.saveText({ ...base, text: "first" });
  assert.equal(replay.cached, true);
  assert.equal(env.runWriter.calls.length, 1);
  await assert.rejects(env.writes.saveText({ ...base, text: "second" }), { code: "OPERATION_CONFLICT", status: 409 });
  assert.equal(env.runWriter.calls.length, 1);
  assert.deepEqual(await env.list(env.staging), []);
});

test("a ledger record left pending by a restart becomes unknown and is never retried", async t => {
  const env = await setup(t);
  const context = await env.issue("");
  const base = { resolveScope: scopeA, contextId: context.contextId, path: "p.txt", operationId: opId(8), expectedVersion: VERSION_A };
  await env.writes.saveText({ ...base, text: "one" });
  const file = path.join(env.operations, `${opId(8)}.json`);
  const record = JSON.parse(await fs.readFile(file, "utf8"));
  await fs.writeFile(file, JSON.stringify({ ...record, status: "committing", result: null }));
  const restartedWriter = recordingWriter();
  const restarted = new ProjectWrites({ contexts: env.contexts, runWriter: restartedWriter, dataDir: env.dataDir });
  const dto = await restarted.saveText({ ...base, text: "one" });
  assert.equal(dto.status, "unknown");
  assert.equal(restartedWriter.calls.length, 0);
  const status = await restarted.operationStatus({ resolveScope: scopeA, operationId: opId(8), contextId: context.contextId, path: "p.txt", kind: "save-text" });
  assert.equal(status.status, "unknown");
});

test("a scope revoked after staging never reaches the native helper and the stage is dropped", async t => {
  const env = await setup(t);
  const authority=scoped();
  const context = await env.issue("",authority.resolve);
  await assert.rejects(env.writes.upload({
    resolveScope: authority.resolve,
    contextId: context.contextId,
    path: "revoked.bin",
    operationId: opId(9),
    stream: (async function* () { yield Buffer.from("payload"); authority.state.revoked=true; })()
  }), { code: "WRITE_CONTEXT_DENIED", status: 403 });
  assert.equal(env.runWriter.calls.length, 0);
  assert.deepEqual(await env.list(env.staging), []);
  const ledger = JSON.parse(await fs.readFile(path.join(env.operations, `${opId(9)}.json`), "utf8"));
  assert.equal(ledger.status, "failed");
  assert.equal(ledger.reason, "WRITE_CONTEXT_DENIED");
});

test("one native operation per root, and a queued caller can cancel before dispatch", async t => {
  const writer = gatedWriter();
  const env = await setup(t, { writer });
  const context = await env.issue("");
  const abort = new AbortController();
  const first = env.writes.upload({ resolveScope: scopeA, contextId: context.contextId, path: "one.bin", operationId: opId(10), stream: (async function* () { yield Buffer.from("a"); })(), declaredSize: 1 });
  first.catch(()=>{});
  t.after(()=>writer.releaseAll());
  await writer.waitFor(1);
  const queued = env.writes.mkdir({ resolveScope: scopeA, contextId: context.contextId, path: "two", operationId: opId(11), signal: abort.signal });
  await tick();
  await tick();
  assert.equal(writer.calls.length, 1); // still serialised behind the same root
  abort.abort();
  await assert.rejects(queued, { code: "CANCELLED", status: 499 });
  assert.equal(writer.calls.length, 1);
  writer.releaseAll();
  assert.equal((await first).status, "succeeded");
  const third = await env.writes.mkdir({ resolveScope: scopeA, contextId: context.contextId, path: "three", operationId: opId(12) });
  assert.equal(third.status, "succeeded");
  assert.equal(writer.calls.length, 2);
});

test("the native queue is bounded to two running and eight waiting", async t => {
  const writer = gatedWriter();
  const env = await setup(t, { writer });
  env.files.state.byThread={"thread-1":"C:\\project-a","thread-2":"C:\\project-b"};
  const contextA = await env.issue("");
  const contextB = await env.issue("",scopeA,"thread-2");
  let serial=100;
  const tracked=[];
  const run = (context, index, fileName) => {
    const operationId=opId(++serial);
    const promise=env.writes.mkdir({ resolveScope: scopeA, contextId: context.contextId, path: fileName, operationId });
    promise.catch(()=>{});tracked.push({promise,context,operationId,path:fileName});return promise;
  };
  try{
  const running = [run(contextA, 0, "a0"), run(contextB, 0, "b0")];
  await writer.waitFor(2);
  const waiting = [];
  for (let index = 1; index <= 4; index++) waiting.push(run(contextA, index, `a${index}`));
  for (let index = 1; index <= 4; index++) waiting.push(run(contextB, index, `b${index}`));
  let prepared=false;
  for(let attempt=0;attempt<1000&&!prepared;attempt++){
    const states=await Promise.all(tracked.slice(2).map(row=>env.writes.operationStatus({resolveScope:scopeA,contextId:row.context.contextId,path:row.path,operationId:row.operationId,kind:"mkdir"}).catch(()=>null)));
    prepared=states.length===8&&states.every(dto=>dto?.status==="prepared");
    if(!prepared)await new Promise(resolve=>setTimeout(resolve,5));
  }
  assert.equal(prepared,true,"all eight calls reached the native queue");
  assert.equal(writer.calls.length, 2);
  await assert.rejects(run(contextA, 9, "a9"), { code: "WRITE_BUSY", status: 429 });
  writer.releaseAll();
  for (const pending of [...running, ...waiting]) assert.equal((await pending).status, "succeeded");
  assert.equal(writer.calls.length, 10);
  }finally{writer.releaseAll();await Promise.allSettled(tracked.map(row=>row.promise));}
});

test("operation status is scoped to a fresh context of the same scope", async t => {
  const env = await setup(t);
  const authority=scoped();
  const context = await env.issue("",authority.resolve);
  const other = await env.issue("");
  assert.notEqual(context.contextId, other.contextId);
  await env.writes.mkdir({ resolveScope: scopeA, contextId: context.contextId, path: "d", operationId: opId(20) });
  const dto = await env.writes.operationStatus({ resolveScope: scopeA, operationId: opId(20), contextId: context.contextId, path: "d", kind: "mkdir" });
  assert.deepEqual(Object.keys(dto).sort(), ["kind", "operationId", "path", "result", "status"]);
  assert.equal(dto.status, "succeeded");
  assert.equal((await env.writes.operationStatus({ resolveScope: scopeA, operationId: opId(20), contextId: other.contextId, path: "d", kind: "mkdir" })).status,"succeeded");
  await assert.rejects(env.writes.operationStatus({ resolveScope: scopeA, operationId: opId(21), contextId: context.contextId, path: "d", kind: "mkdir" }), { code: "OPERATION_NOT_FOUND", status: 404 });
  authority.state.revoked = true;
  await assert.rejects(env.writes.operationStatus({ resolveScope: authority.resolve, operationId: opId(20), contextId: context.contextId, path: "d", kind: "mkdir" }), { code: "WRITE_CONTEXT_DENIED", status: 403 });
});

test("an uncertain commit keeps the stage, reports unknown and is never retried", async t => {
  const writer = recordingWriter({
    onResult: () => {
      throw Object.assign(new Error("COMMIT_UNKNOWN"), { status: 504, code: "COMMIT_UNKNOWN", recoveryId: RECOVERY_ID });
    }
  });
  const env = await setup(t, { writer });
  const context = await env.issue("");
  const call = () => env.writes.upload({ resolveScope: scopeA, contextId: context.contextId, path: "uncertain.bin", operationId: opId(30), stream: (async function* () { yield Buffer.from("payload"); })(), declaredSize: 7 });
  const dto = await call();
  assert.equal(dto.status, "unknown");
  assert.equal(dto.recoveryId, RECOVERY_ID);
  const staged = await env.list(env.staging);
  assert.equal(staged.length, 1); // the helper may still be reading it
  assert.equal(writer.calls.length, 1);
  const again = await call();
  assert.equal(again.status, "unknown");
  assert.equal(writer.calls.length, 1);
  assert.deepEqual(await env.list(env.staging), staged);
  const ledger = JSON.parse(await fs.readFile(path.join(env.operations, `${opId(30)}.json`), "utf8"));
  assert.equal(ledger.status, "unknown");
  assert.equal(ledger.recoveryId, RECOVERY_ID);
  assert.equal(ledger.stagedPath, path.join(env.staging, staged[0]));
});

test("definite helper failures drop the stage and record why", async t => {
  const writer = recordingWriter({
    onResult: () => {
      throw Object.assign(new Error("PREPARE_FAILED"), { status: 502, code: "PREPARE_FAILED" });
    }
  });
  const env = await setup(t, { writer });
  const context = await env.issue("");
  await assert.rejects(env.writes.upload({ resolveScope: scopeA, contextId: context.contextId, path: "fail.bin", operationId: opId(31), stream: (async function* () { yield Buffer.from("payload"); })() }), { code: "PREPARE_FAILED", status: 502 });
  assert.deepEqual(await env.list(env.staging), []);
  const ledger = JSON.parse(await fs.readFile(path.join(env.operations, `${opId(31)}.json`), "utf8"));
  assert.equal(ledger.status, "failed");
  assert.equal(ledger.reason, "PREPARE_FAILED");
});

test("recovery download binds the original bytes to its operation and fresh authority",async t=>{
 const writer=recordingWriter({onResult:()=>{throw Object.assign(Error("unknown"),{status:504,code:"COMMIT_UNKNOWN",recoveryId:RECOVERY_ID});}});
 const env=await setup(t,{writer}),context=await env.issue("");
 const args={resolveScope:scopeA,contextId:context.contextId,path:"recovery.md",operationId:opId(901),kind:"save-text"};
 const {kind,...save}=args;await env.writes.saveText({...save,text:"new bytes",expectedVersion:VERSION_A});
 const record=JSON.parse(await fs.readFile(path.join(env.operations,`${args.operationId}.json`),"utf8"));
 const original=Buffer.from("original\r\n");const dir=path.join(env.dataDir,"project-writes","recoveries");await fs.mkdir(dir);
 const meta={v:1,operationId:record.operationId,recoveryBinding:record.recoveryBinding,rootIdentity:record.nativeRootIdentity,parentIdentity:record.nativeParentIdentity,currentVersion:VERSION_A,relativePath:record.path,originalSize:original.length,originalHash:sha256(original)};
 const file=path.join(dir,`recovery-${RECOVERY_ID}.bin`);await fs.writeFile(file,Buffer.concat([Buffer.from(JSON.stringify(meta)+"\n"),original]));
 const fresh=await env.issue("");const request={...args,contextId:fresh.contextId};
 assert.deepEqual((await env.writes.downloadRecovery(request)).bytes,original);
 await fs.writeFile(file,Buffer.concat([Buffer.from(JSON.stringify(meta)+"\n"),Buffer.from("tampered")]));
 await assert.rejects(env.writes.downloadRecovery(request),{code:"RECOVERY_INVALID"});
});

test("oversize, declared-size mismatch and abort remove only the owned stage", async t => {
  const env = await setup(t);
  const context = await env.issue("");
  const upload = extra => env.writes.upload({ resolveScope: scopeA, contextId: context.contextId, path: "big.bin", operationId: opId(40), stream: (async function* () { yield Buffer.alloc(WRITE_LIMITS.uploadBytes + 1, 1); })(), ...extra });
  await assert.rejects(upload({}), { code: "TOO_LARGE", status: 413 });
  await assert.rejects(env.writes.upload({ resolveScope: scopeA, contextId: context.contextId, path: "big.bin", operationId: opId(41), stream: (async function* () { yield Buffer.from("abc"); })(), declaredSize: 4 }), { code: "SIZE_MISMATCH", status: 409 });
  const abort = new AbortController();
  await assert.rejects(env.writes.upload({
    resolveScope: scopeA,
    contextId: context.contextId,
    path: "big.bin",
    operationId: opId(42),
    signal: abort.signal,
    stream: (async function* () { yield Buffer.from("a"); abort.abort(); yield Buffer.from("b"); })()
  }), { code: "CANCELLED", status: 499 });
  assert.equal(env.runWriter.calls.length, 0);
  assert.deepEqual(await env.list(env.staging), []);
  const files = await env.list(env.operations);
  assert.deepEqual(files, [`${opId(40)}.json`, `${opId(41)}.json`, `${opId(42)}.json`].sort());
});

test("edit-open is read-only: server generated id, no ledger, fresh authorisation", async t => {
  const env = await setup(t);
  const authority=scoped();
  const context = await env.issue("",authority.resolve);
  const first = await env.writes.editOpen({ resolveScope: scopeA, contextId: context.contextId, path: "readme.md" });
  const second = await env.writes.editOpen({ resolveScope: scopeA, contextId: context.contextId, path: "readme.md" });
  assert.equal(first.status, "succeeded");
  assert.equal(first.kind, "edit-open");
  assert.deepEqual(first.result, { size: 6, version: VERSION_A, editable: true, text: "hello\n", bom: false, eol: "lf", reason: null });
  assert.notEqual(first.operationId, second.operationId);
  assert.notEqual(first.operationId, opId(1));
  assert.deepEqual(Object.keys(env.runWriter.calls[0].operation).sort(), ["id", "kind", "relativePath", "root"]);
  assert.equal(env.runWriter.calls[0].operation.kind, "edit-open");
  assert.deepEqual(await env.list(env.operations), []);
  authority.state.revoked = true;
  await assert.rejects(env.writes.editOpen({ resolveScope: authority.resolve, contextId: context.contextId, path: "readme.md" }), { code: "WRITE_CONTEXT_DENIED", status: 403 });
  assert.equal(env.runWriter.calls.length, 2);
});
