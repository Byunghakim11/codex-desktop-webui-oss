import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { ProjectFiles } from "../server/project-files.js";
import { serveProjectFiles } from "../server/project-files-http.js";
import { DownloadTickets } from "../server/download-tickets.js";

test("HTTP resume stays on immutable bytes and LAN tickets reject reuse, changed files and revoked scope",{skip:process.platform!=="win32",timeout:60000},async t=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),"cw-p2-"));const root=path.join(temp,"project");await fs.mkdir(root);await fs.writeFile(path.join(root,"one.txt"),"0123456789");
  const files=new ProjectFiles({dataDir:path.join(temp,"runtime"),readThread:async id=>({id,cwd:root})});
  let enabled=true;const tokenScope={id:"A",tokenHash:"HASH",authMode:"token"},accessScope={...tokenScope,authMode:"cloudflare-access"};const tickets=new DownloadTickets({resolveScope:()=>enabled?tokenScope:null});
  const server=createServer((req,res)=>{const url=new URL(req.url,"http://local");return serveProjectFiles(req,res,url,url.searchParams.has("local")?tokenScope:accessScope,files,tickets);});await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));for(let i=0;i<100&&files.active;i++)await new Promise(resolve=>setTimeout(resolve,20));await files.downloads?.close();await fs.rm(temp,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}`,rev=(await files.tree(accessScope,{threadId:"T",path:""})).context.rootRevision;
  const query=new URLSearchParams({threadId:"T",path:"one.txt",rootRevision:rev}),url=base+"/api/project-files/download?"+query;
  const first=await fetch(url);const etag=first.headers.get("etag");assert.equal(await first.text(),"0123456789");assert.match(etag,/^"[a-f0-9]{64}"$/);
  const part=await fetch(url,{headers:{Range:"bytes=3-5","If-Range":etag}});assert.equal(part.status,206);assert.equal(part.headers.get("content-range"),"bytes 3-5/10");assert.equal(await part.text(),"345");
  const bad=await fetch(url,{headers:{Range:"bytes=100-"}});assert.equal(bad.status,416);assert.equal(bad.headers.get("content-range"),"bytes */10");await bad.arrayBuffer();
  await fs.writeFile(path.join(root,"one.txt"),"NEW CONTENT");const changed=await fetch(url,{headers:{Range:"bytes=3-5","If-Range":etag}});assert.equal(changed.status,200);assert.notEqual(changed.headers.get("etag"),etag);assert.equal(await changed.text(),"NEW CONTENT");
  const mint=async()=>{const response=await fetch(base+"/api/project-files/download-ticket?local=1",{method:"POST",headers:{"Content-Type":"application/json","X-Codex-Files":"1"},body:JSON.stringify({threadId:"T",path:"one.txt",rootRevision:rev})});assert.equal(response.status,200);return (await response.json()).url;};
  const ticket=await mint();assert.doesNotMatch(ticket,/HASH|local=|token=/);const local=await fetch(base+ticket);assert.equal(local.status,200);assert.equal(await local.text(),"NEW CONTENT");assert.equal((await fetch(base+ticket)).status,403);
  const revoked=await mint();enabled=false;assert.equal((await fetch(base+revoked)).status,403);enabled=true;
  const stale=await mint();await fs.writeFile(path.join(root,"one.txt"),"CHANGED");assert.equal((await fetch(base+stale)).status,409);
});

test("bounded search and artifacts keep project, hidden and native evidence boundaries",{skip:process.platform!=="win32",timeout:45000},async t=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),"cw-discovery-"));t.after(()=>fs.rm(temp,{recursive:true,force:true}));const root=path.join(temp,"project");await fs.mkdir(root);await fs.mkdir(path.join(root,"src"));await fs.mkdir(path.join(root,".ssh"));await fs.writeFile(path.join(root,"src","report.md"),"safe");await fs.writeFile(path.join(root,".ssh","report.key"),"SYNTHETIC_PRIVATE");
  const files=new ProjectFiles({dataDir:path.join(temp,"runtime"),readThread:async id=>({id,cwd:root}),readChanges:async()=>[{path:"src/report.md",kind:"update",turnId:"native-turn"},{path:".ssh/report.key",kind:"add"},{path:"../outside.txt",kind:"add"},{path:"src/deleted.txt",kind:"delete"}]});
  const scope={id:"A",authMode:"cloudflare-access"},context=(await files.tree(scope,{threadId:"T",path:""})).context,q={threadId:"T",rootRevision:context.rootRevision};
  const found=await files.search(scope,{...q,search:"report"});assert.deepEqual(found.entries.map(e=>e.path),["src/report.md"]);
  const artifacts=await files.artifacts(scope,q);assert.deepEqual(artifacts.entries.map(e=>e.path),["src/report.md"]);assert.equal(artifacts.entries[0].turnId,"native-turn");
  await assert.rejects(files.search(scope,{...q,rootRevision:"stale",search:"report"}),e=>e.status===409);
});
