#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const tokenManager = path.join(scriptDir, "token-manager.js");

const result = spawnSync(process.execPath, [tokenManager, ...process.argv.slice(2)], {
  cwd: repoRoot,
  env: { ...process.env, CODEX_WEBUI_COMMAND: "codex-webui" },
  stdio: "inherit"
});

if (result.error) {
  console.error(`Unable to run codex-webui: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
