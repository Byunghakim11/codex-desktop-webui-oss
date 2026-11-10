import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { ProjectFiles } from "../server/project-files.js";
import { serveProjectFiles } from "../server/project-files-http.js";

const isAbort = error => error?.status === 499 && error?.name === "AbortError" && error?.code === "ABORTED";

test('cancel after opendir resolves closes the directory before iterator ownership begins',async t=>{
 const fixture=await makeFixture(t),files=filesFor(fixture),controller=new AbortController();let release,closes=0,iterations=0;
 files.openDirectory=()=>new Promise(resolve=>release=resolve);
 const pending=files.tree({id:'test',authMode:'cloudflare-access'},{threadId:'A',path:''},controller.signal);
 while(!release)await new Promise(resolve=>setImmediate(resolve));const reads=fixture.state.readCalls;controller.abort();release({async close(){closes++;},[Symbol.asyncIterator](){iterations++;throw Error('must not begin canceled iteration');}});
 await assert.rejects(pending,isAbort);assert.equal(closes,1);assert.equal(iterations,0);assert.equal(fixture.state.readCalls,reads);assert.equal(fixture.state.leaseCloses,1);assert.equal(files.active,0);
});

async function makeFixture(t) {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "cw-files-abort-")));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, "project");
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, "hello.txt"), "SYNTHETIC ABORT FIXTURE\n");
  await fs.mkdir(path.join(root, "nested"));
  await fs.writeFile(path.join(root, "nested", "child.txt"), "CHILD");
  const state = { readCalls: 0, leaseCalls: 0, leaseCloses: 0, leases: [] };
  const lease = async (_dataDir, _root, relative, kind) => {
    state.leaseCalls++;
    const nativeLease = { alive: true, closeCount: 0, relative, kind, async close() { this.alive = false; this.closeCount++; state.leaseCloses++; } };
    state.leases.push(nativeLease);
    return nativeLease;
  };
  return { temp, root, state, lease };
}

function filesFor(fixture, readThread) {
  return new ProjectFiles({
    dataDir: path.join(fixture.temp, "runtime"),
    readThread: readThread || (async id => { fixture.state.readCalls++; return { id, cwd: fixture.root }; }),
    acquireLease: fixture.lease
  });
}

test("pre-canceled project-file operations perform no native reads, leases, or scans", async t => {
  const fixture = await makeFixture(t), files = filesFor(fixture);
  const scope = { id: "test", authMode: "cloudflare-access" };
  const controller = new AbortController(); controller.abort();
  const query = { threadId: "A", path: "hello.txt", rootRevision: "unused" };
  for (const call of [
    () => files.context(scope, { threadId: "A" }, controller.signal),
    () => files.open(scope, query, "file", controller.signal),
    () => files.tree(scope, { threadId: "A", path: "" }, controller.signal),
    () => files.preview(scope, query, controller.signal),
    () => files.content(scope, query, false, controller.signal)
  ]) await assert.rejects(call(), isAbort);
  assert.equal(fixture.state.readCalls, 0);
  assert.equal(fixture.state.leaseCalls, 0);
  assert.equal(fixture.state.leaseCloses, 0);
  assert.equal(files.active, 0);
});

test("cancellation during the first native read waits for it, then skips lease, re-read and scan", async t => {
  const fixture = await makeFixture(t);
  let releaseRead;
  const pendingRead = new Promise(resolve => { releaseRead = resolve; });
  const files = filesFor(fixture, async () => { fixture.state.readCalls++; return pendingRead; });
  const scope = { id: "test", authMode: "cloudflare-access" };
  const controller = new AbortController();
  const rejected = assert.rejects(files.tree(scope, { threadId: "A", path: "" }, controller.signal), isAbort);
  while (fixture.state.readCalls === 0) await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  releaseRead({ id: "A", cwd: fixture.root });
  await rejected;
  assert.equal(fixture.state.readCalls, 1);
  assert.equal(fixture.state.leaseCalls, 0);
  assert.equal(fixture.state.leaseCloses, 0);
  assert.equal(files.active, 0);
});

test("cancellation after lease acquisition releases the native lease and active slot", async t => {
  const fixture = await makeFixture(t), controller = new AbortController();
  const files = new ProjectFiles({
    dataDir: path.join(fixture.temp, "runtime"),
    readThread: async id => { fixture.state.readCalls++; return { id, cwd: fixture.root }; },
    acquireLease: async (...args) => { const nativeLease = await fixture.lease(...args); controller.abort(); return nativeLease; }
  });
  await assert.rejects(files.tree({ id: "test", authMode: "cloudflare-access" }, { threadId: "A", path: "" }, controller.signal), isAbort);
  assert.equal(fixture.state.readCalls, 1);
  assert.equal(fixture.state.leaseCalls, 1);
  assert.equal(fixture.state.leaseCloses, 1);
  assert.equal(fixture.state.leases[0].alive, false);
  assert.equal(fixture.state.leases[0].closeCount, 1);
  assert.equal(files.active, 0);
});

test("a legitimate tree still works after four canceled requests release the active baseline", async t => {
  const fixture = await makeFixture(t), files = filesFor(fixture);
  const scope = { id: "test", authMode: "cloudflare-access" };
  for (let index = 0; index < 4; index++) {
    const controller = new AbortController(); controller.abort();
    await assert.rejects(files.tree(scope, { threadId: "A", path: "" }, controller.signal), isAbort);
  }
  assert.equal(files.active, 0);
  assert.equal(fixture.state.readCalls, 0);
  assert.equal(fixture.state.leaseCalls, 0);
  const tree = await files.tree(scope, { threadId: "A", path: "" });
  assert.equal(tree.context.rootName, "project");
  assert.deepEqual(tree.entries.map(entry => entry.name), ["nested", "hello.txt"]);
  assert.equal(fixture.state.readCalls, 2);
  assert.equal(fixture.state.leaseCalls, 1);
  assert.equal(fixture.state.leaseCloses, 1);
  assert.equal(files.active, 0);
});

class FakeRequest extends EventEmitter {
  constructor() { super(); this.method = "GET"; this.headers = {}; }
}

class FakeResponse extends EventEmitter {
  constructor() { super(); this.headers = {}; this.statusCode = 0; this.headersSent = false; this.destroyed = false; this.writableEnded = false; }
  setHeader(name, value) { this.headers[name.toLowerCase()] = value; }
  writeHead(status, headers) { this.statusCode = status; this.headersSent = true; Object.assign(this.headers, headers); }
  end(body = "") { this.headersSent = true; this.writableEnded = true; this.body = body; }
  destroy() { this.destroyed = true; }
}

test("HTTP requests thread the shared abort signal into tree, preview, content, preview-open and download", async () => {
  const scope = { id: "test", authMode: "cloudflare-access" }, seen = [];
  for (const action of ["tree", "preview", "content", "preview-open", "download"]) {
    const req = new FakeRequest(), res = new FakeResponse();
    const opened = { stat: { size: 0n }, relative: "zero.bin", context: {}, lease: { alive: true, close: async () => {} }, handle: {}, close: async () => {} };
    const files = {
      async tree(_scope, _query, signal) { seen.push(["tree", signal]); return { context: {}, path: "", entries: [] }; },
      async preview(_scope, _query, signal) { seen.push(["preview", signal]); return { kind: "metadata" }; },
      async content(_scope, _query, _imageOnly, signal) { seen.push(["content", signal]); return { ...opened, mime: "text/plain" }; },
      async open(_scope, _query, _kind, signal) { seen.push(["open", signal]); return opened; },
      async inspect(_opened, _scope, signal) { seen.push(["inspect", signal]); return { kind: "metadata" }; }
    };
    if (action === "download") files.downloads = { async acquire(_opened, _scope, signal) { seen.push(["download", signal]); return null; } };
    const url = new URL(`http://local/api/project-files/${action}?threadId=A&path=${action === "tree" ? "" : "zero.bin"}&rootRevision=rev`);
    await serveProjectFiles(req, res, url, scope, files);
    assert.equal(res.statusCode, 200, action);
    assert.equal(res.writableEnded, true, action);
  }
  assert.deepEqual(seen.map(([name]) => name), ["tree", "preview", "content", "open", "inspect", "open", "download"]);
  for (const [, signal] of seen) { assert.equal(signal instanceof AbortSignal, true); assert.equal(signal.aborted, false); }
});

test("HTTP abort handler never writes headers to a destroyed response", async () => {
  const req = new FakeRequest(), res = new FakeResponse();
  let shared;
  const files = {
    async tree(_scope, _query, signal) {
      shared = signal; res.destroyed = true; req.emit("aborted");
      throw Object.assign(new Error("ABORTED"), { status: 499, code: "ABORTED", name: "AbortError" });
    }
  };
  await serveProjectFiles(req, res, new URL("http://local/api/project-files/tree?threadId=A&path="), { id: "test", authMode: "cloudflare-access" }, files);
  assert.equal(shared.aborted, true);
  assert.equal(res.headersSent, false);
  assert.equal(res.statusCode, 0);
  assert.equal(res.destroyed, true);
});
