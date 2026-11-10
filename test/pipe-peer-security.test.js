import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { before, after } from "node:test";
import { DesktopBridgeConnection } from "../server/desktop-bridge-client.js";
import { installTestBridge } from "../test-support/install-test-bridge.js";

let fixture;
before(async () => {
  if (process.platform !== "win32") return;
  fixture = await installTestBridge(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
  process.env.CODEX_WEBUI_PIPE_CLIENT_PATH = fixture.launcher;
});
after(async () => { if (fixture) await fixture.cleanup(); });

test("Windows pipe client rejects a different Node program without disclosing the secret", { skip: process.platform !== "win32" }, async () => {
  const pipe = `\\\\.\\pipe\\codex-webui-untrusted-${randomUUID()}`;
  const peers = new Set();
  let receivedBytes = 0;
  const fake = net.createServer(socket => {
    peers.add(socket); socket.on("close", () => peers.delete(socket));
    socket.on("data", bytes => {
      receivedBytes += bytes.length;
      socket.write(`${JSON.stringify({ type: "hello", ok: true })}\n`);
    });
  });
  await new Promise(resolve => fake.listen(pipe, resolve));
  const client = new DesktopBridgeConnection({ resolvePipePath: () => pipe, resolveSecret: async () => "DUMMY_SECRET_ONLY" });
  try {
    await assert.rejects(client.connect(), /peer|identity|verification|broker/i);
    assert.equal(receivedBytes, 0);
    assert.equal(client.isConnected(), false);
  } finally {
    client.socket?.destroy(); for (const socket of peers) socket.destroy();
    await new Promise(resolve => fake.close(resolve));
  }
});
