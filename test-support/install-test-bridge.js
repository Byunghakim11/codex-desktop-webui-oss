import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function installTestBridge(rootDir) {
  const candidates = [process.env.CODEX_WEBUI_TEST_PWSH];
  const where = spawnSync("where.exe", ["pwsh.exe"], { encoding: "utf8", windowsHide: true });
  if (where.status === 0) candidates.push(...where.stdout.trim().split(/\r?\n/));
  candidates.push(path.join(process.env.ProgramFiles || "C:\\Program Files", "PowerShell", "7", "pwsh.exe"));
  const pwsh = candidates.find(value => value && existsSync(value));
  assert.ok(pwsh, "PowerShell 7 is required; set CODEX_WEBUI_TEST_PWSH to its executable");
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "codex-webui-native-test-"));
  const result = spawnSync(pwsh, ["-NoProfile", "-File", path.join(rootDir, "scripts/install-desktop-bridge.ps1"), "-DataDir", dataDir], { cwd: rootDir, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return {
    launcher: path.join(dataDir, "desktop-bridge/runtime/windows-v3/codex-webui-bridge.exe"),
    cleanup: () => rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  };
}
