import assert from "node:assert/strict";
import test from "node:test";
import { authenticatedUrl, authenticationAccepted, webSocketUrl } from "../public/access-auth.js";

test("token mode keeps scoped query authentication", () => {
  assert.equal(authenticatedUrl("/api/info", "cw_secret", "http://192.168.1.2:9526"), "/api/info?token=cw_secret");
  assert.equal(
    webSocketUrl({ protocol: "http:", host: "192.168.1.2:9526" }, "cw_secret"),
    "ws://192.168.1.2:9526/ws?token=cw_secret"
  );
});

test("Cloudflare Access mode uses same-origin cookie/header authentication without a URL token", () => {
  assert.equal(authenticatedUrl("/api/info", "", "https://codex.example.com"), "/api/info");
  assert.equal(
    webSocketUrl({ protocol: "https:", host: "codex.example.com" }, ""),
    "wss://codex.example.com/ws"
  );
  assert.equal(authenticationAccepted({ authenticated: true, authMode: "cloudflare-access" }), true);
  assert.equal(authenticationAccepted({ authenticated: false, authMode: "cloudflare-access" }), false);
});
