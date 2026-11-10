import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { runProjectWriter, createProjectWriterTestRuntime, RECOVERY_CONTRACT, ProjectWriterError } from "../server/native-project-writer.js";

const execFileAsync = promisify(execFile);

const win = process.platform === "win32";
const native = { skip: !win, timeout: 180000 };
const id = () => createHash("sha256").update(`${process.pid}:${Math.random()}:${Date.now()}`).digest("hex").slice(0, 32);
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const error = (status, code) => e => e instanceof ProjectWriterError && e.status === status && e.code === code;

async function fixture(t, prefix = "pw-") {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const dataDir = path.join(temp, "runtime");
  const root = path.join(temp, "project");
  await fs.mkdir(dataDir);
  await fs.mkdir(root);
  return { temp, dataDir, root };
}
async function stage(dataDir, bytes, name = `${id()}.stage`) {
  const dir = path.join(dataDir, "staging");
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  await fs.writeFile(file, bytes);
  return { file, hash: sha(bytes) };
}
const base = (dataDir, kind, root, relativePath, extra = {}) => ({
  id: id(), kind, root, relativePath, ...extra
});

test("maximum supported text with JSON escaping opens byte-exactly",native,async t=>{
 const {dataDir,root}=await fixture(t);const text='"'.repeat(1024*1024);
 await fs.writeFile(path.join(root,'escaped.txt'),text);
 const result=await runProjectWriter({dataDir,operation:base(dataDir,'edit-open',root,'escaped.txt'),authorizePrepared:async()=>true});
 assert.equal(result.editable,true);assert.equal(result.text,text);assert.equal(result.size,1024*1024);
});

test("operation ids, kinds, roots, relative leaves and unknown fields are strictly rejected", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "pw-validate-"));
  const dataDir = path.join(temp, "runtime");
  await fs.mkdir(dataDir);
  const root = "C:\\project";
  const auth = async () => true;
  const cases = [
    { id: "A".repeat(32), kind: "context", root, relativePath: "" },
    { id: "a".repeat(31), kind: "context", root, relativePath: "" },
    { id: "a".repeat(32), kind: "rename", root, relativePath: "" },
    { id: "a".repeat(32), kind: "context", root: "project", relativePath: "" },
    { id: "a".repeat(32), kind: "context", root: "\\\\server\\share", relativePath: "" },
    { id: "a".repeat(32), kind: "context", root, relativePath: "" , extra: true },
    { id: "a".repeat(32), kind: "mkdir", root, relativePath: "" },
    { id: "a".repeat(32), kind: "mkdir", root, relativePath: "a/../b" },
    { id: "a".repeat(32), kind: "mkdir", root, relativePath: "a//b" },
    { id: "a".repeat(32), kind: "mkdir", root, relativePath: "/a" },
    { id: "a".repeat(32), kind: "mkdir", root, relativePath: "a\\b" },
    { id: "a".repeat(32), kind: "mkdir", root, relativePath: "a:stream" },
    { id: "a".repeat(32), kind: "mkdir", root, relativePath: "CON" },
    { id: "a".repeat(32), kind: "mkdir", root, relativePath: "com¹.txt" },
    { id: "a".repeat(32), kind: "mkdir", root, relativePath: "CONIN$.txt" },
    { id: "a".repeat(32), kind: "mkdir", root, relativePath: "trail. " },
    { id: "a".repeat(32), kind: "mkdir", root, relativePath: "bad<name" },
    { id: "a".repeat(32), kind: "mkdir", root, relativePath: "docs", expectedVersion: "v1.1-1-1." + "a".repeat(64) },
    { id: "a".repeat(32), kind: "upload", root, relativePath: "a.txt" },
    { id: "a".repeat(32), kind: "upload", root, relativePath: "a.txt", stagedPath: path.join(dataDir, "x"), stagedHash: "A".repeat(64) },
    { id: "a".repeat(32), kind: "save-text", root, relativePath: "a.txt", stagedPath: path.join(dataDir, "x"), stagedHash: "a".repeat(64) },
    { id: "a".repeat(32), kind: "save-text", root, relativePath: "a.txt", stagedPath: path.join(dataDir, "x"), stagedHash: "a".repeat(64), expectedVersion: "bad", recoveryBinding: "a".repeat(64) }
  ];
  for (const operation of cases) await assert.rejects(runProjectWriter({ dataDir, operation, authorizePrepared: auth }), error(400, "INVALID_OPERATION"));
  await assert.rejects(runProjectWriter({ dataDir, operation: cases[0], authorizePrepared: auth }), e => e.status === 400);
  await assert.rejects(runProjectWriter({ dataDir, operation: { id: "a".repeat(32), kind: "mkdir", root, relativePath: ".env" }, authorizePrepared: auth }), e => [400, 403].includes(e.status));
  await fs.rm(temp, { recursive: true, force: true });
});

test("missing or non-function authorization and an aborted signal prevent all native work", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "pw-auth-"));
  const dataDir = path.join(temp, "runtime");
  await fs.mkdir(dataDir);
  const operation = base(dataDir, "mkdir", "C:\\project", "docs");
  await assert.rejects(runProjectWriter({ dataDir, operation }), error(403, "AUTHORIZATION_REQUIRED"));
  await assert.rejects(runProjectWriter({ dataDir, operation, authorizePrepared: null }), error(403, "AUTHORIZATION_REQUIRED"));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runProjectWriter({ dataDir, operation, authorizePrepared: async () => true, signal: controller.signal }), error(499, "CANCELLED"));
  await fs.rm(temp, { recursive: true, force: true });
});

test("staged payloads outside dataDir, linked or with wrong hash/size are rejected before native work", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "pw-stage-"));
  const dataDir = path.join(temp, "runtime");
  const staging = path.join(dataDir, "staging");
  await fs.mkdir(staging, { recursive: true });
  const outside = path.join(temp, "outside.bin");
  await fs.writeFile(outside, "OUTSIDE");
  const inside = path.join(staging, "inside.txt");
  await fs.writeFile(inside, "hello");
  const root = "C:\\project";
  const auth = async () => true;
  await assert.rejects(runProjectWriter({ dataDir, operation: base(dataDir, "upload", root, "a.txt", { stagedPath: outside, stagedHash: sha("OUTSIDE") }), authorizePrepared: auth }), error(403, "STAGE_INVALID"));
  await assert.rejects(runProjectWriter({ dataDir, operation: base(dataDir, "upload", root, "a.txt", { stagedPath: inside, stagedHash: sha("wrong") }), authorizePrepared: auth }), error(409, "STAGE_CHANGED"));
  const link = path.join(staging, "link.txt");
  await fs.symlink(inside, link);
  await assert.rejects(runProjectWriter({ dataDir, operation: base(dataDir, "upload", root, "a.txt", { stagedPath: link, stagedHash: sha("hello") }), authorizePrepared: auth }), error(403, "STAGE_INVALID"));
  const cr = path.join(staging, "cr.txt");
  await fs.writeFile(cr, "hello\r\n");
  await assert.rejects(runProjectWriter({ dataDir, operation: base(dataDir, "save-text", root, "a.txt", { stagedPath: cr, stagedHash: sha("hello\r\n"), expectedVersion: "v1.1-1-1." + "a".repeat(64), recoveryBinding: "a".repeat(64) }), authorizePrepared: auth }), error(400, "STAGE_INVALID"));
  await fs.rm(temp, { recursive: true, force: true });
});

test("non-Windows refuses to fall back to fs writes", { skip: win }, async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "pw-offwin-"));
  const dataDir = path.join(temp, "runtime");
  await fs.mkdir(dataDir);
  await assert.rejects(runProjectWriter({ dataDir, operation: base(dataDir, "mkdir", "C:\\project", "docs"), authorizePrepared: async () => true }), error(503, "NATIVE_UNAVAILABLE"));
  await fs.rm(temp, { recursive: true, force: true });
});

test("context, mkdir and volume-root rejection", native, async t => {
  const { dataDir, root } = await fixture(t);
  const auth = async () => true;
  const context = await runProjectWriter({ dataDir, operation: base(dataDir, "context", root, ""), authorizePrepared: auth });
  assert.equal(context.kind, "directory");
  assert.equal(typeof context.rootIdentity, "string");
  assert.equal(typeof context.parentIdentity, "string");
  assert.match(context.rootIdentity, /^[0-9a-f]+-[0-9a-f]+-[0-9a-f]+$/);
  const nested = path.join(root, "a", "b");
  await fs.mkdir(nested, { recursive: true });
  const sub = await runProjectWriter({ dataDir, operation: base(dataDir, "context", root, "a/b"), authorizePrepared: auth });
  assert.equal(sub.path, "a/b");
  const made = await runProjectWriter({ dataDir, operation: base(dataDir, "mkdir", root, "docs"), authorizePrepared: auth });
  assert.equal(made.kind, "directory");
  assert.equal((await fs.stat(path.join(root, "docs"))).isDirectory(), true);
  await assert.rejects(runProjectWriter({ dataDir, operation: base(dataDir, "mkdir", root, "docs"), authorizePrepared: auth }), error(409, "ALREADY_EXISTS"));
  await fs.writeFile(path.join(root, "file.txt"), "x");
  await assert.rejects(runProjectWriter({ dataDir, operation: base(dataDir, "mkdir", root, "file.txt"), authorizePrepared: auth }), error(409, "ALREADY_EXISTS"));
  await assert.rejects(runProjectWriter({ dataDir, operation: base(dataDir, "context", path.parse(root).root, ""), authorizePrepared: auth }), error(403, "PROJECT_UNAVAILABLE"));
});

test("upload is no-clobber for files, directories and concurrent race winners", native, async t => {
  const { dataDir, root } = await fixture(t);
  const auth = async () => true;
  const bytes = Buffer.from("UPLOAD_CONTENT");
  await fs.mkdir(path.join(root, "dir"));
  const first = await stage(dataDir, bytes);
  const made = await runProjectWriter({ dataDir, operation: base(dataDir, "upload", root, "dir/a.txt", { stagedPath: first.file, stagedHash: first.hash }), authorizePrepared: auth });
  assert.equal(made.kind, "file");
  assert.equal(made.size, bytes.length);
  assert.match(made.version, /^v1\./);
  assert.deepEqual(await fs.readFile(path.join(root, "dir", "a.txt")), bytes);
  const second = await stage(dataDir, Buffer.from("OTHER"));
  await assert.rejects(runProjectWriter({ dataDir, operation: base(dataDir, "upload", root, "dir/a.txt", { stagedPath: second.file, stagedHash: second.hash }), authorizePrepared: auth }), error(409, "ALREADY_EXISTS"));
  assert.deepEqual(await fs.readFile(path.join(root, "dir", "a.txt")), bytes);
  await fs.mkdir(path.join(root, "folder"));
  await assert.rejects(runProjectWriter({ dataDir, operation: base(dataDir, "upload", root, "folder", { stagedPath: second.file, stagedHash: second.hash }), authorizePrepared: auth }), error(409, "ALREADY_EXISTS"));
  const results = await Promise.allSettled([1, 2, 3].map(async n => {
    const s = await stage(dataDir, Buffer.from(`RACE_${n}`));
    return runProjectWriter({ dataDir, operation: base(dataDir, "upload", root, "race.txt", { stagedPath: s.file, stagedHash: s.hash }), authorizePrepared: auth });
  }));
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(results.filter(r => r.status === "rejected" && r.reason.code === "ALREADY_EXISTS").length, 2);
  assert.equal(await fs.readFile(path.join(root, "race.txt"), "utf8"), "RACE_" + (results.findIndex(r => r.status === "fulfilled") + 1));
});

test("denial, abort before commit and signal cancellation never mutate and leave no owned temp", native, async t => {
  const { dataDir, root } = await fixture(t);
  const ctx = await runProjectWriter({ dataDir, operation: base(dataDir, "context", root, ""), authorizePrepared: async () => true });
  assert.ok(ctx.rootIdentity);
  await assert.rejects(runProjectWriter({ dataDir, operation: base(dataDir, "mkdir", root, "denied"), authorizePrepared: async () => false }), error(403, "AUTHORIZATION_DENIED"));
  await assert.rejects(runProjectWriter({ dataDir, operation: base(dataDir, "mkdir", root, "thrown"), authorizePrepared: async () => { throw new Error("no"); } }), error(403, "AUTHORIZATION_DENIED"));
  const controller = new AbortController();
  await assert.rejects(runProjectWriter({ dataDir, operation: base(dataDir, "mkdir", root, "aborted"), authorizePrepared: async () => { controller.abort(); return true; }, signal: controller.signal }), error(499, "CANCELLED"));
  for (const name of ["denied", "thrown", "aborted"]) await assert.rejects(fs.stat(path.join(root, name)), e => e.code === "ENOENT");
  const leftovers = (await fs.readdir(root)).filter(name => name.startsWith("pw-") || name.startsWith(".pw-"));
  assert.deepEqual(leftovers, []);
});

test("complete UTF-8 edit read and save round-trips BOM, CRLF and version", native, async t => {
  const { dataDir, root } = await fixture(t);
  const auth = async () => true;
  const original = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("first\r\n둘째\r\n")]);
  await fs.writeFile(path.join(root, "note.md"), original);
  const opened = await runProjectWriter({ dataDir, operation: base(dataDir, "edit-open", root, "note.md"), authorizePrepared: auth });
  assert.equal(opened.bom, true);
  assert.equal(opened.eol, "crlf");
  assert.equal(opened.editable, true);
  assert.equal(opened.text, "first\r\n둘째\r\n");
  assert.match(opened.version, /^v1\./);
  const normalized = "first\n둘째\nthird\n";
  const s = await stage(dataDir, Buffer.from(normalized));
  const saved = await runProjectWriter({ dataDir, operation: base(dataDir, "save-text", root, "note.md", { stagedPath: s.file, stagedHash: s.hash, expectedVersion: opened.version, recoveryBinding: id() + id() }), authorizePrepared: auth });
  assert.notEqual(saved.newVersion, opened.version);
  const reread = await fs.readFile(path.join(root, "note.md"));
  assert.deepEqual(reread, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("first\r\n둘째\r\nthird\r\n")]));
  const reopened = await runProjectWriter({ dataDir, operation: base(dataDir, "edit-open", root, "note.md"), authorizePrepared: auth });
  assert.equal(reopened.version, saved.newVersion);
  const recoveryDir = path.join(dataDir, "project-writes", "recoveries");
  assert.deepEqual(await fs.readdir(recoveryDir).catch(() => []), []);
});

test("same-size external edits conflict and expectedVersion is required", native, async t => {
  const { dataDir, root } = await fixture(t);
  const auth = async () => true;
  await fs.writeFile(path.join(root, "same.txt"), "AAAA");
  const opened = await runProjectWriter({ dataDir, operation: base(dataDir, "edit-open", root, "same.txt"), authorizePrepared: auth });
  await fs.writeFile(path.join(root, "same.txt"), "BBBB");
  const s = await stage(dataDir, Buffer.from("CCCC\n"));
  await assert.rejects(runProjectWriter({ dataDir, operation: base(dataDir, "save-text", root, "same.txt", { stagedPath: s.file, stagedHash: s.hash, expectedVersion: opened.version, recoveryBinding: id() + id() }), authorizePrepared: auth }), error(409, "VERSION_CONFLICT"));
  assert.equal(await fs.readFile(path.join(root, "same.txt"), "utf8"), "BBBB");
});

test("binary, invalid UTF-8, mixed EOL and oversized text stay read-only", native, async t => {
  const { dataDir, root } = await fixture(t);
  const auth = async () => true;
  const files = {
    "binary.txt": Buffer.from([0, 1, 2, 3]),
    "invalid.txt": Buffer.from([0xff, 0xfe, 0xff]),
    "mixed.txt": Buffer.from("a\r\nb\nc"),
    "lonecr.txt": Buffer.from("a\rb"),
    "large.txt": Buffer.from("가".repeat(400000))
  };
  for (const [name, bytes] of Object.entries(files)) await fs.writeFile(path.join(root, name), bytes);
  for (const name of Object.keys(files)) {
    const opened = await runProjectWriter({ dataDir, operation: base(dataDir, "edit-open", root, name), authorizePrepared: auth });
    assert.equal(opened.editable, false, name);
    assert.equal(typeof opened.reason, "string", name);
    assert.equal(opened.text, null, name);
  }
  const s = await stage(dataDir, Buffer.from("ok"));
  await assert.rejects(runProjectWriter({ dataDir, operation: base(dataDir, "save-text", root, "mixed.txt", { stagedPath: s.file, stagedHash: s.hash, expectedVersion: "v1.1-1-1." + "a".repeat(64), recoveryBinding: id() + id() }), authorizePrepared: auth }), e => e.status === 409 || e.status === 415);
});

test("junctions, hardlinks, case and Unicode-folded siblings, ADS and reserved names are rejected", native, async t => {
  const { temp, dataDir, root } = await fixture(t);
  const auth = async () => true;
  const outside = path.join(temp, "outside");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "x.txt"), "OUTSIDE");
  await fs.symlink(outside, path.join(root, "junction"), "junction");
  await assert.rejects(runProjectWriter({ dataDir, operation: base(dataDir, "context", root, "junction"), authorizePrepared: auth }), e => [403, 404].includes(e.status));
  await fs.writeFile(path.join(root, "real.txt"), "real");
  await fs.link(path.join(root, "real.txt"), path.join(root, "hard.txt"));
  await assert.rejects(runProjectWriter({ dataDir, operation: base(dataDir, "edit-open", root, "hard.txt"), authorizePrepared: auth }), error(403, "FILE_RESTRICTED"));
  const folded = path.join(temp, "K");
  await fs.mkdir(folded);
  const foldedOther = path.join(temp, "K");
  await fs.mkdir(foldedOther);
  await assert.rejects(runProjectWriter({ dataDir, operation: base(dataDir, "context", folded.toLowerCase(), ""), authorizePrepared: auth }), e => [403, 404].includes(e.status));
  for (const leaf of ["a:stream", "CON", "LPT9.txt", "CONOUT$", "trail.", "trail "]) {
    await assert.rejects(runProjectWriter({ dataDir, operation: base(dataDir, "mkdir", root, leaf), authorizePrepared: auth }), error(400, "INVALID_OPERATION"));
  }
});

test("an external pathname replacement before save is preserved as a version conflict", native, async t => {
  const { dataDir, root } = await fixture(t);
  const auth = async () => true;
  await fs.writeFile(path.join(root, "target.txt"), "ORIGINAL");
  const opened = await runProjectWriter({ dataDir, operation: base(dataDir, "edit-open", root, "target.txt"), authorizePrepared: auth });
  await fs.rename(path.join(root, "target.txt"), path.join(root, "target.old"));
  await fs.writeFile(path.join(root, "target.txt"), "EXTERNAL_NEW");
  const s = await stage(dataDir, Buffer.from("REPLACED\n"));
  await assert.rejects(runProjectWriter({ dataDir, operation: base(dataDir, "save-text", root, "target.txt", { stagedPath: s.file, stagedHash: s.hash, expectedVersion: opened.version, recoveryBinding: id() + id() }), authorizePrepared: auth }), error(409, "VERSION_CONFLICT"));
  assert.equal(await fs.readFile(path.join(root, "target.txt"), "utf8"), "EXTERNAL_NEW");
});

test("a concurrent writer holding the single READ/WRITE handle yields LOCKED without mutation", native, async t => {
  const { dataDir, root } = await fixture(t);
  await fs.writeFile(path.join(root, "locked.txt"), "BASE");
  const opened = await runProjectWriter({ dataDir, operation: base(dataDir, "edit-open", root, "locked.txt"), authorizePrepared: async () => true });
  const s = await stage(dataDir, Buffer.from("NEW\n"));
  let nested;
  const outer = await runProjectWriter({
    dataDir,
    operation: base(dataDir, "save-text", root, "locked.txt", { stagedPath: s.file, stagedHash: s.hash, expectedVersion: opened.version, recoveryBinding: id() + id() }),
    authorizePrepared: async () => {
      nested = await runProjectWriter({ dataDir, operation: base(dataDir, "save-text", root, "locked.txt", { stagedPath: s.file, stagedHash: s.hash, expectedVersion: opened.version, recoveryBinding: id() + id() }), authorizePrepared: async () => true }).catch(e => e);
      return true;
    }
  });
  assert.equal(nested.code, "LOCKED");
  assert.equal(outer.newVersion.startsWith("v1."), true);
  assert.equal(await fs.readFile(path.join(root, "locked.txt"), "utf8"), "NEW\n");
});

// ---------------------------------------------------------------------------
// Fault/checkpoint tests use the test-only runtime: it compiles the helper with
// /define:PROJECT_WRITER_TESTS into a separate cache directory and forwards fault names through the
// child environment. The production runtime rejects a `faults` field, so HTTP cannot enable faults.
// ---------------------------------------------------------------------------
const runTest = win ? createProjectWriterTestRuntime() : null;
const recoveries = dataDir => path.join(dataDir, "project-writes", "recoveries");
const recoveryNames = async dataDir => (await fs.readdir(recoveries(dataDir)).catch(() => [])).filter(name => /^recovery-[0-9a-f]{64}\.bin$/.test(name));
const waitFor = async (probe, ms = 20000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await probe()) return true; await new Promise(resolve => setTimeout(resolve, 25)); }
  return false;
};

const REPLACER_SOURCE = [
  "using System;",
  "using System.Runtime.InteropServices;",
  "using System.Text;",
  "using Microsoft.Win32.SafeHandles;",
  "class Replacer {",
  "  [DllImport(\"kernel32.dll\", CharSet = CharSet.Unicode, SetLastError = true)]",
  "  static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);",
  "  [DllImport(\"kernel32.dll\", SetLastError = true)]",
  "  static extern bool SetFileInformationByHandle(SafeFileHandle handle, int infoClass, byte[] info, int size);",
  "  static int Main(string[] args) {",
  "    if (args.Length != 2) return 1;",
  "    SafeFileHandle handle = CreateFile(args[0], 0x00010000, 7, IntPtr.Zero, 3, 0x80, IntPtr.Zero);",
  "    if (handle.IsInvalid) { Console.Error.WriteLine(\"open:\" + Marshal.GetLastWin32Error()); return 2; }",
  "    byte[] name = Encoding.Unicode.GetBytes(args[1]);",
  "    byte[] info = new byte[20 + name.Length + 2];",
  "    Buffer.BlockCopy(BitConverter.GetBytes((uint)3), 0, info, 0, 4);",
  "    Buffer.BlockCopy(BitConverter.GetBytes((uint)name.Length), 0, info, 16, 4);",
  "    Buffer.BlockCopy(name, 0, info, 20, name.Length);",
  "    bool ok = SetFileInformationByHandle(handle, 22, info, info.Length);",
  "    int code = ok ? 0 : Marshal.GetLastWin32Error();",
  "    handle.Dispose();",
  "    if (!ok) { Console.Error.WriteLine(\"rename:\" + code); return 3; }",
  "    return 0;",
  "  }",
  "}"
].join("\n");

let replacerPath = null;
async function replacer() {
  if (replacerPath) return replacerPath;
  const windir = process.env.WINDIR;
  const candidates = [
    path.join(windir || "", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
    path.join(windir || "", "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe")
  ];
  let compiler = null;
  for (const candidate of candidates) { try { await fs.access(candidate); compiler = candidate; break; } catch { } }
  if (!compiler) return null;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pw-replacer-"));
  const source = path.join(dir, "replacer.cs");
  await fs.writeFile(source, REPLACER_SOURCE);
  const exe = path.join(dir, "replacer.exe");
  try { await execFileAsync(compiler, ["/nologo", "/target:exe", `/out:${exe}`, source], { windowsHide: true, timeout: 30000 }); }
  catch { return null; }
  replacerPath = exe;
  return exe;
}
// Replaces the directory entry of `to` with `from` using FileRenameInfoEx + POSIX semantics, which
// works even while the target is held open without FILE_SHARE_DELETE.
async function replacePathname(exe, from, to) {
  try { await execFileAsync(exe, [from, to], { windowsHide: true, timeout: 15000 }); return { ok: true, detail: "ok" }; }
  catch (error) { return { ok: false, detail: String(error.stderr || "").trim() || `exit ${error.code}` }; }
}

test("production runtime cannot enable test faults and exports the recovery contract", async () => {
  assert.equal(RECOVERY_CONTRACT.recoveryErrors.includes("NAME_REPLACED"), true);
  assert.equal(RECOVERY_CONTRACT.cleanupErrors.includes("CLEANUP_REQUIRED"), true);
  assert.equal(RECOVERY_CONTRACT.quota.eviction, "never");
  assert.match(RECOVERY_CONTRACT.journalName("a".repeat(64)), /^recovery-[0-9a-f]{64}\.bin$/);
  await assert.rejects(runProjectWriter({
    dataDir: os.tmpdir(),
    operation: base(os.tmpdir(), "context", "C:\\project", ""),
    authorizePrepared: async () => true,
    faults: ["mark-delete"]
  }), error(400, "INVALID_ARGUMENT"));
});

test("missing roots, overlapping roots and linked dataDir fail closed before native work", native, async t => {
  const { temp, dataDir, root } = await fixture(t);
  let authorized = false;
  const auth = async () => { authorized = true; return true; };
  await assert.rejects(runProjectWriter({ dataDir, operation: base(dataDir, "context", path.join(temp, "missing-root"), ""), authorizePrepared: auth }), error(403, "PROJECT_UNAVAILABLE"));
  await assert.rejects(runProjectWriter({ dataDir, operation: base(dataDir, "context", path.dirname(dataDir), ""), authorizePrepared: auth }), error(403, "SENSITIVE_PATH"));
  const link = path.join(temp, "runtime-link");
  await fs.symlink(dataDir, link, "junction");
  await assert.rejects(runProjectWriter({ dataDir: link, operation: base(link, "context", root, ""), authorizePrepared: auth }), error(400, "INVALID_ARGUMENT"));
  assert.equal(authorized, false);
});

test("a replaced or unrecorded cached helper binary is never executed", native, async t => {
  const { dataDir, root } = await fixture(t);
  const auth = async () => true;
  assert.ok((await runProjectWriter({ dataDir, operation: base(dataDir, "context", root, ""), authorizePrepared: auth })).rootIdentity);
  const cacheRoot = path.join(dataDir, "project-writer");
  const [version] = await fs.readdir(cacheRoot);
  const exe = path.join(cacheRoot, version, "ProjectWriter.exe");
  assert.equal(sha(await fs.readFile(exe)), (await fs.readFile(`${exe}.sha256`, "utf8")).trim());
  await fs.writeFile(exe, "NOT_AN_EXECUTABLE");
  // Executing the tampered binary would fail; success proves a verified rebuild was used instead.
  assert.ok((await runProjectWriter({ dataDir, operation: base(dataDir, "context", root, ""), authorizePrepared: auth })).rootIdentity);
  await fs.rm(`${exe}.sha256`, { force: true });
  assert.ok((await runProjectWriter({ dataDir, operation: base(dataDir, "context", root, ""), authorizePrepared: auth })).rootIdentity);
});

test("mid-write and flush failures restore the original bytes through the same held handle", native, async t => {
  const { dataDir, root } = await fixture(t);
  const original = Buffer.from(`${"A".repeat(150000)}\n`);
  await fs.writeFile(path.join(root, "big.txt"), original);
  const opened = await runProjectWriter({ dataDir, operation: base(dataDir, "edit-open", root, "big.txt"), authorizePrepared: async () => true });
  for (const fault of ["save-write:partial", "save-write:flush"]) {
    const s = await stage(dataDir, Buffer.from(`${"B".repeat(200000)}\n`));
    const outcome = await runTest({
      dataDir,
      operation: base(dataDir, "save-text", root, "big.txt", { stagedPath: s.file, stagedHash: s.hash, expectedVersion: opened.version, recoveryBinding: id() + id() }),
      authorizePrepared: async () => true,
      faults: [fault]
    }).catch(e => e);
    assert.equal(outcome.code, "WRITE_FAILED", fault);
    assert.equal(outcome.status, 500, fault);
    assert.match(outcome.recoveryId, /^[0-9a-f]{64}$/, fault);
    assert.deepEqual(await fs.readFile(path.join(root, "big.txt")), original, fault);
    assert.equal((await recoveryNames(dataDir)).includes(`recovery-${outcome.recoveryId}.bin`), true, fault);
  }
});

test("a failed rollback reports ROLLBACK_FAILED with a durable recovery record", native, async t => {
  const { dataDir, root } = await fixture(t);
  const original = Buffer.from(`${"A".repeat(150000)}\n`);
  await fs.writeFile(path.join(root, "rollback.txt"), original);
  const opened = await runProjectWriter({ dataDir, operation: base(dataDir, "edit-open", root, "rollback.txt"), authorizePrepared: async () => true });
  const s = await stage(dataDir, Buffer.from(`${"C".repeat(200000)}\n`));
  const outcome = await runTest({
    dataDir,
    operation: base(dataDir, "save-text", root, "rollback.txt", { stagedPath: s.file, stagedHash: s.hash, expectedVersion: opened.version, recoveryBinding: id() + id() }),
    authorizePrepared: async () => true,
    faults: ["save-write:partial", "save-rollback:first"]
  }).catch(e => e);
  assert.equal(outcome.code, "ROLLBACK_FAILED");
  assert.equal(outcome.status, 500);
  const record = await fs.readFile(path.join(recoveries(dataDir), `recovery-${outcome.recoveryId}.bin`));
  assert.equal(record.subarray(record.length - original.length).equals(original), true);
});

test("recovery quota exhaustion by file count rejects before mutation and never evicts", native, async t => {
  const { dataDir, root } = await fixture(t);
  await fs.writeFile(path.join(root, "quota.txt"), "ORIGINAL\n");
  const opened = await runProjectWriter({ dataDir, operation: base(dataDir, "edit-open", root, "quota.txt"), authorizePrepared: async () => true });
  const dir = recoveries(dataDir);
  await fs.mkdir(dir, { recursive: true });
  const seeded = [];
  for (let index = 0; index < 128; index++) {
    const name = `recovery-${sha(`seed-${index}`)}.bin`;
    await fs.writeFile(path.join(dir, name), "x");
    seeded.push(name);
  }
  const s = await stage(dataDir, Buffer.from("CHANGED\n"));
  await assert.rejects(runTest({
    dataDir,
    operation: base(dataDir, "save-text", root, "quota.txt", { stagedPath: s.file, stagedHash: s.hash, expectedVersion: opened.version, recoveryBinding: id() + id() }),
    authorizePrepared: async () => true
  }), error(507, "RECOVERY_QUOTA"));
  assert.equal(await fs.readFile(path.join(root, "quota.txt"), "utf8"), "ORIGINAL\n");
  assert.deepEqual((await recoveryNames(dataDir)).sort(), seeded.sort());
});

test("recovery quota exhaustion by bytes includes our own backup size", native, async t => {
  const { dataDir, root } = await fixture(t);
  await fs.writeFile(path.join(root, "bytes.txt"), "ORIGINAL\n");
  const opened = await runProjectWriter({ dataDir, operation: base(dataDir, "edit-open", root, "bytes.txt"), authorizePrepared: async () => true });
  const dir = recoveries(dataDir);
  await fs.mkdir(dir, { recursive: true });
  const megabyte = Buffer.alloc(1048576, 0x41);
  for (let index = 0; index < 64; index++) await fs.writeFile(path.join(dir, `recovery-${sha(`bytes-${index}`)}.bin`), megabyte);
  const before = await recoveryNames(dataDir);
  const s = await stage(dataDir, Buffer.from("CHANGED\n"));
  await assert.rejects(runTest({
    dataDir,
    operation: base(dataDir, "save-text", root, "bytes.txt", { stagedPath: s.file, stagedHash: s.hash, expectedVersion: opened.version, recoveryBinding: id() + id() }),
    authorizePrepared: async () => true
  }), error(507, "RECOVERY_QUOTA"));
  assert.equal(await fs.readFile(path.join(root, "bytes.txt"), "utf8"), "ORIGINAL\n");
  assert.deepEqual((await recoveryNames(dataDir)).sort(), before.sort());
});

test("parallel reservations from different roots cannot overshoot the recovery quota", native, async t => {
  const { temp, dataDir, root } = await fixture(t);
  const other = path.join(temp, "project-b");
  await fs.mkdir(other);
  await fs.writeFile(path.join(root, "a.txt"), "A_ORIGINAL\n");
  await fs.writeFile(path.join(other, "b.txt"), "B_ORIGINAL\n");
  const openedA = await runProjectWriter({ dataDir, operation: base(dataDir, "edit-open", root, "a.txt"), authorizePrepared: async () => true });
  const openedB = await runProjectWriter({ dataDir, operation: base(dataDir, "edit-open", other, "b.txt"), authorizePrepared: async () => true });
  const dir = recoveries(dataDir);
  await fs.mkdir(dir, { recursive: true });
  for (let index = 0; index < 127; index++) await fs.writeFile(path.join(dir, `recovery-${sha(`parallel-${index}`)}.bin`), "x");
  const stageA = await stage(dataDir, Buffer.from("A_CHANGED\n"));
  const stageB = await stage(dataDir, Buffer.from("B_CHANGED\n"));
  const first = runTest({
    dataDir,
    operation: base(dataDir, "save-text", root, "a.txt", { stagedPath: stageA.file, stagedHash: stageA.hash, expectedVersion: openedA.version, recoveryBinding: id() + id() }),
    authorizePrepared: async () => true,
    faults: ["hold-recovery"]
  }).catch(e => e);
  // Wait until the first helper has published its reservation (128th record) before the second starts.
  assert.equal(await waitFor(async () => (await recoveryNames(dataDir)).length === 128), true, "first reservation published");
  const second = await runTest({
    dataDir,
    operation: base(dataDir, "save-text", other, "b.txt", { stagedPath: stageB.file, stagedHash: stageB.hash, expectedVersion: openedB.version, recoveryBinding: id() + id() }),
    authorizePrepared: async () => true
  }).catch(e => e);
  const firstResult = await first;
  assert.equal(second.code, "RECOVERY_QUOTA");
  assert.equal(second.status, 507);
  assert.equal(typeof firstResult.newVersion, "string");
  assert.equal(await fs.readFile(path.join(other, "b.txt"), "utf8"), "B_ORIGINAL\n");
  assert.ok((await recoveryNames(dataDir)).length <= 128);
});

test("a pathname replacement during commit is either preserved or blocked by the exclusive handle", native, async t => {
  const exe = await replacer();
  if (!exe) { t.skip("no csc.exe available for the test-only replacer"); return; }
  const { temp, dataDir, root } = await fixture(t);
  await fs.writeFile(path.join(root, "doc.txt"), "ORIGINAL\n");
  const opened = await runProjectWriter({ dataDir, operation: base(dataDir, "edit-open", root, "doc.txt"), authorizePrepared: async () => true });
  const s = await stage(dataDir, Buffer.from("WRITTEN\n"));
  const incoming = path.join(temp, "incoming.txt");
  await fs.writeFile(incoming, "INCOMING\n");
  let replaced = null;
  const outcome = await runProjectWriter({
    dataDir,
    operation: base(dataDir, "save-text", root, "doc.txt", { stagedPath: s.file, stagedHash: s.hash, expectedVersion: opened.version, recoveryBinding: id() + id() }),
    authorizePrepared: async () => { replaced = await replacePathname(exe, incoming, path.join(root, "doc.txt")); return true; }
  }).catch(e => e);
  if (replaced.ok) {
    assert.equal(outcome.code, "NAME_REPLACED");
    assert.equal(outcome.status, 409);
    assert.equal(await fs.readFile(path.join(root, "doc.txt"), "utf8"), "INCOMING\n");
    assert.equal((await recoveryNames(dataDir)).length, 0);
    return;
  }
  // The save handle is opened with share=0, so the directory entry cannot be replaced at all: the
  // writer's own exclusivity is the guard, and the save is unaffected.
  assert.equal(replaced.detail, "rename:32");
  t.diagnostic(`POSIX rename of the held target refused with ${replaced.detail}; asserted blocked-replacement behaviour instead`);
  assert.equal(typeof outcome.newVersion, "string");
  assert.equal(await fs.readFile(path.join(root, "doc.txt"), "utf8"), "WRITTEN\n");
  assert.equal(await fs.readFile(incoming, "utf8"), "INCOMING\n");
});

test("a pathname replacement after a partial write is never rolled back or restored", native, async t => {
  const exe = await replacer();
  if (!exe) { t.skip("no csc.exe available for the test-only replacer"); return; }
  const { temp, dataDir, root } = await fixture(t);
  await fs.writeFile(path.join(root, "partial.txt"), Buffer.from(`${"A".repeat(150000)}\n`));
  const opened = await runProjectWriter({ dataDir, operation: base(dataDir, "edit-open", root, "partial.txt"), authorizePrepared: async () => true });
  const s = await stage(dataDir, Buffer.from(`${"B".repeat(200000)}\n`));
  const incoming = path.join(temp, "incoming.txt");
  await fs.writeFile(incoming, "INCOMING_AFTER_PARTIAL\n");
  const marker = path.join(dataDir, "project-writes", "pw-test-checkpoint");
  const resume = path.join(dataDir, "project-writes", "pw-test-resume");
  const pending = runTest({
    dataDir,
    operation: base(dataDir, "save-text", root, "partial.txt", { stagedPath: s.file, stagedHash: s.hash, expectedVersion: opened.version, recoveryBinding: id() + id() }),
    authorizePrepared: async () => true,
    faults: ["save-write:partial", "checkpoint:rollback-name-check"]
  }).catch(e => e);
  assert.equal(await waitFor(() => fs.stat(marker).then(() => true, () => false)), true, "helper reached the rollback name checkpoint");
  const replaced = await replacePathname(exe, incoming, path.join(root, "partial.txt"));
  await fs.writeFile(resume, "go");
  const outcome = await pending;
  if (replaced.ok) {
    assert.equal(outcome.code, "NAME_REPLACED");
    assert.match(outcome.recoveryId, /^[0-9a-f]{64}$/);
    assert.equal(await fs.readFile(path.join(root, "partial.txt"), "utf8"), "INCOMING_AFTER_PARTIAL\n");
    assert.equal((await recoveryNames(dataDir)).includes(`recovery-${outcome.recoveryId}.bin`), true);
    return;
  }
  assert.equal(replaced.detail, "rename:32");
  t.diagnostic(`POSIX rename of the held target refused with ${replaced.detail}; asserted rollback behaviour instead`);
  assert.equal(outcome.code, "WRITE_FAILED");
  assert.deepEqual(await fs.readFile(path.join(root, "partial.txt")), Buffer.from(`${"A".repeat(150000)}\n`));
  assert.equal(await fs.readFile(incoming, "utf8"), "INCOMING_AFTER_PARTIAL\n");
  assert.equal((await recoveryNames(dataDir)).includes(`recovery-${outcome.recoveryId}.bin`), true);
});

test("an unconfirmed commit after the mutation reports COMMIT_UNKNOWN with the record intact", native, async t => {
  const { dataDir, root } = await fixture(t);
  await fs.writeFile(path.join(root, "crash.txt"), "ORIGINAL\n");
  const opened = await runProjectWriter({ dataDir, operation: base(dataDir, "edit-open", root, "crash.txt"), authorizePrepared: async () => true });
  const s = await stage(dataDir, Buffer.from("COMMITTED\n"));
  const outcome = await runTest({
    dataDir,
    operation: base(dataDir, "save-text", root, "crash.txt", { stagedPath: s.file, stagedHash: s.hash, expectedVersion: opened.version, recoveryBinding: id() + id() }),
    authorizePrepared: async () => true,
    faults: ["crash-before-recovery-delete"]
  }).catch(e => e);
  assert.equal(outcome.code, "COMMIT_UNKNOWN");
  assert.equal(outcome.status, 504);
  assert.equal(await fs.readFile(path.join(root, "crash.txt"), "utf8"), "COMMITTED\n");
  assert.equal((await recoveryNames(dataDir)).length, 1);
});

test("a failed owned-handle cleanup is reported distinctly with the owned identity", native, async t => {
  const { dataDir, root } = await fixture(t);
  const s = await stage(dataDir, Buffer.from("PARTIAL_UPLOAD"));
  const outcome = await runTest({
    dataDir,
    operation: base(dataDir, "upload", root, "new.txt", { stagedPath: s.file, stagedHash: s.hash }),
    authorizePrepared: async () => true,
    faults: ["upload-write:first", "mark-delete"]
  }).catch(e => e);
  assert.equal(outcome.code, "CLEANUP_REQUIRED");
  assert.equal(outcome.status, 500);
  assert.match(outcome.cleanupIdentity, /^[0-9a-f]+-[0-9a-f]+-[0-9a-f]+$/);
  assert.match(outcome.recoveryId, /^[0-9a-f]{64}$/);
  const leftover = await fs.stat(path.join(root, "new.txt"));
  assert.equal(leftover.isFile(), true);
  assert.equal(leftover.size, 0);
});
