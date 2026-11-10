import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, mkdir, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const source = fileURLToPath(new URL("../desktop-bridge/file-lease.cs", import.meta.url));
const builds = new Map();
async function executable(dataDir) {
  if (process.platform !== "win32") throw new Error("Native file lease unavailable");
  if (!builds.has(dataDir)) builds.set(dataDir, (async () => {
    const hash = createHash("sha256").update(await readFile(source)).digest("hex").slice(0, 20);
    const dir = path.join(dataDir, "file-lease", hash); await mkdir(dir, { recursive: true });
    const target = path.join(dir, "file-lease.exe");
    try { await access(target); } catch {
      const compiler = path.join(process.env.WINDIR, "Microsoft.NET/Framework64/v4.0.30319/csc.exe");
      await run(compiler, ["/nologo", "/target:exe", "/r:System.Web.Extensions.dll", `/out:${target}`, source], { windowsHide: true, timeout: 20000 });
    }
    return target;
  })().catch(error => { builds.delete(dataDir); throw error; }));
  return builds.get(dataDir);
}

export async function acquireFileLease(dataDir, root, relative, kind) {
  const child = spawn(await executable(dataDir), [], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
  child.stdin.on("error", () => {});
  let closed = false;
  const exit = new Promise(resolve => child.once("close", resolve));
  const close = async () => {
    if (closed) return; closed = true;
    child.stdin.end("RELEASE\n");
    const timer = setTimeout(() => child.kill(), 500); timer.unref();
    await exit; clearTimeout(timer);
  };
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("File lease timeout")), 5000);
      const finish = (error) => { clearTimeout(timer); error ? reject(error) : resolve(); };
      child.once("error", () => finish(new Error("File lease unavailable")));
      child.once("exit", () => finish(new Error("File lease denied")));
      let output = "";
      child.stdout.on("data", chunk => { output += chunk.toString(); if (output.includes("\n")) finish(output.trim() === "READY" ? null : new Error("File lease denied")); });
      child.stdin.write(JSON.stringify({ root, relative, kind }) + "\n");
    });
    return { close, get alive() { return child.exitCode === null && !closed; } };
  } catch (error) { child.kill(); await close(); throw error; }
}
