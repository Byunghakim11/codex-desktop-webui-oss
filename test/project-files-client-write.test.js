import test from "node:test";
import assert from "node:assert/strict";
import { createProjectFilesClient } from "../public/project-files-client.js";

const opId = "0123456789abcdef0123456789abcdef";
const contextId = "ctx-1";

function jsonResponse(body, { status = 200, headers = {}, type = "basic" } = {}) {
  const map = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  if (!map.has("content-type")) map.set("content-type", "application/json");
  return {
    ok: status >= 200 && status < 300,
    status,
    type,
    headers: { get: key => map.get(String(key).toLowerCase()) ?? null },
    json: async () => body,
    body: { cancel: async () => {} }
  };
}
function textResponse(status, contentType = "text/html") {
  return {
    ok: status >= 200 && status < 300,
    status,
    type: "basic",
    headers: { get: key => (String(key).toLowerCase() === "content-type" ? contentType : null) },
    json: async () => { throw new SyntaxError("not json"); },
    body: { cancel: async () => {} }
  };
}
function badJsonResponse(status) {
  return {
    ok: false,
    status,
    type: "basic",
    headers: { get: key => (String(key).toLowerCase() === "content-type" ? "application/json" : null) },
    json: async () => { throw new SyntaxError("invalid json"); },
    body: { cancel: async () => {} }
  };
}
function redirectResponse() {
  return {
    ok: false,
    status: 0,
    type: "opaqueredirect",
    headers: { get: () => null },
    json: async () => { throw new Error("no body"); },
    body: { cancel: async () => {} }
  };
}
function dto(overrides = {}) {
  return {
    operationId: opId,
    status: "completed",
    kind: "mkdir",
    path: "src",
    result: { version: "v2", size: 3, text: "", editable: true, bom: false, eol: "lf", reason: "" },
    ...overrides
  };
}
function makeFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const call = { url: String(url), options };
    calls.push(call);
    return handler(call, calls.length - 1);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}
function createClient({ handler, fetchImpl, xhrFactory, getToken = () => "token-1", getAuthMode = () => "token" } = {}) {
  const fetch = fetchImpl || makeFetch(handler || (() => { throw new Error("unexpected fetch"); }));
  const client = createProjectFilesClient({ getToken, getAuthMode, fetchImpl: fetch, xhrFactory });
  return { client, fetch };
}

test('save preserves the editor operation id for later status reconciliation',async()=>{
 const {client,fetch}=createClient({handler:()=>jsonResponse(dto({status:'succeeded',kind:'save-text',path:'notes.md'}))});
 await client.saveText({contextId,path:'notes.md',operationId:opId,text:'',expectedVersion:'v1'});
 assert.equal(JSON.parse(fetch.calls[0].options.body).operationId,opId);
});

test('native edit-open permits a null restriction reason',async()=>{
 const {client}=createClient({handler:()=>jsonResponse(dto({status:'succeeded',kind:'edit-open',path:'notes.md',result:{editable:true,text:'hello',version:'v1',size:5,bom:false,eol:'lf',reason:null}}))});
 assert.equal((await client.editOpen({contextId,path:'notes.md'})).result.reason,null);
});
function createFakeXhr() {
  const state = { method: null, url: null, headers: {}, body: null, sends: 0, aborts: 0 };
  const xhr = {
    status: 0,
    responseURL: "",
    responseText: "",
    timeout: 0,
    upload: {},
    open(method, url) { state.method = method; state.url = url; },
    setRequestHeader(name, value) { state.headers[String(name).toLowerCase()] = value; },
    getResponseHeader(name) { return state.responseHeaders?.[String(name).toLowerCase()] ?? null; },
    send(value) { state.sends += 1; state.body = value; },
    abort() { state.aborts += 1; xhr.onabort?.(); }
  };
  const respond = ({ status = 200, contentType = "application/json", body, responseURL = "http://localhost/api/project-files/upload" } = {}) => {
    xhr.status = status;
    xhr.responseURL = responseURL;
    xhr.responseText = typeof body === "string" ? body : JSON.stringify(body);
    state.responseHeaders = { "content-type": contentType };
    xhr.onload?.();
  };
  return {
    xhr,
    state,
    respond,
    progress: event => xhr.upload.onprogress?.(event),
    error: () => xhr.onerror?.(),
    timeout: () => xhr.ontimeout?.()
  };
}
function fakeSignal() {
  const listeners = new Set();
  return {
    aborted: false,
    listeners,
    addEventListener(type, listener) { if (type === "abort") listeners.add(listener); },
    removeEventListener(type, listener) { if (type === "abort") listeners.delete(listener); },
    fire() { this.aborted = true; for (const listener of [...listeners]) listener(); }
  };
}
const file = { name: "한국어 파일.txt", size: 5, type: "text/plain" };

test("writeContext posts the frozen typed endpoint and returns only the opaque context", async () => {
  let tokenCalls = 0;
  const { client, fetch } = createClient({
    getToken: () => `tok-${++tokenCalls}`,
    handler: () => jsonResponse({ contextId, threadId: "t1", rootRevision: "rev-1", parentPath: "src", expiresAt: "2025-01-01T00:00:00Z", extra: "ignored" })
  });
  const context = await client.writeContext({ threadId: "t1", rootRevision: "rev-1", parentPath: "src" });
  assert.deepEqual(context, { contextId, threadId: "t1", rootRevision: "rev-1", parentPath: "src", expiresAt: "2025-01-01T00:00:00Z" });
  const call = fetch.calls[0];
  assert.equal(call.url, "/api/project-files/write-context?token=tok-1");
  assert.equal(call.options.method, "POST");
  assert.equal(call.options.credentials, "same-origin");
  assert.equal(call.options.cache, "no-store");
  assert.equal(call.options.redirect, "manual");
  assert.deepEqual(call.options.headers, { "Content-Type": "application/json", "X-Codex-Files": "1" });
  assert.deepEqual(JSON.parse(call.options.body), { threadId: "t1", rootRevision: "rev-1", parentPath: "src" });
  await client.writeContext({ threadId: "t2", rootRevision: 2, parentPath: "" });
  assert.equal(fetch.calls[1].url, "/api/project-files/write-context?token=tok-2");
  assert.deepEqual(JSON.parse(fetch.calls[1].options.body), { threadId: "t2", rootRevision: 2, parentPath: "" });
});

test("mkdir and saveText generate 32-hex operation ids and preserve empty text", async () => {
  const seen = [];
  const { client } = createClient({
    handler: call => {
      const body = JSON.parse(call.options.body);
      seen.push({ url: call.url, body });
      if (call.url.startsWith("/api/project-files/mkdir")) return jsonResponse(dto({ operationId: body.operationId, kind: "mkdir", path: body.path, status: "pending", result: {} }));
      return jsonResponse(dto({ operationId: body.operationId, kind: "save-text", path: body.path, status: "pending", result: { version: body.expectedVersion, size: 0, text: body.text, editable: true, bom: false, eol: "lf" } }));
    }
  });
  const made = await client.mkdir({ contextId, path: "src/new folder" });
  assert.match(seen[0].body.operationId, /^[0-9a-f]{32}$/);
  assert.deepEqual(Object.keys(seen[0].body).sort(), ["contextId", "operationId", "path"]);
  assert.equal(made.operationId, seen[0].body.operationId);
  const saved = await client.saveText({ contextId, path: "src/a.txt", text: "", expectedVersion: "v1" });
  assert.equal(seen[1].body.text, "");
  assert.equal(seen[1].body.expectedVersion, "v1");
  assert.match(seen[1].body.operationId, /^[0-9a-f]{32}$/);
  assert.deepEqual(Object.keys(seen[1].body).sort(), ["contextId", "expectedVersion", "operationId", "path", "text"]);
  assert.equal(saved.result.text, "");
  assert.equal(saved.operationId, seen[1].body.operationId);
});

test("editOpen sends only contextId and path", async () => {
  const seen = [];
  const { client } = createClient({
    handler: call => {
      const body = JSON.parse(call.options.body);
      seen.push({ url: call.url, body });
      return jsonResponse(dto({ kind: "edit-open", path: body.path, status: "completed", result: { version: "v1", size: 1, text: "x", editable: true, bom: false, eol: "lf" } }));
    }
  });
  const result = await client.editOpen({ contextId, path: "docs/readme.md" });
  assert.equal(seen[0].url, "/api/project-files/edit-open?token=token-1");
  assert.deepEqual(seen[0].body, { contextId, path: "docs/readme.md" });
  assert.equal(result.kind, "edit-open");
  assert.equal(result.result.text, "x");
});

test("operationStatus uses a fixed kind and a limited write-status query", async () => {
  const { client, fetch } = createClient({
    handler: () => jsonResponse(dto({ kind: "upload", status: "running", path: "a b.txt", result: { size: 10 } }))
  });
  const result = await client.operationStatus({ contextId, path: "a b.txt", operationId: opId, kind: "upload" });
  assert.equal(result.status, "running");
  assert.equal(result.result.size, 10);
  const url = new URL(fetch.calls[0].url, "http://localhost");
  assert.equal(url.pathname, "/api/project-files/write-status");
  assert.deepEqual([...url.searchParams.keys()].sort(), ["contextId", "kind", "operationId", "path", "token"]);
  assert.equal(url.searchParams.get("path"), "a b.txt");
  assert.equal(fetch.calls[0].options.method, undefined);
  await assert.rejects(client.operationStatus({ contextId, path: "a", operationId: opId, kind: "delete" }), error => error.code === "INVALID_ARGUMENT");
});

test("new write methods reject caller root/native path/stage/action and unknown keys before fetch", async () => {
  const { client, fetch } = createClient({ handler: () => { throw new Error("must not fetch"); } });
  const attempts = [
    () => client.writeContext({ threadId: "t", rootRevision: "r", parentPath: "", root: "C:/repo" }),
    () => client.writeContext({ threadId: "t", rootRevision: "r", parentPath: "", nativePath: "C:/repo" }),
    () => client.mkdir({ contextId, path: "a", operationId: "invalid-operation-id" }),
    () => client.mkdir({ contextId, path: "a", stageKey: "x" }),
    () => client.mkdir({ contextId, path: "/etc/passwd" }),
    () => client.editOpen({ contextId, path: "a", action: "overwrite" }),
    () => client.saveText({ contextId, path: "a", text: "x", expectedVersion: 1, action: "delete" }),
    () => client.operationStatus({ contextId, path: "a", operationId: opId, kind: "upload", root: "C:/" }),
    () => client.uploadFile({ contextId, path: "a", operationId: opId, file, root: "C:/" })
  ];
  for (const attempt of attempts) await assert.rejects(attempt, error => error.code === "INVALID_ARGUMENT");
  assert.equal(fetch.calls.length, 0);
});

test("write HTTP failures expose validated codes, never raw response HTML", async () => {
  const responses = [
    () => jsonResponse({ error: "VERSION_CONFLICT", recoveryId: "rec-1" }, { status: 409 }),
    () => textResponse(500),
    () => badJsonResponse(500),
    () => redirectResponse(),
    () => jsonResponse({ error: "secret_token" }, { status: 401 }),
    () => jsonResponse({ error: "lowercase_code" }, { status: 503 })
  ];
  let index = 0;
  const { client } = createClient({ handler: () => responses[index++]() });
  await assert.rejects(client.mkdir({ contextId, path: "a" }), error => error.code === "VERSION_CONFLICT" && error.status === 409 && error.recoveryId === "rec-1");
  await assert.rejects(client.mkdir({ contextId, path: "a" }), error => error.code === "HTTP_500" && error.status === 500 && !String(error.message).includes("<"));
  await assert.rejects(client.mkdir({ contextId, path: "a" }), error => error.code === "HTTP_500");
  await assert.rejects(client.mkdir({ contextId, path: "a" }), error => error.code === "FILE_ACCESS_REQUIRED" && error.status === 401);
  await assert.rejects(client.mkdir({ contextId, path: "a" }), error => error.code === "FILE_ACCESS_REQUIRED" && error.status === 401);
  await assert.rejects(client.mkdir({ contextId, path: "a" }), error => error.code === "HTTP_503");
});

test("uploadFile sends the raw file with encoded path headers and progress", async () => {
  const fake = createFakeXhr();
  const { client } = createClient({ xhrFactory: () => fake.xhr, getToken: () => "upload-token" });
  const progress = [];
  const promise = client.uploadFile({ contextId, path: "docs/한국어 파일.txt", operationId: opId, file, onProgress: value => progress.push(value) });
  assert.equal(fake.state.sends, 1);
  assert.equal(fake.state.method, "POST");
  assert.equal(fake.state.url, "/api/project-files/upload?token=upload-token");
  assert.equal(fake.state.headers["x-codex-files"], "1");
  assert.equal(fake.state.headers["x-write-context"], contextId);
  assert.equal(fake.state.headers["x-file-path"], encodeURIComponent("docs/한국어 파일.txt"));
  assert.equal(fake.state.headers["x-operation-id"], opId);
  assert.equal(fake.state.headers["content-type"], "text/plain");
  assert.equal(fake.state.body, file);
  assert.equal(fake.xhr.timeout, 120000);
  fake.progress({ loaded: 2, total: 5, lengthComputable: true });
  assert.deepEqual(progress, [{ loaded: 2, total: 5, lengthComputable: true }]);
  fake.respond({ body: dto({ kind: "upload", path: "docs/한국어 파일.txt", result: { version: "v1", size: 5, editable: false, bom: false, eol: "lf" } }) });
  const result = await promise;
  assert.equal(result.operationId, opId);
  assert.equal(result.kind, "upload");
  assert.equal(result.result.size, 5);
});

test("uploadFile falls back to octet-stream and requests a fresh token per invocation", async () => {
  let tokenCalls = 0;
  const fakes = [];
  const { client } = createClient({
    getToken: () => `up-${++tokenCalls}`,
    xhrFactory: () => { const fake = createFakeXhr(); fakes.push(fake); return fake.xhr; }
  });
  const first = client.uploadFile({ contextId, path: "a.bin", operationId: opId, file: { size: 1, type: "" } });
  assert.equal(fakes[0].state.headers["content-type"], "application/octet-stream");
  fakes[0].respond({ body: dto({ kind: "upload", path: "a.bin" }) });
  await first;
  const second = client.uploadFile({ contextId, path: "a.bin", operationId: opId, file: { size: 1, type: "" } });
  fakes[1].respond({ body: dto({ kind: "upload", path: "a.bin" }) });
  await second;
  assert.equal(fakes[0].state.url, "/api/project-files/upload?token=up-1");
  assert.equal(fakes[1].state.url, "/api/project-files/upload?token=up-2");
});

test("uploadFile aborts the XHR, cleans the signal listener and never resends", async () => {
  const fake = createFakeXhr();
  const signal = fakeSignal();
  const { client } = createClient({ xhrFactory: () => fake.xhr });
  const promise = client.uploadFile({ contextId, path: "a.txt", operationId: opId, file }, signal);
  assert.equal(signal.listeners.size, 1);
  signal.fire();
  await assert.rejects(promise, error => error.name === "AbortError");
  assert.equal(fake.state.aborts, 1);
  assert.equal(fake.state.sends, 1);
  assert.equal(signal.listeners.size, 0);
});

test("uploadFile times out at 120 seconds without retry", async () => {
  const fake = createFakeXhr();
  const { client } = createClient({ xhrFactory: () => fake.xhr });
  const promise = client.uploadFile({ contextId, path: "a.txt", operationId: opId, file });
  fake.timeout();
  await assert.rejects(promise, error => error.code === "UPLOAD_TIMEOUT" && error.status === 408);
  assert.equal(fake.state.sends, 1);
});

test("uploadFile surfaces network failures once and flags foreign redirect targets as access errors", async () => {
  const network = createFakeXhr();
  const networkClient = createClient({ xhrFactory: () => network.xhr }).client;
  const failed = networkClient.uploadFile({ contextId, path: "a.txt", operationId: opId, file });
  network.error();
  await assert.rejects(failed, error => error.code === "NETWORK_ERROR");
  assert.equal(network.state.sends, 1);

  const redirected = createFakeXhr();
  const redirectClient = createClient({ xhrFactory: () => redirected.xhr }).client;
  const promise = redirectClient.uploadFile({ contextId, path: "a.txt", operationId: opId, file });
  redirected.respond({ body: dto({ kind: "upload" }), responseURL: "https://evil.example/api/project-files/upload" });
  await assert.rejects(promise, error => error.code === "FILE_ACCESS_REQUIRED" && error.status === 401);
  assert.equal(redirected.state.sends, 1);
});

test("uploadFile validates the JSON MIME and maps server error codes safely", async () => {
  const html = createFakeXhr();
  const htmlClient = createClient({ xhrFactory: () => html.xhr }).client;
  const htmlPromise = htmlClient.uploadFile({ contextId, path: "a.txt", operationId: opId, file });
  html.respond({ contentType: "text/html", body: "<html>secret response</html>" });
  await assert.rejects(htmlPromise, error => error.code === "INVALID_RESPONSE" && !String(error.message).includes("<"));

  const conflict = createFakeXhr();
  const conflictClient = createClient({ xhrFactory: () => conflict.xhr }).client;
  const conflictPromise = conflictClient.uploadFile({ contextId, path: "a.txt", operationId: opId, file });
  conflict.respond({ status: 409, body: { error: "VERSION_CONFLICT" } });
  await assert.rejects(conflictPromise, error => error.code === "VERSION_CONFLICT" && error.status === 409);

  const auth = createFakeXhr();
  const authClient = createClient({ xhrFactory: () => auth.xhr }).client;
  const authPromise = authClient.uploadFile({ contextId, path: "a.txt", operationId: opId, file });
  auth.respond({ status: 401, body: { error: "NOPE" } });
  await assert.rejects(authPromise, error => error.code === "FILE_ACCESS_REQUIRED" && error.status === 401);
});

test("existing read-only preview fallback, get and download ticket behavior remains", async () => {
  let call = 0;
  const fetch = makeFetch(() => {
    call += 1;
    if (call === 1) return jsonResponse({}, { status: 404 });
    if (call === 2) return jsonResponse({ entries: [], context: { rootRevision: "r" } });
    if (call === 3) return jsonResponse({ url: `/api/project-files/download?ticket=${"a".repeat(32)}` });
    throw new Error("unexpected fetch");
  });
  const client = createProjectFilesClient({ getToken: () => "t", getAuthMode: () => "cloudflare-access", fetchImpl: fetch, xhrFactory: () => { throw new Error("unused"); } });
  const preview = await client.openPreview({ threadId: "t1", path: "a.md", rootRevision: "r" });
  assert.deepEqual(preview, { entries: [], context: { rootRevision: "r" } });
  assert.equal(new URL(fetch.calls[0].url, "http://localhost").pathname, "/api/project-files/preview-open");
  assert.equal(new URL(fetch.calls[1].url, "http://localhost").pathname, "/api/project-files/preview");
  const ticket = await client.downloadTicket({ threadId: "t1", path: "a.md", rootRevision: "r" });
  assert.equal(ticket, `/api/project-files/download?ticket=${"a".repeat(32)}`);
  globalThis.location = { origin: "http://localhost" };
  try {
    assert.equal(client.downloadUrl({ threadId: "t1", path: "a.md", rootRevision: "r" }), "/api/project-files/download?threadId=t1&path=a.md&rootRevision=r");
  } finally {
    delete globalThis.location;
  }
});
