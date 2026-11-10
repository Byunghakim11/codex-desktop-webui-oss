import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createTokenRecord,
  findTokenRecord,
  publicTokenRecord,
  readTokenStore,
  resolveDataDir,
  tokenStorePath,
  writeTokenStore
} from "../server/token-store.js";
import { readUsageStore, resetUsage, UsageTracker } from "../server/usage-store.js";

function temporaryDataDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "codex-webui-test-"));
  test.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("uses Codex WebUI data directories and environment variable names", () => {
  assert.equal(
    resolveDataDir({ LOCALAPPDATA: "C:\\LocalData" }, "win32"),
    path.join("C:\\LocalData", "CodexWebUI")
  );
  assert.equal(
    resolveDataDir({ XDG_DATA_HOME: "/var/data" }, "linux"),
    path.join("/var/data", "codex-webui")
  );
  assert.equal(
    resolveDataDir({ CODEX_WEBUI_DATA_DIR: "./custom-data" }, "linux"),
    path.resolve("./custom-data")
  );
});

test("creates one default token without exposing it through public records", () => {
  const dataDir = temporaryDataDir();
  const store = readTokenStore(dataDir);
  assert.equal(store.tokens.length, 1);
  assert.match(store.tokens[0].token, /^cw_[A-Za-z0-9_-]{32}$/);
  const publicRecord = publicTokenRecord(store.tokens[0]);
  assert.equal("token" in publicRecord, false);
  assert.equal(publicRecord.fingerprint.length, 12);
  assert.equal(findTokenRecord(store, "DEFAULT")?.id, "default");
});

test("persists scoped token records outside the repository", () => {
  const dataDir = temporaryDataDir();
  const store = readTokenStore(dataDir);
  store.tokens.push(createTokenRecord({ id: "My Phone", threadFilterCwds: [dataDir] }));
  writeTokenStore(store, dataDir);
  const reloaded = readTokenStore(dataDir);
  assert.equal(reloaded.tokens[1].id, "my-phone");
  assert.deepEqual(reloaded.tokens[1].threadFilterCwds, [path.resolve(dataDir)]);
  assert.equal(tokenStorePath(dataDir).startsWith(dataDir), true);
});

test("usage tracker aggregates and resets per-token statistics", () => {
  const dataDir = temporaryDataDir();
  const tracker = new UsageTracker(dataDir);
  tracker.record("phone", { rpcRequests: 1, bytesIn: 12, bytesOut: 34, method: "thread/list" });
  tracker.record("phone", { rpcRequests: 1, rpcErrors: 1, method: "thread/read" });
  tracker.flush();
  let usage = readUsageStore(dataDir);
  assert.equal(usage.tokens.phone.rpcRequests, 2);
  assert.equal(usage.tokens.phone.rpcErrors, 1);
  assert.equal(usage.tokens.phone.methods["thread/list"], 1);
  resetUsage(dataDir, "phone");
  usage = readUsageStore(dataDir);
  assert.equal(usage.tokens.phone, undefined);
});
