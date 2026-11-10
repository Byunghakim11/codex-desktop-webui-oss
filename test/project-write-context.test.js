import test from "node:test";
import assert from "node:assert/strict";
import { ProjectWriteContexts } from "../server/project-write-context.js";

const REV_A = "a".repeat(64);
const REV_B = "b".repeat(64);
const ROOT = "C:\\project";
const OP_ID = "0".repeat(32);

const scopeA = () => ({ id: "owner", authMode: "cloudflare-access", accessEmail: "a@example.com", tokenHash: "tok-a" });
const scopeB = () => ({ id: "owner", authMode: "cloudflare-access", accessEmail: "b@example.com", tokenHash: "tok-b" });

function makeFiles(handler) {
  const calls = [];
  return {
    calls,
    async context(scope, query) {
      calls.push({ scope, query });
      return handler(scope, query, calls.length);
    }
  };
}

function defaultFiles(state = {}) {
  return makeFiles(() => ({
    root: ROOT,
    rootIdentity: state.rootIdentity ?? "10:20",
    rootRevision: state.rootRevision ?? REV_A,
    threadId: "thread-1",
    rootName: "project"
  }));
}

function makeWriter({ rootIdentity = "1-2-3", parentIdentity = "4-5-6", before = null } = {}) {
  const calls = [];
  const writer = async ({ dataDir, operation, authorizePrepared }) => {
    calls.push({ dataDir, operation });
    before?.({ operation });
    const prepared = {
      operationId: operation.id,
      kind: operation.kind,
      relativePath: operation.relativePath,
      rootIdentity,
      parentIdentity
    };
    const allowed = await authorizePrepared(prepared);
    if (allowed !== true) throw Object.assign(new Error("AUTHORIZATION_DENIED"), { status: 403, code: "AUTHORIZATION_DENIED" });
    return {
      path: operation.relativePath,
      kind: operation.kind === "context" ? "directory" : "file",
      rootIdentity,
      parentIdentity,
      targetIdentity: parentIdentity
    };
  };
  writer.calls = calls;
  return writer;
}

function setup(overrides = {}) {
  const files = overrides.files ?? defaultFiles(overrides.state);
  const writer = overrides.writer ?? makeWriter();
  const contexts = new ProjectWriteContexts({
    files,
    runWriter: writer,
    dataDir: overrides.dataDir ?? "C:\\data",
    now: overrides.now,
    ttlMs: overrides.ttlMs
  });
  return { files, writer, contexts };
}

async function issueOne(contexts, parentPath = "", resolveScope = async () => scopeA()) {
  return contexts.issue({ resolveScope, query: { threadId: "thread-1", parentPath } });
}

test("constructor requires files, runWriter and dataDir", () => {
  assert.throws(() => new ProjectWriteContexts({ runWriter: () => {}, dataDir: "C:\\d" }), TypeError);
  assert.throws(() => new ProjectWriteContexts({ files: { context() {} }, dataDir: "C:\\d" }), TypeError);
  assert.throws(() => new ProjectWriteContexts({ files: { context() {} }, runWriter: () => {} }), TypeError);
  assert.throws(() => new ProjectWriteContexts({ files: { context() {} }, runWriter: () => {}, dataDir: "C:\\d", ttlMs: 0 }), TypeError);
});

test("issue returns an opaque DTO with no private paths or identities", async () => {
  const { contexts, files } = setup({ now: () => 1000, ttlMs: 5000 });
  const dto = await issueOne(contexts, "src");
  assert.match(dto.contextId, /^[0-9a-f]{32}$/);
  assert.deepEqual(Object.keys(dto).sort(), ["contextId", "expiresAt", "parentPath", "rootRevision", "threadId"]);
  assert.equal(dto.threadId, "thread-1");
  assert.equal(dto.parentPath, "src");
  assert.equal(dto.rootRevision, REV_A);
  assert.equal(dto.expiresAt, 6000);
  assert.equal(JSON.stringify(dto).includes(ROOT), false);
  assert.equal(JSON.stringify(dto).includes("10:20"), false);
  assert.equal(JSON.stringify(dto).includes("tok-a"), false);
  // initial pin, in-callback recheck, post-result recheck
  assert.equal(files.calls.length, 3);
  const second = await issueOne(contexts, "src");
  assert.notEqual(dto.contextId, second.contextId);
});

test("get returns the internal binding and authorizes matching native ids", async () => {
  const { contexts } = setup({ now: () => 1000, ttlMs: 5000 });
  const dto = await issueOne(contexts, "");
  const internal = await contexts.get({ resolveScope: async () => scopeA(), contextId: dto.contextId, path: "notes.txt", kind: "save-text" });
  assert.equal(internal.context.contextId, dto.contextId);
  assert.equal(internal.context.root, ROOT);
  assert.equal(internal.context.fsIdentity, "10:20");
  assert.equal(internal.context.nativeRootIdentity, "1-2-3");
  assert.equal(internal.context.nativeParentIdentity, "4-5-6");
  assert.deepEqual(internal.operationBase, { root: ROOT, relativePath: "notes.txt" });
  assert.match(internal.recoveryBinding, /^[0-9a-f]{64}$/);
  assert.equal(internal.recoveryBinding.includes(dto.contextId), false);
  assert.equal(await internal.authorizePrepared({ operationId: OP_ID, rootIdentity: "1-2-3", parentIdentity: "4-5-6" }), true);
  internal.context.root = "C:\\evil";
  const again = await contexts.get({ resolveScope: async () => scopeA(), contextId: dto.contextId, path: "notes.txt", kind: "save-text" });
  assert.equal(again.context.root, ROOT);
});

test("get enforces non-empty, hidden, parent and kind rules", async () => {
  const { contexts } = setup({ now: () => 1000, ttlMs: 5000 });
  const dto = await issueOne(contexts, "src");
  const base = { resolveScope: async () => scopeA(), contextId: dto.contextId };
  await assert.rejects(contexts.get({ ...base, path: "", kind: "upload" }), e => e.status === 400);
  await assert.rejects(contexts.get({ ...base, path: ".env", kind: "upload" }), e => e.status === 403);
  await assert.rejects(contexts.get({ ...base, path: "src/a.txt", kind: "delete" }), e => e.status === 400);
  await assert.rejects(contexts.get({ ...base, path: "src/a.txt", kind: "context" }), e => e.status === 400);
  await assert.rejects(contexts.get({ ...base, path: "a.txt", kind: "upload" }), e => e.status === 403);
  await assert.rejects(contexts.get({ ...base, path: "src/nested/a.txt", kind: "upload" }), e => e.status === 403);
  await assert.rejects(contexts.get({ ...base, contextId: "f".repeat(32), path: "src/a.txt", kind: "upload" }), e => e.status === 404);
  const ok = await contexts.get({ ...base, path: "src/a.txt", kind: "mkdir" });
  assert.equal(ok.operationBase.relativePath, "src/a.txt");
});

test("issue rejects when the scope changes while the helper is prepared", async () => {
  const { contexts, writer } = setup({ now: () => 1000, ttlMs: 5000 });
  let calls = 0;
  const resolveScope = async () => (++calls === 1 ? scopeA() : scopeB());
  await assert.rejects(contexts.issue({ resolveScope, query: { threadId: "thread-1", parentPath: "" } }), e => e.status === 403);
  assert.equal(writer.calls.length, 1);
  assert.equal(contexts.records.size, 0);
});

test("issue rejects when the scope changes before the record is stored", async () => {
  const { contexts } = setup({ now: () => 1000, ttlMs: 5000 });
  let calls = 0;
  const resolveScope = async () => (++calls <= 2 ? scopeA() : scopeB());
  await assert.rejects(contexts.issue({ resolveScope, query: { threadId: "thread-1", parentPath: "" } }), e => e.status === 409);
  assert.equal(contexts.records.size, 0);
});

test("issue denies an unresolvable scope and a missing native parent directory", async () => {
  const { contexts } = setup({ now: () => 1000, ttlMs: 5000 });
  await assert.rejects(contexts.issue({ resolveScope: async () => null, query: { threadId: "thread-1", parentPath: "" } }), e => e.status === 403);
  const writer = makeWriter({ before: ({ operation }) => { if (operation.relativePath === "missing") throw Object.assign(new Error("PROJECT_UNAVAILABLE"), { status: 403, code: "PROJECT_UNAVAILABLE" }); } });
  const strict = setup({ writer });
  await assert.rejects(strict.contexts.issue({ resolveScope: async () => scopeA(), query: { threadId: "thread-1", parentPath: "missing" } }), e => e.status === 403);
});

test("get denies a revoked or swapped scope", async () => {
  const { contexts } = setup({ now: () => 1000, ttlMs: 5000 });
  const dto = await issueOne(contexts, "");
  await assert.rejects(contexts.get({ resolveScope: async () => null, contextId: dto.contextId, path: "a.txt", kind: "upload" }), e => e.status === 403);
  await assert.rejects(contexts.get({ resolveScope: async () => scopeB(), contextId: dto.contextId, path: "a.txt", kind: "upload" }), e => e.status === 403);
});

test("authorizePrepared re-resolves the scope and rejects revocation", async () => {
  const { contexts } = setup({ now: () => 1000, ttlMs: 5000 });
  const dto = await issueOne(contexts, "");
  let calls = 0;
  const getResolve = async () => (++calls === 1 ? scopeA() : null);
  const internal = await contexts.get({ resolveScope: getResolve, contextId: dto.contextId, path: "a.txt", kind: "upload" });
  await assert.rejects(internal.authorizePrepared({ operationId: OP_ID, rootIdentity: "1-2-3", parentIdentity: "4-5-6" }), e => e.status === 403);
});

test("authorizePrepared rejects swapped or missing native identities", async () => {
  const { contexts } = setup({ now: () => 1000, ttlMs: 5000 });
  const dto = await issueOne(contexts, "");
  const internal = await contexts.get({ resolveScope: async () => scopeA(), contextId: dto.contextId, path: "a.txt", kind: "upload" });
  await assert.rejects(internal.authorizePrepared({ operationId: OP_ID, rootIdentity: "4-5-6", parentIdentity: "1-2-3" }), e => e.status === 403);
  await assert.rejects(internal.authorizePrepared({ operationId: OP_ID, rootIdentity: "1-2-3" }), e => e.status === 403);
  await assert.rejects(internal.authorizePrepared(null), e => e.status === 403);
});

test("expired contexts are denied and cleaned up as records only", async () => {
  let clock = 1000;
  const { contexts, files } = setup({ now: () => clock, ttlMs: 100 });
  const dto = await issueOne(contexts, "");
  const before = files.calls.length;
  clock = 1101;
  await assert.rejects(contexts.get({ resolveScope: async () => scopeA(), contextId: dto.contextId, path: "a.txt", kind: "upload" }), e => e.status === 403);
  assert.equal(contexts.records.size, 0);
  // only the record was dropped; no further file/context work is required to expire
  assert.equal(files.calls.length, before);

  clock = 2000;
  const live = await issueOne(contexts, "");
  const internal = await contexts.get({ resolveScope: async () => scopeA(), contextId: live.contextId, path: "a.txt", kind: "upload" });
  clock = 2101;
  await assert.rejects(internal.authorizePrepared({ operationId: OP_ID, rootIdentity: "1-2-3", parentIdentity: "4-5-6" }), e => e.status === 403);
  assert.equal(contexts.records.size, 0);
});

test("get denies a changed root revision, canonical identity or root", async () => {
  const state = { rootRevision: REV_A, rootIdentity: "10:20" };
  const { contexts } = setup({ files: defaultFiles(state), now: () => 1000, ttlMs: 5000 });
  const dto = await issueOne(contexts, "");
  state.rootRevision = REV_B;
  await assert.rejects(contexts.get({ resolveScope: async () => scopeA(), contextId: dto.contextId, path: "a.txt", kind: "upload" }), e => e.status === 409);
  state.rootRevision = REV_A;
  state.rootIdentity = "99:99";
  await assert.rejects(contexts.get({ resolveScope: async () => scopeA(), contextId: dto.contextId, path: "a.txt", kind: "upload" }), e => e.status === 409);
});

test("authorizePrepared denies when the root changed while the helper holds pins", async () => {
  const state = { rootRevision: REV_A, rootIdentity: "10:20" };
  const { contexts } = setup({ files: defaultFiles(state), now: () => 1000, ttlMs: 5000 });
  const dto = await issueOne(contexts, "");
  const internal = await contexts.get({ resolveScope: async () => scopeA(), contextId: dto.contextId, path: "a.txt", kind: "upload" });
  state.rootIdentity = "99:99";
  await assert.rejects(internal.authorizePrepared({ operationId: OP_ID, rootIdentity: "1-2-3", parentIdentity: "4-5-6" }), e => e.status === 409);
});

test("records are bounded to 64 per principal", async () => {
  const { contexts } = setup({ now: () => 1000, ttlMs: 60_000 });
  let firstId, lastId;
  for (let index = 0; index < 70; index++) {
    const dto = await contexts.issue({ resolveScope: async () => scopeA(), query: { threadId: `t-${index}`, parentPath: "" } });
    if (index === 0) firstId = dto.contextId;
    lastId = dto.contextId;
  }
  let owned = 0;
  const owner=[...contexts.records.values()][0].principal;
  for (const record of contexts.records.values()) if (record.principal === owner) owned++;
  assert.equal(contexts.records.size, 64);
  assert.equal(owned, 64);
  assert.equal(contexts.records.has(lastId), true);
  assert.equal(contexts.records.has(firstId), false);
  await assert.rejects(contexts.get({ resolveScope: async () => scopeA(), contextId: firstId, path: "a.txt", kind: "upload" }), e => e.status === 404);
});

test("records are bounded to 256 globally across principals", async () => {
  const { contexts } = setup({ now: () => 1000, ttlMs: 60_000 });
  let firstId, lastId;
  for (let index = 0; index < 256; index++) {
    const principalScope = () => ({ ...scopeA(), id: `p-${index}` });
    const dto = await contexts.issue({ resolveScope: async () => principalScope(), query: { threadId: `t-${index}`, parentPath: "" } });
    if (index === 0) firstId = dto.contextId;
    lastId = dto.contextId;
  }
  assert.equal(contexts.records.size, 256);
  assert.equal(contexts.records.has(lastId), true);
  await assert.rejects(contexts.issue({resolveScope:async()=>({...scopeA(),id:"new-principal"}),query:{threadId:"new-thread",parentPath:""}}),error=>error.status===429);
  assert.equal(contexts.records.has(firstId), true,"another principal cannot evict an existing context");
});
