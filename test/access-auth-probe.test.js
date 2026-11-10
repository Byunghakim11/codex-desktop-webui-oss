import test from "node:test";
import assert from "node:assert/strict";
import { probeAccessSession } from "../public/access-auth.js";

test("WebSocket failure is not treated as session expiry without an HTTP auth check", async () => {
  assert.equal(await probeAccessSession(async () => ({ ok: true, status: 200, json: async () => ({ authenticated: true, authMode: "cloudflare-access" }) })), "valid");
  for (const status of [401, 403]) assert.equal(await probeAccessSession(async () => ({ status })), "auth-required");
  assert.equal(await probeAccessSession(async () => ({ type: "opaqueredirect", status: 0 })), "auth-required");
  assert.equal(await probeAccessSession(async () => ({ ok: true, json: async () => ({ authenticated: false }) })), "auth-required");
  assert.equal(await probeAccessSession(async () => ({ ok: false, status: 502 })), "unavailable");
  assert.equal(await probeAccessSession(async () => { throw new Error("network failure"); }), "unavailable");
  assert.equal(await probeAccessSession(async () => ({ ok: true, json: async () => { throw new Error("not JSON"); } })), "unavailable");
});
