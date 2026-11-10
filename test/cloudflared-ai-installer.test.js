import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptUrl = new URL("../scripts/install-cloudflared-ai.ps1", import.meta.url);
const scriptPath = fileURLToPath(scriptUrl);
const source = await readFile(scriptUrl, "utf8");
const accessScriptUrl = new URL("../scripts/configure-cloudflare-access.ps1", import.meta.url);
const accessScriptPath = fileURLToPath(accessScriptUrl);
const accessSource = await readFile(accessScriptUrl, "utf8");
const startScriptUrl = new URL("../scripts/start-codex-webui.ps1", import.meta.url);
const startScriptPath = fileURLToPath(startScriptUrl);
const startSource = await readFile(startScriptUrl, "utf8");

test("CloudflaredAI installer keeps tokens out of command arguments and tracked defaults", () => {
  assert.match(source, /\$ServiceName\s*=\s*"CloudflaredAI"/);
  assert.match(source, /--token-file/);
  assert.match(source, /Read-Host[^\n]+-AsSecureString/);
  assert.match(source, /Get-TunnelIdFromToken/);
  assert.match(source, /\$ExpectedTunnelId/);
  assert.doesNotMatch(source, /service\s+install/i);
  assert.doesNotMatch(source, /\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/i);
  assert.doesNotMatch(source, /--token\s+\$TunnelToken/);
});

test("CloudflaredAI installer explicitly protects the unrelated MCP service", () => {
  assert.match(source, /\$ProtectedServiceName\s*=\s*"Cloudflared"/);
  assert.match(source, /ProtectedMcpServiceUnchanged/);
  assert.match(source, /Refusing to reuse \$ServiceName/);
  assert.doesNotMatch(source, /(?:Stop|Restart|Set|Remove)-Service\s+(?:-Name\s+)?\$ProtectedServiceName/);
  assert.doesNotMatch(source, /netsh|New-NetFirewallRule|Set-NetFirewallRule|Remove-NetFirewallRule/i);
});

test("CloudflaredAI installer has valid PowerShell syntax on Windows", { skip: process.platform !== "win32" }, () => {
  const escapedPaths = [scriptPath, accessScriptPath, startScriptPath].map((entry) => entry.replaceAll("'", "''"));
  const command = [
    "$errors = $null",
    "$tokens = $null",
    ...escapedPaths.map((entry) => `[void][System.Management.Automation.Language.Parser]::ParseFile('${entry}', [ref]$tokens, [ref]$errors)`),
    "if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Error $_ }; exit 1 }",
  ].join("; ");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test("Cloudflare Access configurator discovers metadata without logging the redirect assertion", () => {
  assert.match(accessSource, /cloudflare-access\.json/);
  assert.match(accessSource, /cloudflareaccess\\\.com/);
  assert.match(accessSource, /AudienceFingerprint/);
  assert.doesNotMatch(accessSource, /Write-(?:Host|Output).*MetaToken/i);
});

test("background restart can suppress QR and token URL output", () => {
  assert.match(startSource, /\[switch\]\$NoQr/);
  assert.match(startSource, /if \(!\$NoQr\)/);
});
