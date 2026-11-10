import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const rootDir = path.resolve(import.meta.dirname, "..");

test("Desktop-only server browses and creates scoped workspaces without spawning a fallback app-server", { timeout: 15000 }, async (t) => {
  const temp = mkdtempSync(path.join(os.tmpdir(), "codex-webui-api-"));
  const dataDir = path.join(temp, "data");
  const allowedRoot = path.join(temp, "allowed");
  const outsideRoot = path.join(temp, "outside");
  mkdirSync(path.join(allowedRoot, "existing"), { recursive: true });
  mkdirSync(outsideRoot, { recursive: true });
  const port = await freePort();
  const token = "workspace-api-test-token";
  const server = spawn(process.execPath, [path.join(rootDir, "server", "index.js")], {
    cwd: rootDir,
    env: {
      ...process.env,
      CODEX_WEBUI_DATA_DIR: dataDir,
      CODEX_WEBUI_TOKEN_SCOPES: JSON.stringify([{ token, cwds: [allowedRoot] }]),
      CODEX_WEBUI_CODEX_PATH: path.join(temp, "must-not-be-spawned.exe"),
      CODEX_DESKTOP_BRIDGE_PIPE: process.platform === "win32"
        ? `\\\\.\\pipe\\codex-webui-missing-${process.pid}-${Date.now()}`
        : path.join(temp, "missing.sock"),
      CODEX_WEBUI_TERMINAL_QR: "0",
      HOST: "127.0.0.1",
      PORT: String(port)
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  let stdout = "";
  server.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  server.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
  t.after(async () => {
    if (server.exitCode == null) server.kill();
    await Promise.race([
      new Promise((resolve) => server.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 1000))
    ]);
    rmSync(temp, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${port}`;
  const info = await waitForJson(`${base}/api/info?token=${encodeURIComponent(token)}`)
    .catch((error) => {
      throw new Error(`${error.message}\nstdout=${stdout}\nstderr=${stderr}`);
    });
  assert.equal(info.bridgeMode, "desktop", stderr);
  assert.deepEqual(info.capabilities, { projectFiles: process.platform === "win32", projectFilesWrite: process.platform === "win32", threadSettings: true, workspaceBrowser: true });

  const roots = await fetch(`${base}/api/workspaces?token=${encodeURIComponent(token)}`).then((res) => res.json());
  assert.deepEqual(roots.roots.map((entry) => entry.path), [allowedRoot]);

  const listing = await fetch(
    `${base}/api/workspaces?token=${encodeURIComponent(token)}&path=${encodeURIComponent(allowedRoot)}`
  ).then((res) => res.json());
  assert.deepEqual(listing.directories.map((entry) => entry.name), ["existing"]);

  const createResponse = await fetch(`${base}/api/workspaces/create?token=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ parent: allowedRoot, name: "created-on-phone" })
  });
  assert.equal(createResponse.ok, true, await createResponse.text());
  assert.equal(existsSync(path.join(allowedRoot, "created-on-phone")), true);

  const outsideResponse = await fetch(
    `${base}/api/workspaces?token=${encodeURIComponent(token)}&path=${encodeURIComponent(outsideRoot)}`
  );
  assert.equal(outsideResponse.ok, false);
  assert.match((await outsideResponse.json()).error, /outside the allowed directory scope/);
});

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForJson(url) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch {
      // Retry until the isolated server listens.
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error(`Timed out waiting for ${url}`);
}
