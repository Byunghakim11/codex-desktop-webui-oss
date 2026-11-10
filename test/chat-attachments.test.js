import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, realpath, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ChatAttachments, ChatAttachmentError, CHAT_ATTACHMENT_LIMITS, checkAttachmentQuota } from "../server/chat-attachments.js";

const DRAFT_A = "11111111-1111-4111-8111-111111111111";
const DRAFT_B = "22222222-2222-4222-8222-222222222222";
const CWD_A = path.join(os.tmpdir(), "chat-attachments-scope-a");
const CWD_B = path.join(os.tmpdir(), "chat-attachments-scope-b");
const LIMIT = 25 * 1024 * 1024;

test('sent attachments download by authenticated chat without the original draft id',async t=>{
  const dataDir=await tempDir(t);const store=new ChatAttachments({dataDir});t.after(()=>store.close());
  const ctx=context({threadId:'chat-download'});
  const bytes=Buffer.from('original downloadable bytes');
  const item=await store.upload({context:ctx,name:'검증.xlsx',type:'application/octet-stream',stream:streamOf(bytes),declaredSize:bytes.length});
  await assert.rejects(store.openForDownload({...ctx,draftId:null},item.id));
  const sent=await store.acquire(ctx,[item.id]);await sent.commit();
  const opened=await store.openForDownload({...ctx,draftId:null},item.id);
  try{assert.deepEqual(await readFile(opened.files[0].path),bytes);assert.equal(opened.files[0].name,'검증.xlsx');}finally{await opened.release();}
  for(const changed of [{principalId:'other'},{scopeId:'other'},{cwd:CWD_B},{threadId:'another'},{threadId:null}]){
    await assert.rejects(store.openForDownload({...ctx,draftId:null,...changed},item.id));
  }
});

async function tempDir(t) {
  const created = await mkdtemp(path.join(os.tmpdir(), "cw-chat-att-"));
  t.after(() => rm(created, { recursive: true, force: true }));
  return realpath(created);
}

function context(overrides = {}) {
  return { principalId: "user-1", scopeId: "scope-1", cwd: CWD_A, draftId: DRAFT_A, ...overrides };
}

async function* streamOf(...chunks) {
  for (const chunk of chunks) yield chunk;
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function holdStream(gate, onFirst) {
  let index = 0;
  return {
    [Symbol.asyncIterator]() {
      return {
        next: async () => {
          index += 1;
          if (index === 1) {
            onFirst?.();
            return { value: Buffer.alloc(4096, 1), done: false };
          }
          if (index === 2) {
            await gate.promise;
            return { value: Buffer.alloc(4096, 2), done: false };
          }
          return { value: undefined, done: true };
        },
        return: async () => ({ value: undefined, done: true })
      };
    }
  };
}

function upload(store, ctx, body, name = "file.bin", type = "application/octet-stream") {
  return store.upload({ context: ctx, name, type, stream: streamOf(body), declaredSize: body.length });
}

async function rootEntries(dir) {
  return readdir(path.join(dir, "chat-attachments"));
}

test("uploads are byte-identical and DTOs never expose storage paths", async (t) => {
  const dir = await tempDir(t);
  const store = new ChatAttachments({ dataDir: dir });
  t.after(() => store.close());
  const bytes = Buffer.from([0, 1, 2, 250, 251, 252, 10, 13, 0]);
  const created = await upload(store, context(), bytes, "report 2026.pdf", "application/pdf");
  assert.match(created.id, /^[0-9a-f]{32}$/);
  assert.deepEqual(Object.keys(created).sort(), ["expiresAt", "id", "mime", "name", "size", "status"]);
  assert.equal(created.status, "ready");
  assert.equal(created.size, bytes.length);
  assert.equal(created.mime, "application/pdf");
  assert.equal(created.name, "report 2026.pdf");
  assert.ok(!JSON.stringify(created).includes(dir));
  const root = path.join(dir, "chat-attachments");
  assert.deepEqual(await readFile(path.join(root, `${created.id}.blob`)), bytes);
  assert.equal((await stat(path.join(root, `${created.id}.blob`), { bigint: true })).nlink, 1n);
  const listed = await store.list(context());
  assert.equal(listed.length, 1);
  assert.deepEqual(Object.keys(listed[0]).sort(), ["expiresAt", "id", "mime", "name", "size", "status"]);
  assert.ok(!JSON.stringify(listed).includes(root));
  const lease = await store.acquire(context(), [created.id]);
  try {
    assert.deepEqual(Object.keys(lease.files[0]).sort(), ["id", "mime", "name", "path", "sha256", "size"]);
    assert.deepEqual(await readFile(lease.files[0].path), bytes);
    assert.equal(lease.files[0].path, path.join(root, `${created.id}.blob`));
  } finally {
    await lease.release();
  }
  assert.deepEqual(await store.remove(context(), created.id), { id: created.id });
  assert.deepEqual(await store.list(context()), []);
  const remaining = await rootEntries(dir);
  assert.deepEqual(remaining.filter(name => name.endsWith(".blob")), []);
  assert.deepEqual(remaining.filter(name => name.endsWith(".partial")), []);
});

test("display names are sanitized and duplicate names never collide", async (t) => {
  const dir = await tempDir(t);
  const store = new ChatAttachments({ dataDir: dir });
  t.after(() => store.close());
  const first = await upload(store, context(), Buffer.from("one"), "..\\..\\secret\u202Etxt.exe", "text/plain");
  const second = await upload(store, context(), Buffer.from("two"), "..\\..\\secret\u202Etxt.exe", "text/plain");
  assert.equal(first.name, "secrettxt.exe");
  assert.notEqual(first.id, second.id);
  assert.equal((await store.list(context())).length, 2);
  assert.equal(await readFile(path.join(dir, "chat-attachments", `${first.id}.blob`), "utf8"), "one");
  assert.equal(await readFile(path.join(dir, "chat-attachments", `${second.id}.blob`), "utf8"), "two");
  assert.ok(!(await rootEntries(dir)).includes(first.name));
  await assert.rejects(store.upload({ context: context(), name: "..", type: "text/plain", stream: streamOf(Buffer.from("x")) }), error => error.code === "invalid_name");
  await assert.rejects(store.upload({ context: context(), name: 42, type: "text/plain", stream: streamOf(Buffer.from("x")) }), error => error.code === "invalid_name");
  const sanitized = await store.upload({ context: context(), name: "a/b/c.txt", type: "bogus\r\nInjected: 1", stream: streamOf(Buffer.from("x")) });
  assert.equal(sanitized.name, "c.txt");
  assert.equal(sanitized.mime, "application/octet-stream");
});

test("principal, scope, cwd, draft and thread boundaries are enforced", async (t) => {
  const dir = await tempDir(t);
  const store = new ChatAttachments({ dataDir: dir });
  t.after(() => store.close());
  const uploaded = await upload(store, context(), Buffer.from("boundary"));
  assert.deepEqual(await store.list(context({ cwd: CWD_B })), []);
  assert.deepEqual(await store.list(context({ principalId: "user-2" })), []);
  assert.deepEqual(await store.list(context({ draftId: DRAFT_B })), []);
  await assert.rejects(store.remove(context({ cwd: CWD_B }), uploaded.id), error => error.code === "forbidden");
  await assert.rejects(store.acquire(context({ principalId: "user-2" }), [uploaded.id]), error => error.code === "forbidden");
  await assert.rejects(store.acquire(context({ draftId: DRAFT_B }), [uploaded.id]), error => error.code === "forbidden");
  await assert.rejects(store.remove(context(), "not-a-real-id"), error => error.code === "not_found");
  await assert.rejects(store.acquire(context(), ["f".repeat(32)]), error => error.code === "not_found");
  await assert.rejects(store.acquire(context(), []), error => error.code === "invalid_input");
  await assert.rejects(store.list(context({ draftId: "not-a-uuid" })), error => error.code === "invalid_draft");
  await assert.rejects(store.list(context({ draftId: "11111111-1111-1111-1111-111111111111" })), error => error.code === "invalid_draft");
  await assert.rejects(store.list(context({ cwd: "relative/dir" })), error => error.code === "invalid_context");
  await assert.rejects(store.list({}), error => error.code === "invalid_context");
  const lease = await store.acquire({ ...context(), threadId: "thread-1" }, [uploaded.id]);
  await lease.release();
  assert.equal((await store.list({ ...context(), threadId: "thread-1" })).length, 1);
  assert.deepEqual(await store.list({ ...context(), threadId: "thread-2" }), []);
  await assert.rejects(store.acquire({ ...context(), threadId: "thread-2" }, [uploaded.id]), error => error.code === "thread_mismatch");
  await assert.rejects(store.acquire(context(), [uploaded.id]), error => error.code === "thread_mismatch");
  const again = await store.acquire({ ...context(), threadId: "thread-1" }, [uploaded.id]);
  await again.release();
  assert.deepEqual(await store.remove({ ...context(), threadId: "thread-1" }, uploaded.id), { id: uploaded.id });
});

test("empty, oversized and failing streams leave no partials or reservations", async (t) => {
  const dir = await tempDir(t);
  const store = new ChatAttachments({ dataDir: dir });
  t.after(() => store.close());
  await assert.rejects(store.upload({ context: context(), name: "empty.txt", type: "text/plain", stream: streamOf() }), error => error.code === "empty_file");
  await assert.rejects(store.upload({ context: context(), name: "big.bin", type: "application/octet-stream", stream: streamOf(Buffer.alloc(1024)), declaredSize: LIMIT + 1 }), error => error.code === "file_too_large");
  await assert.rejects(store.upload({ context: context(), name: "big.bin", type: "application/octet-stream", stream: streamOf(Buffer.alloc(LIMIT + 1)) }), error => error.code === "file_too_large");
  const broken = { [Symbol.asyncIterator]() { return { next: async () => { throw new Error("producer aborted"); } }; } };
  await assert.rejects(store.upload({ context: context(), name: "broken.bin", type: "application/octet-stream", stream: broken }), error => error.code === "unavailable");
  await assert.rejects(store.upload({ context: context(), name: "bad.bin", type: "application/octet-stream", stream: "nope" }), error => error.code === "invalid_stream");
  await assert.rejects(store.upload({ context: context(), name: "bad.bin", type: "application/octet-stream", stream: streamOf(Buffer.from("x")), declaredSize: -1 }), error => error.code === "invalid_input");
  assert.deepEqual((await rootEntries(dir)).filter(name => name.endsWith(".partial")), []);
  assert.deepEqual(await store.list(context()), []);
  const recovered = await upload(store, context(), Buffer.from("after failures"));
  assert.equal(recovered.status, "ready");
  assert.deepEqual((await rootEntries(dir)).filter(name => name.endsWith(".partial")), []);
});

test("read leases block removal, commit retains and release never deletes", async (t) => {
  const dir = await tempDir(t);
  const store = new ChatAttachments({ dataDir: dir });
  t.after(() => store.close());
  const uploaded = await upload(store, context(), Buffer.from("lease"));
  const lease = await store.acquire(context(), [uploaded.id]);
  await assert.rejects(store.remove(context(), uploaded.id), error => error.code === "leased");
  await lease.release();
  await lease.release();
  const again = await store.acquire(context(), [uploaded.id]);
  assert.equal(again.files.length, 1);
  await again.commit();
  assert.equal((await store.list(context()))[0].status, "sent");
  await assert.rejects(store.remove(context(), uploaded.id), error => error.code === "sent");
  const blobs = (await rootEntries(dir)).filter(name => name.endsWith(".blob"));
  assert.deepEqual(blobs, [`${uploaded.id}.blob`]);
});

test("optional native lease pins are acquired and refused when not alive", async (t) => {
  const dir = await tempDir(t);
  const calls = [];
  const pinned = [];
  const store = new ChatAttachments({
    dataDir: dir,
    acquireLease: async (input) => {
      calls.push(input);
      const lease = { alive: true, closed: false, async close() { this.closed = true; } };
      pinned.push(lease);
      return lease;
    }
  });
  t.after(() => store.close());
  const uploaded = await upload(store, context(), Buffer.from("pinned"));
  const lease = await store.acquire(context(), [uploaded.id]);
  assert.deepEqual(calls, [{ root: path.join(dir, "chat-attachments"), relative: `${uploaded.id}.blob`, kind: "read" }]);
  await lease.release();
  assert.equal(pinned[0].closed, true);

  const dir2 = await tempDir(t);
  const denying = new ChatAttachments({ dataDir: dir2, acquireLease: async () => ({ alive: false, async close() {} }) });
  t.after(() => denying.close());
  const second = await upload(denying, context(), Buffer.from("denied"));
  await assert.rejects(denying.acquire(context(), [second.id]), error => error.code === "unavailable");
  assert.deepEqual(await denying.remove(context(), second.id), { id: second.id });
});

test("tampered bytes and corrupt manifests fail closed across restarts", async (t) => {
  const dir = await tempDir(t);
  const store = new ChatAttachments({ dataDir: dir });
  t.after(() => store.close());
  const uploaded = await upload(store, context(), Buffer.from("tamper-me"));
  const root = path.join(dir, "chat-attachments");
  const blob = path.join(root, `${uploaded.id}.blob`);
  const manifest = path.join(root, "manifests", `${uploaded.id}.json`);
  await store.close();

  const reopened = new ChatAttachments({ dataDir: dir });
  t.after(() => reopened.close());
  assert.equal((await reopened.list(context())).length, 1);
  await writeFile(blob, Buffer.from("TAMPER-ME"));
  await assert.rejects(reopened.acquire(context(), [uploaded.id]), error => error.code === "tampered");
  await writeFile(manifest, "{not-json");

  const restarted = new ChatAttachments({ dataDir: dir });
  t.after(() => restarted.close());
  assert.deepEqual(await restarted.list(context()), []);
  await assert.rejects(restarted.acquire(context(), [uploaded.id]), error => error.code === "not_found");
});

test("symlinked blobs are refused and never adopted", { skip: process.platform === "win32" }, async (t) => {
  const dir2 = await tempDir(t);
  const linked = new ChatAttachments({ dataDir: dir2 });
  const linkable = await upload(linked, context(), Buffer.from("symlink"));
  const linkBlob = path.join(dir2, "chat-attachments", `${linkable.id}.blob`);
  const outside = path.join(dir2, "outside.txt");
  await writeFile(outside, "symlink");
  await unlink(linkBlob);
  await symlink(outside, linkBlob);
  await assert.rejects(linked.acquire(context(), [linkable.id]), error => error.code === "tampered");
  await linked.close();
  const linkedAgain = new ChatAttachments({ dataDir: dir2 });
  t.after(() => linkedAgain.close());
  assert.deepEqual(await linkedAgain.list(context()), []);
});

test("quota constants and count limits are enforced", { timeout: 180000 }, async (t) => {
  assert.equal(CHAT_ATTACHMENT_LIMITS.fileBytes, LIMIT);
  assert.equal(checkAttachmentQuota({ draftCount: 20 }), "too_many_files");
  assert.equal(checkAttachmentQuota({ draftBytes: 100 * 1024 * 1024 }), "quota_exceeded");
  assert.equal(checkAttachmentQuota({ principalBytes: 256 * 1024 * 1024 }), "quota_exceeded");
  assert.equal(checkAttachmentQuota({ globalBytes: 1024 * 1024 * 1024 }), "quota_exceeded");
  assert.equal(checkAttachmentQuota({ draftCount: 19, draftBytes: 1024 }), null);
  const dir = await tempDir(t);
  const store = new ChatAttachments({ dataDir: dir });
  t.after(() => store.close());
  for (let index = 0; index < 20; index += 1) {
    await upload(store, context(), Buffer.from(`file-${index}`));
  }
  await assert.rejects(upload(store, context(), Buffer.from("one-too-many")), error => error.code === "too_many_files" && error.status === 429);
});

test("draft byte quota stops the next upload", { timeout: 180000 }, async (t) => {
  const dir = await tempDir(t);
  const store = new ChatAttachments({ dataDir: dir });
  t.after(() => store.close());
  const big = Buffer.alloc(LIMIT, 7);
  for (let index = 0; index < 4; index += 1) {
    const created = await upload(store, context(), big, `big-${index}.bin`);
    assert.equal(created.size, LIMIT);
  }
  await assert.rejects(upload(store, context(), Buffer.from("x")), error => error.code === "quota_exceeded" && error.status === 413);
});

test("concurrent uploads are bounded per store and per draft without queueing", async (t) => {
  const dir = await tempDir(t);
  const store = new ChatAttachments({ dataDir: dir });
  t.after(() => store.close());
  const gates = [deferred(), deferred()];
  const notified = [deferred(), deferred()];
  const first = store.upload({ context: context({ draftId: DRAFT_A }), name: "a.bin", type: "application/octet-stream", stream: holdStream(gates[0], () => notified[0].resolve()) });
  await notified[0].promise;
  const second = store.upload({ context: context({ draftId: DRAFT_B }), name: "b.bin", type: "application/octet-stream", stream: holdStream(gates[1], () => notified[1].resolve()) });
  await notified[1].promise;
  await assert.rejects(upload(store, context({ draftId: "44444444-4444-4444-8444-444444444444" }), Buffer.from("x")), error => error.code === "busy" && error.status === 429);
  await assert.rejects(upload(store, context({ draftId: DRAFT_A }), Buffer.from("x")), error => error.code === "busy");
  gates[0].resolve();
  gates[1].resolve();
  const [one, two] = await Promise.all([first, second]);
  assert.equal(one.status, "ready");
  assert.equal(two.status, "ready");
  assert.equal((await store.list(context({ draftId: DRAFT_A }))).length, 1);
  assert.equal((await store.list(context({ draftId: DRAFT_B }))).length, 1);
});

test("ready attachments expire after 24h while sent ones keep a 7 day retention", async (t) => {
  const dir = await tempDir(t);
  let clock = 1700000000000;
  const store = new ChatAttachments({ dataDir: dir, now: () => clock });
  t.after(() => store.close());
  const expired = await upload(store, context(), Buffer.from("expired"));
  const sent = await upload(store, context(), Buffer.from("sent"));
  const lease = await store.acquire(context(), [sent.id]);
  await lease.commit();
  clock += 24 * 60 * 60 * 1000 + 1;
  assert.deepEqual((await store.list(context())).map(item => item.id), [sent.id]);
  await assert.rejects(store.acquire(context(), [expired.id]), error => error.code === "expired");
  clock += 7 * 24 * 60 * 60 * 1000;
  assert.deepEqual(await store.list(context()), []);
});

test("closed store rejects new work with typed safe errors", async (t) => {
  const dir = await tempDir(t);
  const store = new ChatAttachments({ dataDir: dir });
  await store.close();
  const error = await store.upload({ context: context(), name: "x.txt", type: "text/plain", stream: streamOf(Buffer.from("x")) }).catch(caught => caught);
  assert.ok(error instanceof ChatAttachmentError);
  assert.equal(error.code, "closed");
  assert.equal(error.status, 503);
  assert.ok(!error.message.includes(dir));
  await assert.rejects(store.list(context()), caught => caught.code === "closed");
  await store.close();
});

test("76 MiB of ready files plus known and unknown 1 KiB declarations fit the 100 MiB draft quota", { timeout: 180000 }, async (t) => {
  const dir = await tempDir(t);
  const store = new ChatAttachments({ dataDir: dir });
  t.after(() => store.close());
  const mib19 = 19 * 1024 * 1024;
  const big = Buffer.alloc(mib19, 3);
  for (let index = 0; index < 4; index += 1) {
    const created = await upload(store, context(), big, `part-${index}.bin`);
    assert.equal(created.size, mib19);
    assert.equal(created.status, "ready");
  }
  const known = await store.upload({ context: context(), name: "known.bin", type: "application/octet-stream", stream: streamOf(Buffer.alloc(1024, 4)), declaredSize: 1024 });
  assert.equal(known.size, 1024);
  const unknown = await store.upload({ context: context(), name: "unknown.bin", type: "application/octet-stream", stream: streamOf(Buffer.alloc(1024, 5)) });
  assert.equal(unknown.size, 1024);
  const listed = await store.list(context());
  assert.equal(listed.length, 6);
  assert.equal(listed.reduce((total, item) => total + item.size, 0), 4 * mib19 + 2048);
});

test("declared size mismatches fail without leaking reservations or partials", async (t) => {
  const dir = await tempDir(t);
  const store = new ChatAttachments({ dataDir: dir });
  t.after(() => store.close());
  await assert.rejects(
    store.upload({ context: context(), name: "short.bin", type: "application/octet-stream", stream: streamOf(Buffer.alloc(20, 1)), declaredSize: 10 }),
    error => error.code === "tampered"
  );
  await assert.rejects(
    store.upload({ context: context(), name: "long.bin", type: "application/octet-stream", stream: streamOf(Buffer.alloc(10, 2)), declaredSize: 20 }),
    error => error.code === "tampered"
  );
  assert.deepEqual((await rootEntries(dir)).filter(name => name.endsWith(".partial")), []);
  assert.deepEqual((await rootEntries(dir)).filter(name => name.endsWith(".blob")), []);
  assert.deepEqual(await store.list(context()), []);
  const recovered = await upload(store, context(), Buffer.from("after mismatch"));
  assert.equal(recovered.status, "ready");
  assert.equal((await store.list(context())).length, 1);
  assert.deepEqual((await rootEntries(dir)).filter(name => name.endsWith(".blob")), [`${recovered.id}.blob`]);
});

test("expiry prune removes ready and sent records on upload but keeps leased ones until release", { timeout: 180000 }, async (t) => {
  const dir = await tempDir(t);
  let clock = 1700000000000;
  const natives = [];
  const store = new ChatAttachments({
    dataDir: dir,
    now: () => clock,
    acquireLease: async () => {
      const lease = { alive: true, closed: false, async close() { this.closed = true; } };
      natives.push(lease);
      return lease;
    }
  });
  t.after(() => store.close());
  const ready = await upload(store, context(), Buffer.from("ready"));
  const sent = await upload(store, context(), Buffer.from("sent"));
  const held = await upload(store, context(), Buffer.from("held"));
  const sentLease = await store.acquire(context(), [sent.id]);
  await sentLease.commit();
  const heldLease = await store.acquire(context(), [held.id]);
  assert.equal(natives.length, 2);
  assert.equal(natives[0].closed, true);
  clock += 7 * 24 * 60 * 60 * 1000 + 1;
  const replacement = await upload(store, context(), Buffer.from("replacement"));
  const root = path.join(dir, "chat-attachments");
  const blobsAfterPrune = (await rootEntries(dir)).filter(name => name.endsWith(".blob"));
  assert.deepEqual(blobsAfterPrune.slice().sort(), [held.id, replacement.id].map(id => `${id}.blob`).sort());
  assert.ok(!blobsAfterPrune.includes(`${ready.id}.blob`));
  assert.ok(!blobsAfterPrune.includes(`${sent.id}.blob`));
  const manifestsAfterPrune = await readdir(path.join(root, "manifests"));
  assert.equal(manifestsAfterPrune.includes(`${ready.id}.json`), false);
  assert.equal(manifestsAfterPrune.includes(`${sent.id}.json`), false);
  await heldLease.release();
  assert.equal(natives[1].closed, true);
  const second = await upload(store, context(), Buffer.from("second"));
  const blobsAfterRelease = (await rootEntries(dir)).filter(name => name.endsWith(".blob"));
  assert.deepEqual(blobsAfterRelease.slice().sort(), [replacement.id, second.id].map(id => `${id}.blob`).sort());
  assert.deepEqual((await store.list(context())).map(item => item.id).sort(), [replacement.id, second.id].sort());
  assert.deepEqual((await rootEntries(dir)).filter(name => name.endsWith(".partial")), []);
});

test("startup reclaims orphan 32-hex blobs while preserving valid manifests", async (t) => {
  const dir = await tempDir(t);
  const store = new ChatAttachments({ dataDir: dir });
  const valid = await upload(store, context(), Buffer.from("keep-me"));
  await store.close();
  const root = path.join(dir, "chat-attachments");
  const orphanId = "0123456789abcdef0123456789abcdef";
  await writeFile(path.join(root, `${orphanId}.blob`), Buffer.from("orphan"));
  const reopened = new ChatAttachments({ dataDir: dir });
  t.after(() => reopened.close());
  const restored = await reopened.list(context());
  assert.equal(restored.length, 1);
  const blobs = (await rootEntries(dir)).filter(name => name.endsWith(".blob"));
  assert.deepEqual(blobs, [`${valid.id}.blob`]);
  assert.equal(await readFile(path.join(root, `${valid.id}.blob`), "utf8"), "keep-me");
  const manifests = await readdir(path.join(root, "manifests"));
  assert.ok(manifests.includes(`${valid.id}.json`));
});

test("thread-bound records stay hidden when the listing thread is missing or null", async (t) => {
  const dir = await tempDir(t);
  const store = new ChatAttachments({ dataDir: dir });
  t.after(() => store.close());
  const uploaded = await upload(store, context(), Buffer.from("thread-bound"));
  const lease = await store.acquire({ ...context(), threadId: "thread-1" }, [uploaded.id]);
  await lease.release();
  assert.deepEqual(await store.list(context()), []);
  assert.deepEqual(await store.list({ ...context(), threadId: null }), []);
  assert.deepEqual(await store.list({ ...context(), threadId: "thread-2" }), []);
  assert.deepEqual((await store.list({ ...context(), threadId: "thread-1" })).map(item => item.id), [uploaded.id]);
});
