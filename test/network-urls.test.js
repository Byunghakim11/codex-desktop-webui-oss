import assert from "node:assert/strict";
import test from "node:test";
import { getLanUrls, getPrimaryLanUrl } from "../server/network-urls.js";

test("prefers a private LAN address and skips tunnel benchmark addresses", () => {
  const interfaces = {
    TunnelAdapter: [{ family: "IPv4", address: "198.18.0.1", internal: false }],
    Ethernet: [{ family: "IPv4", address: "192.168.1.20", internal: false }]
  };

  assert.equal(getPrimaryLanUrl(9526, interfaces), "http://192.168.1.20:9526");
  assert.deepEqual(getLanUrls(9526, interfaces), ["http://192.168.1.20:9526"]);
});

test("orders private LAN addresses before other usable IPv4 addresses", () => {
  const interfaces = {
    Public: [{ family: "IPv4", address: "203.0.113.5", internal: false }],
    Private: [{ family: 4, address: "10.0.0.8", internal: false }]
  };

  assert.deepEqual(getLanUrls(8080, interfaces), [
    "http://10.0.0.8:8080",
    "http://203.0.113.5:8080"
  ]);
});

test("skips internal and link-local addresses and falls back to localhost", () => {
  const interfaces = {
    Loopback: [{ family: "IPv4", address: "127.0.0.1", internal: true }],
    LinkLocal: [{ family: "IPv4", address: "169.254.10.20", internal: false }]
  };

  assert.deepEqual(getLanUrls(9526, interfaces), ["http://localhost:9526"]);
});
