import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createConfirmationStore,
  digestParams,
  digestState,
  principalFromScope
} from "../server/native-confirmations.js";

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "native-confirmations-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  return dir;
}

const ACTION = "goal.clear";
const THREAD = "thread-1";
const SCOPE = { id: "scope-1", authMode: "token", tokenHash: "b".repeat(64) };
const STATE = digestState("version-1");
const PARAMS = digestParams({});

async function issued(t, overrides = {}) {
  const dataDir = overrides.dataDir || await tempDir(t);
  let current = overrides.start ?? 1_000_000;
  const now = () => current;
  const store = createConfirmationStore({ dataDir, now, ttlMs: overrides.ttlMs ?? 60_000 });
  const receipt = await store.issue({
    principal: overrides.principal ?? principalFromScope(SCOPE),
    action: overrides.action ?? ACTION,
    threadId: overrides.threadId ?? THREAD,
    paramsDigest: overrides.paramsDigest ?? PARAMS,
    stateDigest: overrides.stateDigest ?? STATE
  });
  return {
    store,
    dataDir,
    receipt,
    advance: ms => { current += ms; },
    consume: (patch = {}) => store.consume({
      id: receipt.id,
      principal: principalFromScope(SCOPE),
      action: ACTION,
      threadId: THREAD,
      paramsDigest: PARAMS,
      stateDigest: STATE,
      ...patch
    })
  };
}

test("principal is derived from the server scope and is stable but scope-specific", () => {
  const first = principalFromScope(SCOPE);
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(principalFromScope({ ...SCOPE }), first);
  assert.notEqual(principalFromScope({ ...SCOPE, tokenHash: "c".repeat(64) }), first);
  assert.notEqual(principalFromScope({ ...SCOPE, accessEmail: "user@example.test" }), first);
  for (const scope of [null, undefined, {}, [], { id: 5 }]) {
    assert.throws(() => principalFromScope(scope), error => error.status === 403 && error.code === "AUTH_PRINCIPAL_REQUIRED");
  }
});

test("a receipt is single use and binds principal, action, target, params and state", async t => {
  const { receipt, consume, dataDir } = await issued(t);
  assert.match(receipt.id, /^[0-9a-f]{32}$/);
  assert.ok(receipt.expiresAt > 0);
  const stored = JSON.parse(await fs.readFile(path.join(dataDir, "native-confirmations", `${receipt.id}.json`), "utf8"));
  assert.equal(stored.principal, principalFromScope(SCOPE));
  assert.equal(stored.action, ACTION);
  assert.equal(stored.paramsDigest, PARAMS);
  assert.equal(stored.stateDigest, STATE);

  await assert.rejects(consume({ principal: "f".repeat(64) }), error => error.code === "CONFIRMATION_PRINCIPAL_MISMATCH" && error.status === 403);
  await assert.rejects(consume({ action: "heartbeat.delete" }), error => error.code === "CONFIRMATION_ACTION_MISMATCH");
  await assert.rejects(consume({ threadId: "thread-2" }), error => error.code === "CONFIRMATION_TARGET_MISMATCH");
  await assert.rejects(consume({ paramsDigest: digestParams({ id: "other" }) }), error => error.code === "CONFIRMATION_PARAMS_MISMATCH");
  await assert.rejects(consume({ stateDigest: digestState("version-2") }), error => error.code === "CONFIRMATION_STALE");

  const consumed = await consume();
  assert.equal(consumed.id, receipt.id);
  await assert.rejects(consume(), error => error.code === "CONFIRMATION_REPLAY");
  await assert.rejects(fs.stat(path.join(dataDir, "native-confirmations", `${receipt.id}.json`)), error => error.code === "ENOENT");
});

test("receipts expire and cannot be replayed across expiry", async t => {
  const { consume, advance } = await issued(t, { ttlMs: 1000 });
  advance(999);
  await assert.rejects(consume({ stateDigest: digestState("version-2") }), error => error.code === "CONFIRMATION_STALE");
  advance(2);
  await assert.rejects(consume(), error => error.code === "CONFIRMATION_EXPIRED" && error.status === 410);
  await assert.rejects(consume(), error => error.code === "CONFIRMATION_REPLAY");
});

test("unknown and malformed receipt ids fail closed", async t => {
  const dataDir = await tempDir(t);
  const store = createConfirmationStore({ dataDir });
  await assert.rejects(
    store.consume({ id: "../escape", principal: "p", action: ACTION, threadId: THREAD, paramsDigest: PARAMS, stateDigest: STATE }),
    error => error.code === "INVALID_CONFIRMATION_ID"
  );
  await assert.rejects(
    store.consume({ id: "a".repeat(32), principal: "p", action: ACTION, threadId: THREAD, paramsDigest: PARAMS, stateDigest: STATE }),
    error => error.code === "CONFIRMATION_REPLAY"
  );
  assert.throws(() => createConfirmationStore({ dataDir: "" }), error => error.status === 500);
  assert.throws(() => createConfirmationStore({ dataDir, ttlMs: 0 }), error => error.code === "INVALID_CONFIRMATION_TTL");
});

test("issue validates every binding and never overwrites an existing receipt", async t => {
  const dataDir = await tempDir(t);
  const store = createConfirmationStore({ dataDir });
  const base = { principal: "p".repeat(64), action: ACTION, threadId: THREAD, paramsDigest: PARAMS, stateDigest: STATE };
  for (const patch of [{ principal: "" }, { action: "" }, { threadId: "" }, { paramsDigest: "bad" }, { stateDigest: "bad" }]) {
    await assert.rejects(store.issue({ ...base, ...patch }), error => error.status === 400);
  }
  const first = await store.issue(base);
  const second = await store.issue(base);
  assert.notEqual(first.id, second.id);
  const files = await fs.readdir(path.join(dataDir, "native-confirmations"));
  assert.equal(files.length, 2);
});
