import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import {
  CloudflareAccessAuthenticator,
  normalizeCloudflareAccessConfig,
  verifyCloudflareAccessJwt
} from "../server/cloudflare-access.js";

const now = Date.UTC(2026, 7, 21, 8, 0, 0);
const nowSeconds = Math.floor(now / 1000);
const config = {
  teamDomain: "example.cloudflareaccess.com",
  audience: "aud-codex-webui",
  allowedEmails: ["owner@example.com"]
};
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicJwk = { ...publicKey.export({ format: "jwk" }), kid: "test-key", alg: "RS256", use: "sig" };

function jwt(payload = {}) {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "test-key" })).toString("base64url");
  const body = Buffer.from(JSON.stringify({
    iss: "https://example.cloudflareaccess.com",
    aud: "aud-codex-webui",
    email: "owner@example.com",
    sub: "owner",
    nbf: nowSeconds - 10,
    exp: nowSeconds + 3600,
    ...payload
  })).toString("base64url");
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${body}`), privateKey).toString("base64url");
  return `${header}.${body}.${signature}`;
}

test("normalizes a bounded Cloudflare Access configuration", () => {
  assert.deepEqual(normalizeCloudflareAccessConfig({
    teamDomain: "Example.CloudflareAccess.com",
    audience: "aud-codex-webui",
    allowedEmails: ["OWNER@example.com", "owner@example.com"]
  }), {
    teamDomain: "example.cloudflareaccess.com",
    audience: "aud-codex-webui",
    allowedEmails: ["owner@example.com"],
    tokenScopeId: ""
  });
  assert.throws(() => normalizeCloudflareAccessConfig({ teamDomain: "example.com" }), /teamDomain/);
});

test("verifies issuer, audience, signature, expiry and allowed email", () => {
  const identity = verifyCloudflareAccessJwt(jwt(), config, { jwks: [publicJwk], now });
  assert.deepEqual(identity, {
    email: "owner@example.com",
    subject: "owner",
    expiresAt: nowSeconds + 3600
  });
  assert.throws(() => verifyCloudflareAccessJwt(jwt({ aud: "wrong" }), config, { jwks: [publicJwk], now }), /audience/);
  assert.throws(() => verifyCloudflareAccessJwt(jwt({ email: "other@example.com" }), config, { jwks: [publicJwk], now }), /not allowed.*other@example\.com/);
  assert.throws(() => verifyCloudflareAccessJwt(jwt({ exp: nowSeconds - 120 }), config, { jwks: [publicJwk], now }), /expired/);
});

test("authenticator fetches and caches Cloudflare signing keys", async () => {
  let fetches = 0;
  const authenticator = new CloudflareAccessAuthenticator(config, {
    now: () => now,
    fetchImpl: async () => {
      fetches += 1;
      return {
        ok: true,
        status: 200,
        headers: { get: () => "public, max-age=600" },
        json: async () => ({ keys: [publicJwk] })
      };
    }
  });
  const req = { headers: { "cf-access-jwt-assertion": jwt() } };
  assert.equal((await authenticator.authenticateRequest(req)).email, "owner@example.com");
  assert.equal((await authenticator.authenticateRequest(req)).email, "owner@example.com");
  assert.equal(fetches, 1);
  assert.equal(await authenticator.authenticateRequest({ headers: {} }), null);
});
