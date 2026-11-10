import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ProjectFiles } from "../server/project-files.js";
import { safeRelativePath, hiddenProjectPath, restrictedProjectRoot } from "../server/file-preview-policy.js";

test("project paths reject traversal, Windows aliases and sensitive files", () => {
  for (const input of ["../x", "/x", "C:/x", "a\\b", "a/../x", "a//x", "x:stream", "x.", "CON", "a\0b", "a\nb"]) assert.throws(() => safeRelativePath(input));
  assert.equal(safeRelativePath("src/한국어.md"), "src/한국어.md");
  for (const input of [".env", ".env.local", ".git/config", ".codex/auth.json", "keys/id_rsa", "x/tokens.json", "a/private.pem", "node_modules/a"]) assert.equal(hiddenProjectPath(input), true);
  for(const input of ["C:/user/.ssh/nested","C:/user/.codex/sessions","C:/user/AppData/Local/CodexWebUI/uploads","C:/user/credentials/nested","C:/user/.env/private"])assert.equal(restrictedProjectRoot(input),true);
  assert.equal(restrictedProjectRoot("C:/user/.codex/worktrees/project"),false);
});

test("case-sensitive NTFS siblings are distinct authorization roots",{skip:process.platform!=="win32",timeout:45000},async t=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),"cw-case-"));t.after(()=>fs.rm(temp,{recursive:true,force:true}));
  try{await promisify(execFile)("fsutil.exe",["file","setCaseSensitiveInfo",temp,"enable"],{windowsHide:true});}catch{t.skip("Cannot enable case sensitivity on isolated fixture");return;}
  const allowed=path.join(temp,"project"),outside=path.join(temp,"PROJECT");await fs.mkdir(allowed);await fs.mkdir(outside);await fs.writeFile(path.join(outside,"outside.txt"),"SYNTHETIC_OUTSIDE");
  assert.notEqual((await fs.stat(allowed,{bigint:true})).ino,(await fs.stat(outside,{bigint:true})).ino);
  const files=new ProjectFiles({dataDir:path.join(temp,"runtime"),readThread:async id=>({id,cwd:outside})});
  await assert.rejects(files.tree({id:"test",threadFilterCwds:[allowed]},{threadId:"A",path:""}),e=>e.status===403);
});

test("Unicode-folded NTFS siblings never inherit another scope",{skip:process.platform!=="win32",timeout:45000},async t=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),"cw-unicode-"));t.after(()=>fs.rm(temp,{recursive:true,force:true}));
  const allowed=path.join(temp,"K"),outside=path.join(temp,"K");await fs.mkdir(allowed);await fs.mkdir(outside);await fs.writeFile(path.join(outside,"outside.txt"),"SYNTHETIC_UNICODE_OUTSIDE");
  assert.notEqual((await fs.stat(allowed,{bigint:true})).ino,(await fs.stat(outside,{bigint:true})).ino);
  const files=new ProjectFiles({dataDir:path.join(temp,"runtime"),readThread:async id=>({id,cwd:outside})});
  await assert.rejects(files.tree({id:"test",threadFilterCwds:[allowed]},{threadId:"A",path:""}),e=>e.status===403);
});

test("project files derive their root from native thread metadata, pin revision and deny links", { skip: process.platform !== "win32", timeout: 45000 }, async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "cw-files-")); t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, "project"), other = path.join(temp, "other"); await fs.mkdir(root); await fs.mkdir(other);
  await fs.writeFile(path.join(root, "hello.md"), "# hello\n<svg onload=alert(1)>\n");
  await fs.writeFile(path.join(root, ".env"), "SYNTHETIC_SECRET"); await fs.writeFile(path.join(other, "outside.txt"), "OUTSIDE");
  await fs.symlink(other, path.join(root, "escape"), "junction");
  let cwd = root;
  const files = new ProjectFiles({ dataDir: path.join(temp, "runtime"), readThread: async id => id === "A" ? { id, cwd } : null });
  const scope = { id: "owner", authMode: "cloudflare-access" };
  const tree = await files.tree(scope, { threadId: "A", path: "" });
  assert.deepEqual(tree.entries.map(e => e.name), ["hello.md"]);
  const query = { threadId: "A", path: "hello.md", rootRevision: tree.context.rootRevision };
  assert.match((await files.preview(scope, query)).text, /<svg/);
  await assert.rejects(files.preview(scope, { ...query, path: ".env" }), e => e.status === 403);
  await assert.rejects(files.preview(scope, { ...query, path: "escape/outside.txt" }), e => e.status === 403);
  await assert.rejects(files.preview(scope, { ...query, rootRevision: "forged" }), e => e.status === 409);
  await assert.rejects(files.tree({ ...scope, threadFilterCwds: [other] }, { threadId: "A", path: "" }), e => e.status === 403);
  await assert.rejects(files.tree(scope, { threadId: "forged", path: "" }), e => e.status === 403);
  const leased = await files.open(scope, query);
  await assert.rejects(fs.rename(root, root + "-moved"));
  await leased.close();
  cwd=path.join(root,"escape");
  await assert.rejects(files.tree(scope,{threadId:"A",path:""}),e=>e.status===403);
  cwd = other;
  await assert.rejects(files.preview(scope, query), e => e.status === 409);
});

test("listing and previews stay bounded and binary or invalid encoding stays metadata",{skip:process.platform!=="win32",timeout:45000},async t=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),"cw-limits-"));t.after(()=>fs.rm(temp,{recursive:true,force:true}));const root=path.join(temp,"project");await fs.mkdir(root);
  await Promise.all(Array.from({length:505},(_,i)=>fs.writeFile(path.join(root,`f${i}.txt`),"fixture")));
  await fs.writeFile(path.join(root,"large.txt"),"가".repeat(400000));await fs.writeFile(path.join(root,"lines.md"),"line\n".repeat(21000));await fs.writeFile(path.join(root,"binary.txt"),Buffer.from([0,1,2]));await fs.writeFile(path.join(root,"invalid.txt"),Buffer.from([255,254,255]));await fs.writeFile(path.join(root,"empty.txt"),"");
  const files=new ProjectFiles({dataDir:path.join(temp,"runtime"),readThread:async id=>({id,cwd:root})}),scope={id:"test",authMode:"cloudflare-access"};
  const tree=await files.tree(scope,{threadId:"A",path:""});assert.equal(tree.entries.length,500);assert.equal(tree.truncated,true);
  const preview=path=>files.preview(scope,{threadId:"A",path,rootRevision:tree.context.rootRevision});
  const large=await preview("large.txt");assert.equal(large.truncated,true);assert.equal(large.text.includes("�"),false);assert.ok(Buffer.byteLength(large.text)<=1048576);
  assert.equal((await preview("lines.md")).text.split("\n").length,20000);
  assert.equal((await preview("binary.txt")).kind,"metadata");assert.equal((await preview("invalid.txt")).kind,"metadata");assert.equal((await preview("empty.txt")).text,"");
});
