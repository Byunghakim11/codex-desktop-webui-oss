import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("scoped image serving rejects junction escapes and preserves ordinary images", async t => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "codex-webui-image-security-"));
  const allowed = path.join(fixture, "allowed");
  const outside = path.join(fixture, "outside");
  await mkdir(allowed); await mkdir(outside);
  await writeFile(path.join(allowed, "inside.png"), "INSIDE_FIXTURE");
  await writeFile(path.join(outside, "outside.png"), "OUTSIDE_FIXTURE");
  await symlink(outside, path.join(allowed, "escape"), process.platform === "win32" ? "junction" : "dir");
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const server = spawn(process.execPath, [path.join(rootDir, "server/index.js")], {
    cwd: rootDir, windowsHide: true, stdio: "ignore",
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port), CODEX_WEBUI_TOKEN: "fixture-token", CODEX_WEBUI_THREAD_FILTER_CWD: allowed, CODEX_WEBUI_DATA_DIR: path.join(fixture, "data"), CODEX_WEBUI_TERMINAL_QR: "0", CODEX_DESKTOP_BRIDGE_PIPE: "unavailable-security-fixture" }
  });
  t.after(async () => {
    const exited = new Promise(resolve => server.once("exit", resolve));
    server.kill(); await exited;
    await rm(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/api/info`)).ok) { ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(ready, "fixture server must start");
  const readImage = async (file, headers = {}) => {
    const url = new URL(`http://127.0.0.1:${port}/api/local-file`);
    url.searchParams.set("token", "fixture-token"); url.searchParams.set("path", file);
    return fetch(url, { headers });
  };
  const normal = await readImage(path.join(allowed, "inside.png"));
  assert.equal(normal.status, 200); assert.equal(await normal.text(), "INSIDE_FIXTURE");
  const cached = await readImage(path.join(allowed, "inside.png"), { "if-none-match": normal.headers.get("etag") });
  assert.equal(cached.status, 304);
  assert.equal((await readImage(path.join(outside, "outside.png"))).status, 404);
  assert.equal((await readImage(path.join(allowed, "escape", "outside.png"))).status, 404);
  await mkdir(path.join(allowed, "directory.png"));
  assert.equal((await readImage(path.join(allowed, "directory.png"))).status, 404);
  await t.test("file symlinks remain inside scope and cannot disguise non-images", async subtest => {
    await writeFile(path.join(outside, "outside.txt"), "PRIVATE_FIXTURE");
    try {
      await symlink(path.join(allowed, "inside.png"), path.join(allowed, "alias.png"), "file");
      await symlink(path.join(outside, "outside.png"), path.join(allowed, "escaped-file.png"), "file");
      await symlink(path.join(outside, "outside.txt"), path.join(allowed, "disguised.png"), "file");
    } catch (error) {
      if (["EPERM", "EACCES"].includes(error.code)) return subtest.skip("File symlink creation is unavailable");
      throw error;
    }
    const alias = await readImage(path.join(allowed, "alias.png"));
    assert.equal(alias.status, 200); assert.equal(await alias.text(), "INSIDE_FIXTURE");
    assert.equal((await readImage(path.join(allowed, "escaped-file.png"))).status, 404);
    assert.equal((await readImage(path.join(allowed, "disguised.png"))).status, 404);
  });
});
