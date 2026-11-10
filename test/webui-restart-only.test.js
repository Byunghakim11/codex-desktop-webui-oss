import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { startInteractiveFixture } from "../test-support/interactive-fixture.js";

const scriptUrl = new URL("../scripts/restart-webui-only.ps1", import.meta.url);
const scriptPath = fileURLToPath(scriptUrl);
const source = await readFile(scriptUrl, "utf8");
const executableSource=source.replace(/^\s*#.*$/gm,"");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function probePowerShell(command) {
  const result = spawnSync(command, ["-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.Major"], {
    encoding: "utf8", windowsHide: true, timeout: 30000
  });
  if (result.error || result.status !== 0) return null;
  const major = Number(String(result.stdout || "").trim());
  return Number.isInteger(major) && major >= 5 ? { command, major } : null;
}

const parseShell = [process.env.CODEX_WEBUI_TEST_PWSH, "pwsh", "pwsh.exe"].filter(Boolean).map(probePowerShell).find(Boolean) || null;
const shell = process.platform === "win32"
  ? [process.env.CODEX_WEBUI_TEST_PWSH, "pwsh", "pwsh.exe", "powershell.exe"].filter(Boolean).map(probePowerShell).find(Boolean) || null
  : null;
const skip = process.platform !== "win32" ? "Windows only" : (!shell ? "PowerShell (pwsh) is required for the restart helper tests" : false);

function runPowerShell(command) {
  const result = spawnSync(shell.command, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command], {
    encoding: "utf8", windowsHide: true, timeout: 60000
  });
  return { status: result.status, stdout: String(result.stdout || "").trim(), stderr: String(result.stderr || "").trim() };
}

function listenerOwnerPid(port) {
  const output = runPowerShell(`@(Get-NetTCPConnection -LocalPort ${port} -State Listen | Select-Object -ExpandProperty OwningProcess -Unique) -join ','`);
  assert.equal(output.status, 0, output.stderr);
  const pids = output.stdout.split(",").map(value => Number(value.trim())).filter(value => Number.isInteger(value) && value > 0);
  assert.equal(pids.length, 1, `expected exactly one listener on port ${port}, saw "${output.stdout}"`);
  return pids[0];
}

function processAlive(pid) {
  return runPowerShell(`if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { 'alive' } else { 'gone' }`).stdout.includes("alive");
}

function processParentPid(pid) {
  const output = runPowerShell(`(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').ParentProcessId`);
  assert.equal(output.status, 0, output.stderr);
  const value = Number(output.stdout);
  assert.ok(Number.isInteger(value) && value > 0, `unexpected parent pid output "${output.stdout}"`);
  return value;
}

function runHelper(args, env = process.env) {
  const result = spawnSync(shell.command, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath, ...args], {
    encoding: "utf8", windowsHide: true, timeout: 90000, env
  });
  let summary = null;
  try { summary = JSON.parse(String(result.stdout || "").trim()); } catch { summary = null; }
  return { status: result.status, stdout: String(result.stdout || ""), stderr: String(result.stderr || ""), summary };
}

async function startOutsideListener() {
  const outsideRoot = await mkdtemp(path.join(os.tmpdir(), "codex-webui-restart-outside-"));
  const outsideServer = path.join(outsideRoot, "server");
  await mkdir(outsideServer);
  const outsideIndex = path.join(outsideServer, "index.js");
  await writeFile(outsideIndex, "import net from 'node:net';\nconst server = net.createServer();\nserver.listen(0, '127.0.0.1', () => process.stdout.write(`${server.address().port}\\n`));\n", "utf8");
  const child = spawn(process.execPath, [outsideIndex], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const port = await new Promise((resolve, reject) => {
    let buffered = "", timer = setTimeout(() => reject(new Error("outside listener did not report a port")), 15000);
    child.stdout.on("data", chunk => {
      buffered += chunk.toString("utf8");
      const match = buffered.match(/(\d{2,5})\s*\n/);
      if (match) { clearTimeout(timer); resolve(Number(match[1])); }
    });
    child.once("error", error => { clearTimeout(timer); reject(error); });
  });
  return { outsideRoot, child, port };
}

async function closeOutsideListener(target) {
  if (target.child.exitCode === null) target.child.kill();
  await delay(150);
  const resolved=path.resolve(target.outsideRoot);
  assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));assert.ok(path.basename(resolved).startsWith("codex-webui-restart-outside-"));
  await rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

test("restart helper source keeps production setup and global state untouched", () => {
  assert.match(source, /\[Parameter\(Mandatory = \$true\)\]\[int\]\$ExpectedPid/);
  assert.match(source, /\[int\]\$ExpectedParentPid/);
  assert.match(source, /\[int\]\$Port/);
  assert.match(source, /\[string\]\$DataDir/);
  assert.match(source, /\[switch\]\$PlanOnly/);
  assert.match(source, /Resolve-Path \(Join-Path \$PSScriptRoot "\.\."\)|Get-NormalizedPath \(Join-Path \$PSScriptRoot "\.\."\)/);
  assert.match(source, /server\/index\.js/);
  assert.match(source, /Get-NetTCPConnection -LocalPort \$PortNumber -State Listen/);
  assert.match(source, /Stop-Process -Id \$ExpectedPid/);
  assert.match(source, /Start-Process -FilePath \$NodeExecutable -ArgumentList \$startArguments/);
  assert.match(source, /-WindowStyle Hidden/);
  assert.match(source, /-RedirectStandardOutput \$OutLog -RedirectStandardError \$ErrLog/);
  assert.match(source, /desktop-bridge/);
  assert.match(source, /codex-webui\.pid/);
  assert.match(source, /Set-Content -LiteralPath \$PidFile -Value \(\[string\]\$script:NewPid\) -Encoding ascii/);
  assert.match(source, /sourceBuildhash/);
  assert.match(source, /parentBrokerPreserved = \$true/);
  assert.match(source, /manual-shared-engine/);
  assert.match(source, /managed-handoff/);
  assert.match(source, /desktop-broker\.js/);
  assert.doesNotMatch(executableSource, /taskkill/i);
  assert.doesNotMatch(executableSource, /\/T\b/);
  assert.doesNotMatch(source, /Stop-Process\s+-(?:Name|Id)\s+\$(?!ExpectedPid)/);
  assert.doesNotMatch(source, /(?:npm|npx|yarn|pnpm)\s+(?:run|install|link|start|exec)/i);
  assert.doesNotMatch(source, /scripts[\\/]start-codex-webui\.ps1/);
  assert.doesNotMatch(source, /SetEnvironmentVariable/);
  assert.doesNotMatch(source, /\[EnvironmentVariableTarget\]::(?:User|Machine)/);
  assert.doesNotMatch(source, /Copy-Item[^\n]*app\.js/i);
  assert.doesNotMatch(source, /Get-Content[^\n]*desktop-bridge/i);
  assert.doesNotMatch(source, /Write-(?:Host|Output)[^\n]*(?:CommandLine|token|secret)/i);
});

test("restart helper parses as valid PowerShell", { skip: !parseShell ? "pwsh is required to parse PowerShell" : false }, () => {
  const escapedPath = scriptPath.replaceAll("'", "''");
  const command = [
    "$errors = $null",
    "$tokens = $null",
    `[void][System.Management.Automation.Language.Parser]::ParseFile('${escapedPath}', [ref]$tokens, [ref]$errors)`,
    "if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Error $_.Message }; exit 1 }",
    "Write-Output 'parsed'",
  ].join("; ");
  const result = spawnSync(parseShell.command, ["-NoProfile", "-NonInteractive", "-Command", command], { encoding: "utf8", windowsHide: true, timeout: 60000 });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test("restart helper plans only for the owned WebUI listener and refuses foreign targets", { skip }, async (t) => {
  const fixture = await startInteractiveFixture();
  try {
    const ownerPid = listenerOwnerPid(fixture.port);
    assert.equal(processParentPid(ownerPid), fixture.broker.pid, "fixture WebUI should be owned by the fixture broker");
    assert.equal(fixture.broker.exitCode, null);

    await t.test("unverified environment refuses before stopping the owned listener",async()=>{
      const result=runHelper(["-ExpectedPid",String(ownerPid),"-ExpectedParentPid",String(fixture.broker.pid),"-Port",String(fixture.port),"-HostAddress","127.0.0.1","-DataDir",fixture.dataDir]);
      assert.equal(result.summary?.code,"environment-unverified");assert.equal(result.summary?.oldPidStopped,false);assert.equal(processAlive(ownerPid),true);assert.equal(listenerOwnerPid(fixture.port),ownerPid);
    });
    await t.test("token overrides refuse before stopping even with verification switch",async()=>{
      const result=runHelper(["-FileConfigurationVerified","-ExpectedPid",String(ownerPid),"-ExpectedParentPid",String(fixture.broker.pid),"-Port",String(fixture.port),"-HostAddress","127.0.0.1","-DataDir",fixture.dataDir],{...process.env,CODEX_WEBUI_TOKEN:"synthetic-test-override"});
      assert.equal(result.summary?.code,"environment-override");assert.equal(result.summary?.oldPidStopped,false);assert.equal(processAlive(ownerPid),true);assert.equal(listenerOwnerPid(fixture.port),ownerPid);
    });

    await t.test("plan only returns a safe managed-handoff plan without mutations", async () => {
      const before = await readdir(fixture.dataDir);
      const plan = runHelper([
        "-PlanOnly",
        "-ExpectedPid", String(ownerPid),
        "-ExpectedParentPid", String(fixture.broker.pid),
        "-Port", String(fixture.port),
        "-HostAddress", "127.0.0.1",
        "-DataDir", fixture.dataDir
      ]);
      assert.equal(plan.status, 0, `${plan.stderr}\n${plan.stdout}`);
      assert.ok(plan.summary, `expected JSON summary, saw "${plan.stdout}"`);
      assert.equal(plan.summary.ok, true);
      assert.equal(plan.summary.planOnly, true);
      assert.equal(plan.summary.mode, "managed-handoff");
      assert.equal(plan.summary.oldPid, ownerPid);
      assert.equal(plan.summary.parentBrokerPid, fixture.broker.pid);
      assert.equal(plan.summary.port, fixture.port);
      assert.equal(plan.summary.bridgeSecretPresent, true);
      assert.equal(plan.summary.preserved.desktop, true);
      assert.equal(plan.summary.preserved.broker, true);
      assert.equal(plan.summary.preserved.codexEngine, true);
      const expectedIndex = path.join(fixture.rootDir, "server", "index.js");
      assert.equal(path.resolve(plan.summary.indexPath).toLowerCase(), expectedIndex.toLowerCase());
      assert.equal(path.resolve(plan.summary.wouldRun.workingDirectory).toLowerCase(), fixture.rootDir.toLowerCase());
      assert.equal(path.basename(plan.summary.nodeExecutable).toLowerCase(), "node.exe");
      assert.ok(existsSync(plan.summary.nodeExecutable), "planned node executable must exist");
      assert.match(String(plan.summary.sourceBuildhash), /^[0-9a-f]{64}$/);
      const logs = [plan.summary.wouldRun.stdoutLog, plan.summary.wouldRun.stderrLog];
      for (const logPath of logs) {
        assert.equal(await realpath(path.dirname(logPath)), await realpath(fixture.dataDir));
        assert.equal(existsSync(logPath), false, `plan must not create log files: ${logPath}`);
      }
      assert.equal(existsSync(path.join(fixture.dataDir, "codex-webui.pid")), false, "PlanOnly must not write a PID file");
      assert.equal(plan.summary.wouldRun.manifestFile.includes("codex-webui.restart-manifest."), true);
      assert.equal(existsSync(plan.summary.wouldRun.manifestFile), false, "PlanOnly must not write a launch manifest");
      const after = await readdir(fixture.dataDir);
      assert.deepEqual(after.filter(name=>name!=="usage.json").sort(), before.filter(name=>name!=="usage.json").sort(), "PlanOnly must not mutate the data directory");
      assert.doesNotMatch(JSON.stringify(plan.summary), /commandline|executablePath|command_line/i);
      assert.equal(listenerOwnerPid(fixture.port), ownerPid, "PlanOnly must not disturb the owned listener");
      assert.equal(processAlive(ownerPid), true);
    });

    await t.test("manual mode requires a matching recorded PID file", async () => {
      const refused = runHelper(["-PlanOnly", "-ExpectedPid", String(ownerPid), "-Port", String(fixture.port), "-DataDir", fixture.dataDir]);
      assert.notEqual(refused.status, 0);
      assert.equal(refused.summary?.ok, false);
      assert.equal(refused.summary?.code, "pidfile-missing");
      assert.equal(existsSync(path.join(fixture.dataDir, "codex-webui.pid")), false);

      const pidFile = path.join(fixture.dataDir, "codex-webui.pid");
      await writeFile(pidFile, `${ownerPid}\r\n`, "ascii");
      try {
        const plan = runHelper(["-PlanOnly", "-ExpectedPid", String(ownerPid), "-Port", String(fixture.port), "-DataDir", fixture.dataDir]);
        assert.equal(plan.status, 0, `${plan.stderr}\n${plan.stdout}`);
        assert.equal(plan.summary.ok, true);
        assert.equal(plan.summary.mode, "manual-shared-engine");
        assert.equal(plan.summary.pidFilePid, ownerPid);
        assert.equal(String(await readFile(pidFile, "utf8")).trim(), String(ownerPid), "PlanOnly must not rewrite the PID file");
      } finally {
        await rm(pidFile, { force: true });
      }
    });

    await t.test("a non-owner expected pid is refused without stopping anything", async () => {
      const before = await readdir(fixture.dataDir);
      const refused = runHelper([
        "-PlanOnly",
        "-ExpectedPid", String(fixture.broker.pid),
        "-ExpectedParentPid", String(fixture.broker.pid),
        "-Port", String(fixture.port),
        "-DataDir", fixture.dataDir
      ]);
      assert.notEqual(refused.status, 0);
      assert.equal(refused.summary?.ok, false);
      assert.equal(refused.summary?.code, "port-owner-mismatch");
      assert.equal(refused.summary?.oldPidStopped, false);
      assert.equal(listenerOwnerPid(fixture.port), ownerPid);
      assert.equal(processAlive(ownerPid), true);
      assert.equal(processAlive(fixture.broker.pid), true);
      assert.equal(fixture.broker.exitCode, null);
      assert.deepEqual((await readdir(fixture.dataDir)).sort(), before.sort());
    });

    await t.test("an unrelated expected parent pid is refused", async () => {
      const refused = runHelper([
        "-PlanOnly",
        "-ExpectedPid", String(ownerPid),
        "-ExpectedParentPid", String(process.pid),
        "-Port", String(fixture.port),
        "-DataDir", fixture.dataDir
      ]);
      assert.notEqual(refused.status, 0);
      assert.equal(refused.summary?.code, "parent-mismatch");
      assert.equal(processAlive(ownerPid), true);
      assert.equal(listenerOwnerPid(fixture.port), ownerPid);
    });

    await t.test("a different server/index.js installation is refused", async () => {
      const outside = await startOutsideListener();
      try {
        assert.equal(listenerOwnerPid(outside.port), Number(outside.child.pid));
        const refused = runHelper(["-PlanOnly", "-ExpectedPid", String(outside.child.pid), "-Port", String(outside.port), "-DataDir", fixture.dataDir]);
        assert.notEqual(refused.status, 0);
        assert.equal(refused.summary?.ok, false);
        assert.equal(refused.summary?.code, "index-argument-foreign");
        assert.equal(processAlive(Number(outside.child.pid)), true, "refusal must not stop the foreign listener");
        assert.equal(listenerOwnerPid(outside.port), Number(outside.child.pid));
      } finally {
        await closeOutsideListener(outside);
      }
    });

    await t.test("the fixture listener and broker survive every refusal", async () => {
      assert.equal(listenerOwnerPid(fixture.port), ownerPid);
      assert.equal(processAlive(fixture.broker.pid), true);
      const probe = await new Promise(resolve => {
        const socket = net.connect(fixture.port, "127.0.0.1");
        socket.once("connect", () => { socket.destroy(); resolve(true); });
        socket.once("error", () => resolve(false));
      });
      assert.equal(probe, true, "the fixture WebUI must still be listening");
    });
  } finally {
    await fixture.close();
  }
});
