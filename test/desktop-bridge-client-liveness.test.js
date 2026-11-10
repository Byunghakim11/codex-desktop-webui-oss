import assert from "node:assert/strict";
import { Duplex } from "node:stream";
import test from "node:test";
import { DesktopBridgeConnection } from "../server/desktop-bridge-client.js";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, { timeout = 1500, interval = 2 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(interval);
  }
  assert.fail("Timed out waiting for condition");
}

// Production deadline timers are (correctly) unref'ed so a real bridge never
// holds the process open. A real socket keeps the event loop alive through its
// OS handle; the in-memory FakeTransport Duplex below has no such handle, so a
// test awaiting an unref'ed deadline can be cancelled as "event loop resolved".
// Hold one bounded, referenced liveness timer per test so those unref'ed
// production timers can fire. afterEach clears it even when a test fails, so
// nothing leaks and nothing stays referenced past the test.
const LIVENESS_HANDLE_MS = 4000;
let livenessHandle = null;

test.beforeEach(() => {
  livenessHandle = setTimeout(() => {}, LIVENESS_HANDLE_MS);
});

test.afterEach(() => {
  if (livenessHandle !== null) {
    clearTimeout(livenessHandle);
    livenessHandle = null;
  }
});

class FakeTransport extends Duplex {
  constructor({ throwOnRequest = false } = {}) {
    super();
    this.chunks = [];
    this.destroyCalls = 0;
    this.throwOnRequest = throwOnRequest;
  }

  _read() {}

  _write(chunk, encoding, callback) {
    this.chunks.push(chunk.toString());
    callback();
  }

  _destroy(error, callback) {
    this.destroyCalls += 1;
    callback(error);
  }

  write(chunk, encoding, callback) {
    if (this.throwOnRequest && String(chunk).includes('"type":"request"')) {
      throw new Error("synthetic write failure");
    }
    return super.write(chunk, encoding, callback);
  }

  setNoDelay() {
    return this;
  }

  connect() {
    this.emit("connect");
  }

  send(message) {
    this.push(`${JSON.stringify(message)}\n`);
  }

  sentMessages() {
    return this.chunks.map((chunk) => JSON.parse(chunk));
  }
}

function makeHarness(options = {}) {
  const transports = [];
  const events = { status: [], errors: [], appMessages: [], resolved: [], pendingSnapshots: [] };
  let factoryCalls = 0;
  const connection = new DesktopBridgeConnection({
    resolvePipePath: () => "fake-pipe",
    resolveSecret: async () => "unit-secret",
    createSocket: () => {
      factoryCalls += 1;
      const transport = new FakeTransport(options.transportOptions);
      transports.push(transport);
      return transport;
    },
    handshakeTimeoutMs: options.handshakeTimeoutMs ?? 30,
    requestTimeoutMs: options.requestTimeoutMs ?? 30,
    maxPendingRequests: options.maxPendingRequests,
    maxWriteBufferBytes: options.maxWriteBufferBytes,
    onStatus: (value) => events.status.push(value),
    onError: (error) => events.errors.push(error),
    onAppServerMessage: (message) => events.appMessages.push(message),
    onServerRequestResolved: (id) => events.resolved.push(id),
    onPendingRequests: (snapshot) => events.pendingSnapshots.push(snapshot),
    ...options.connectionOptions
  });
  return {
    connection,
    transports,
    events,
    factoryCalls: () => factoryCalls
  };
}

async function establish(harness, expectedIndex = harness.transports.length) {
  const connecting = harness.connection.connect();
  await waitFor(() => harness.transports.length > expectedIndex);
  const transport = harness.transports[expectedIndex];
  transport.connect();
  await waitFor(() => transport.sentMessages().some((message) => message.type === "hello"));
  transport.send({ type: "hello", ok: true, epoch: "epoch-1", features:{abandon:true}, pendingServerRequests: [] });
  await connecting;
  return transport;
}

test("legacy authenticated brokers are not sent an unsupported abandon message",async()=>{
 const harness=makeHarness({requestTimeoutMs:10});const connecting=harness.connection.connect();await waitFor(()=>harness.transports.length===1);const transport=harness.transports[0];transport.connect();await waitFor(()=>transport.sentMessages().some(message=>message.type==='hello'));transport.send({type:'hello',ok:true});await connecting;
 const pending=harness.connection.request('thread/read',{threadId:'synthetic'});await assert.rejects(pending,{code:'REQUEST_TIMEOUT'});assert.equal(transport.sentMessages().some(message=>message.type==='abandon'),false);transport.destroy();
});

test('disconnect after an answer write remains uncertain and reconnect does not replay it',async()=>{
 const harness=makeHarness({requestTimeoutMs:200});const transport=await establish(harness);const pending=harness.connection.respond('synthetic-question',{answers:{reply:{answers:['test']}}});
 await waitFor(()=>transport.sentMessages().some(message=>message.type==='server-response'));transport.destroy();await assert.rejects(pending,{code:'INTERACTION_UNCERTAIN'});assert.equal(harness.connection.pending.size,0);
 const next=await establish(harness);assert.equal(next.sentMessages().some(message=>message.type==='server-response'),false);next.destroy();
});
test('answer failure before write remains distinct from unconfirmed delivery',async()=>{
 const harness=makeHarness();const transport=await establish(harness),original=transport.write.bind(transport);transport.write=(chunk,...args)=>{if(String(chunk).includes('"type":"server-response"'))throw Object.assign(Error('not written'),{code:'BRIDGE_UNAVAILABLE'});return original(chunk,...args);};
 await assert.rejects(harness.connection.respond('synthetic-question',{answers:{}}),{code:'BRIDGE_UNAVAILABLE'});assert.equal(transport.sentMessages().some(message=>message.type==='server-response'),false);assert.equal(harness.connection.pending.size,0);transport.destroy();
});

test("handshake deadline expires when the broker never sends hello", { timeout: 3000 }, async () => {
  const harness = makeHarness({ handshakeTimeoutMs: 15 });
  const connecting = harness.connection.connect();
  await waitFor(() => harness.transports.length === 1);
  const transport = harness.transports[0];
  transport.connect();

  await assert.rejects(connecting, (error) => error.code === "BRIDGE_HANDSHAKE_TIMEOUT");
  assert.equal(transport.destroyCalls, 1);
  assert.equal(transport.destroyed, true);
  assert.equal(harness.connection.authenticated, false);
  assert.equal(harness.connection.isConnected(), false);
});

test("handshake deadline covers a transport that never finishes verification", { timeout: 3000 }, async () => {
  const harness = makeHarness({ handshakeTimeoutMs: 10 });
  const connecting = harness.connection.connect();
  await waitFor(() => harness.transports.length === 1);
  const transport = harness.transports[0];

  await assert.rejects(connecting, (error) => error.code === "BRIDGE_HANDSHAKE_TIMEOUT");
  assert.equal(transport.destroyCalls, 1);
  assert.equal(transport.destroyed, true);
  assert.equal(harness.connection.socket, null);
  assert.equal(harness.connection.authenticated, false);
});

test("denied hello destroys the owned transport", { timeout: 3000 }, async () => {
  const harness = makeHarness({ handshakeTimeoutMs: 30 });
  const connecting = harness.connection.connect();
  await waitFor(() => harness.transports.length === 1);
  const transport = harness.transports[0];
  transport.connect();
  await waitFor(() => transport.sentMessages().some((message) => message.type === "hello"));
  transport.send({ type: "hello", ok: false, error: "Unauthorized" });

  await assert.rejects(
    connecting,
    (error) => error.message === "Unauthorized" && error.code === "BRIDGE_AUTH_FAILED"
  );
  assert.equal(transport.destroyCalls, 1);
  assert.equal(transport.destroyed, true);
  assert.equal(harness.connection.authenticated, false);
  assert.deepEqual(harness.events.status, []);
});

test("secret resolution is bounded and a late secret never opens a transport", { timeout: 3000 }, async () => {
  let releaseSecret;
  let secretCalls = 0;
  const harness = makeHarness({
    handshakeTimeoutMs: 10,
    connectionOptions: {
      resolveSecret: () => {
        secretCalls += 1;
        if (secretCalls === 1) {
          return new Promise((resolve) => { releaseSecret = resolve; });
        }
        return Promise.resolve("second-secret");
      }
    }
  });

  await assert.rejects(harness.connection.connect(), (error) => error.code === "BRIDGE_HANDSHAKE_TIMEOUT");
  releaseSecret("late-secret");
  await delay(10);
  assert.equal(harness.factoryCalls(), 0);
  assert.equal(harness.connection.socket, null);

  const transport = await establish(harness);
  assert.equal(harness.factoryCalls(), 1);
  assert.equal(harness.connection.isConnected(), true);
  transport.destroy();
});

test("late hello, message, and error from an abandoned transport are ignored", { timeout: 3000 }, async () => {
  const harness = makeHarness({ handshakeTimeoutMs: 15 });
  const first = harness.connection.connect();
  await waitFor(() => harness.transports.length === 1);
  const oldTransport = harness.transports[0];
  oldTransport.connect();
  await waitFor(() => oldTransport.sentMessages().some((message) => message.type === "hello"));
  await assert.rejects(first, (error) => error.code === "BRIDGE_HANDSHAKE_TIMEOUT");
  assert.equal(harness.connection.authenticated, false);

  const transport = await establish(harness);
  assert.equal(harness.connection.isConnected(), true);

  oldTransport.send({ type: "hello", ok: true });
  oldTransport.send({ type: "appserver", message: { method: "should/not/arrive" } });
  oldTransport.emit("error", new Error("late old transport error"));
  await delay(10);

  assert.equal(harness.connection.isConnected(), true);
  assert.deepEqual(harness.events.status, [true]);
  assert.deepEqual(harness.events.appMessages, []);
  assert.deepEqual(harness.events.errors, []);
  transport.destroy();
});

test("closing the current transport rejects its pending requests", { timeout: 3000 }, async () => {
  const harness = makeHarness({ handshakeTimeoutMs: 30, requestTimeoutMs: 1000 });
  const transport = await establish(harness);
  const pending = harness.connection.request("thread/list");
  await waitFor(() => transport.sentMessages().some((message) => message.type === "request"));
  assert.equal(harness.connection.pending.size, 1);

  transport.destroy();

  await assert.rejects(pending, (error) => error.message === "Desktop bridge disconnected");
  assert.equal(harness.connection.pending.size, 0);
  assert.equal(harness.connection.authenticated, false);
  assert.equal(harness.events.errors.at(-1)?.message, "Desktop bridge disconnected");
});

test("concurrent connect calls share one transport factory invocation", { timeout: 3000 }, async () => {
  const harness = makeHarness({ handshakeTimeoutMs: 30 });
  const first = harness.connection.connect();
  const second = harness.connection.connect();
  assert.equal(first, second);

  await waitFor(() => harness.transports.length === 1);
  assert.equal(harness.factoryCalls(), 1);
  const transport = harness.transports[0];
  transport.connect();
  await waitFor(() => transport.sentMessages().some((message) => message.type === "hello"));
  transport.send({ type: "hello", ok: true, epoch: "epoch-1", pendingServerRequests: [] });

  await Promise.all([first, second]);
  assert.equal(harness.factoryCalls(), 1);
  assert.equal(harness.connection.isConnected(), true);
  assert.deepEqual(harness.events.pendingSnapshots, [{ epoch: "epoch-1", requests: [] }]);
  transport.destroy();
});

test("a throwing transport write rejects the request and leaves no pending entry", { timeout: 3000 }, async () => {
  const harness = makeHarness({ handshakeTimeoutMs: 30, transportOptions: { throwOnRequest: true } });
  const transport = await establish(harness);

  await assert.rejects(harness.connection.request("thread/list"), /synthetic write failure/);
  assert.equal(harness.connection.pending.size, 0);
  assert.equal(transport.sentMessages().some((message) => message.type === "request"), false);
  transport.destroy();
});

test("the write buffer cap rejects before the request is written", { timeout: 3000 }, async () => {
  const harness = makeHarness({ handshakeTimeoutMs: 30, maxWriteBufferBytes: 64 });
  const transport = await establish(harness);

  await assert.rejects(
    harness.connection.request("thread/list"),
    (error) => error.code === "BRIDGE_WRITE_BACKPRESSURE"
  );
  assert.equal(harness.connection.pending.size, 0);
  assert.equal(transport.sentMessages().some((message) => message.type === "request"), false);
  transport.destroy();
});

test("pending requests are capped before another write is queued", { timeout: 3000 }, async () => {
  const harness = makeHarness({ handshakeTimeoutMs: 30, requestTimeoutMs: 1000, maxPendingRequests: 2 });
  const transport = await establish(harness);
  const first = harness.connection.request("one");
  const second = harness.connection.request("two");
  await waitFor(() => harness.connection.pending.size === 2);
  const before = transport.sentMessages().filter((message) => message.type === "request").length;

  await assert.rejects(
    harness.connection.request("three"),
    (error) => error.code === "BRIDGE_PENDING_LIMIT"
  );
  assert.equal(harness.connection.pending.size, 2);
  const after = transport.sentMessages().filter((message) => message.type === "request").length;
  assert.equal(after, before);

  transport.destroy();
  await Promise.allSettled([first, second]);
  assert.equal(harness.connection.pending.size, 0);
});

test("request timeout abandons the original id once and ignores a late answer", { timeout: 3000 }, async () => {
  const harness = makeHarness({ handshakeTimeoutMs: 30, requestTimeoutMs: 15 });
  const transport = await establish(harness);
  const pending = harness.connection.request("turn/start", { threadId: "thread-1" });
  await waitFor(() => transport.sentMessages().some((message) => message.type === "request"));
  const request = transport.sentMessages().find((message) => message.type === "request");

  await assert.rejects(
    pending,
    (error) => error.code === "REQUEST_TIMEOUT" && error.message === "Timed out waiting for turn/start"
  );
  const abandons = transport.sentMessages().filter((message) => message.type === "abandon");
  assert.equal(abandons.length, 1);
  assert.equal(abandons[0].requestId, request.requestId);
  assert.equal(harness.connection.pending.size, 0);

  transport.send({ type: "response", requestId: request.requestId, result: { late: true } });
  await delay(10);
  assert.equal(transport.sentMessages().filter((message) => message.type === "abandon").length, 1);
  assert.equal(harness.connection.pending.size, 0);
  assert.deepEqual(harness.events.appMessages, []);
  transport.destroy();
});

test("response timeout is typed uncertain and is not abandoned", { timeout: 3000 }, async () => {
  const harness = makeHarness({ handshakeTimeoutMs: 30, requestTimeoutMs: 15 });
  const transport = await establish(harness);
  const pending = harness.connection.respond(900, { decision: "accept" });
  await waitFor(() => transport.sentMessages().some((message) => message.type === "server-response"));

  await assert.rejects(
    pending,
    (error) => error.code === "INTERACTION_UNCERTAIN" && error.message === "Response delivery could not be confirmed"
  );
  assert.equal(harness.connection.pending.size, 0);
  assert.equal(transport.sentMessages().some((message) => message.type === "abandon"), false);
  transport.destroy();
});
