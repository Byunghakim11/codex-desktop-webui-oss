import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { ProjectFiles } from "../server/project-files.js";
import { serveProjectFiles } from "../server/project-files-http.js";
import { attachmentName } from "../server/file-preview-policy.js";

test("attachment filename handles long Unicode without header injection",()=>{
  assert.doesNotThrow(()=>attachmentName("a".repeat(179)+"😀.txt"));
  assert.doesNotMatch(attachmentName("bad\r\nname.txt"),/[\r\n]/);
});

test("file HTTP streams attachments, sanitizes headers and rejects stale content URLs", {skip:process.platform!=="win32",timeout:45000},async t=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),"cw-http-"));t.after(()=>fs.rm(temp,{recursive:true,force:true}));
  const root=path.join(temp,"project");await fs.mkdir(root);
  await fs.writeFile(path.join(root,"한글.txt"),"synthetic download\n");await fs.writeFile(path.join(root,"unsafe.html"),"<script>alert(1)</script>");
  const files=new ProjectFiles({dataDir:path.join(temp,"runtime"),readThread:async id=>({id,cwd:root})});
  const server=createServer((req,res)=>{const url=new URL(req.url,"http://local");return serveProjectFiles(req,res,url,{id:"test",authMode:url.searchParams.has("tokenMode")?"token":"cloudflare-access"},files);});
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}/api/project-files/`;
  const tree=await (await fetch(base+"tree?threadId=A&path=")).json();
  const query=new URLSearchParams({threadId:"A",path:"한글.txt",rootRevision:tree.context.rootRevision});
  const response=await fetch(base+"download?"+query);assert.equal(response.status,200);assert.match(response.headers.get("content-disposition"),/filename\*=UTF-8''/);assert.equal(response.headers.get("x-content-type-options"),"nosniff");assert.equal(await response.text(),"synthetic download\n");
  assert.equal((await fetch(base+"download?"+query+"&tokenMode=1")).status,403);
  query.set("rootRevision","stale");assert.equal((await fetch(base+"download?"+query)).status,409);assert.equal((await fetch(base+"content?"+query)).status,409);
  query.set("rootRevision",tree.context.rootRevision);query.set("path","unsafe.html");
  const preview=await (await fetch(base+"preview?"+query)).json();assert.equal(preview.kind,"text");assert.match(preview.text,/<script>/);
  query.set("path","missing.txt");const missing=await fetch(base+"preview?"+query);assert.ok([403,404].includes(missing.status));assert.doesNotMatch(await missing.text(),/cw-http-|C:\\/);
});

test("aborted streaming download releases the native lease and operation slot",{skip:process.platform!=="win32",timeout:45000},async t=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),"cw-abort-"));t.after(()=>fs.rm(temp,{recursive:true,force:true}));
  const root=path.join(temp,"project");await fs.mkdir(root);const file=await fs.open(path.join(root,"large.bin"),"w");await file.truncate(64*1048576);await file.close();
  const scope={id:"test",authMode:"cloudflare-access"};const files=new ProjectFiles({dataDir:path.join(temp,"runtime"),readThread:async id=>({id,cwd:root})});
  const context=(await files.tree(scope,{threadId:"A",path:""})).context;
  const server=createServer((req,res)=>serveProjectFiles(req,res,new URL(req.url,"http://local"),scope,files));await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const abort=new AbortController();const query=new URLSearchParams({threadId:"A",path:"large.bin",rootRevision:context.rootRevision});
  const response=await fetch(`http://127.0.0.1:${server.address().port}/api/project-files/download?${query}`,{signal:abort.signal});await response.body.getReader().read();abort.abort();
  for(let i=0;i<100&&files.active;i++)await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(files.active,0);await fs.rename(root,root+"-released");
});
