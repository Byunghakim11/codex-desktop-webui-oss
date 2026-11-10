import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { ProjectFiles } from "../server/project-files.js";
import { serveProjectFiles } from "../server/project-files-http.js";
import { createProjectFilesClient } from "../public/project-files-client.js";

test("binary preview uses one leased file and two fresh authorization reads",{skip:process.platform!=="win32",timeout:45000},async t=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),"cw-single-open-")),root=path.join(temp,"project");await fs.mkdir(root);
  const png=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aIZkAAAAASUVORK5CYII=","base64");await fs.writeFile(path.join(root,"pixel.png"),png);await fs.writeFile(path.join(root,"note.txt"),"SYNTHETIC");
  let reads=0;const files=new ProjectFiles({dataDir:path.join(temp,"runtime"),readThread:async id=>{reads++;return {id,cwd:root};}}),scope={id:"owner",authMode:"token"};const context=(await files.tree(scope,{threadId:"T",path:""})).context;
  const server=createServer((req,res)=>serveProjectFiles(req,res,new URL(req.url,"http://local"),req.headers["x-no-auth"]?null:scope,files));await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));for(let i=0;i<100&&files.active;i++)await new Promise(resolve=>setTimeout(resolve,20));await fs.rm(temp,{recursive:true,force:true});});
  const query=new URLSearchParams({threadId:"T",path:"pixel.png",rootRevision:context.rootRevision}),base=`http://127.0.0.1:${server.address().port}/api/project-files/preview-open?`;reads=0;
  const result=await fetch(base+query);assert.equal(result.status,200);assert.equal(reads,2);assert.equal(result.headers.get("cache-control"),"private, no-store");const meta=JSON.parse(result.headers.get("x-codex-preview"));assert.equal(meta.kind,"image");assert.equal(meta.size,png.length);assert.equal(Object.hasOwn(meta,"path"),false);assert.deepEqual(Buffer.from(await result.arrayBuffer()),png);
  assert.equal((await fetch(base+query,{headers:{"X-No-Auth":"1"}})).status,401);query.set("rootRevision","stale");assert.equal((await fetch(base+query)).status,409);query.set("rootRevision",context.rootRevision);query.set("path","note.txt");assert.equal((await(await fetch(base+query)).json()).text,"SYNTHETIC");
});
test("preview client accepts one binary response and safely falls back for older servers",async()=>{
  let calls=0;const meta={kind:"pdf",mime:"application/pdf",size:8,downloadAllowed:true};
  const client=createProjectFilesClient({getToken:()=>"SYNTHETIC",getAuthMode:()=>"token",fetchImpl:async()=>{calls++;return new Response("%PDF-1.7",{headers:{"Content-Type":"application/pdf","X-Codex-Preview":JSON.stringify(meta)}});}});
  const result=await client.openPreview({threadId:"T",path:"a.pdf",rootRevision:"R"});assert.equal(result.blob.size,8);assert.equal(calls,1);
  let routes=[];const legacy=createProjectFilesClient({getToken:()=>"",getAuthMode:()=>"token",fetchImpl:async url=>{routes.push(String(url));return String(url).includes("preview-open")?new Response("",{status:404}):Response.json({kind:"text",text:"legacy"});}});
  assert.equal((await legacy.openPreview({})).text,"legacy");assert.equal(routes.length,2);await legacy.openPreview({});assert.equal(routes.length,3);
});

test("invalid preview metadata cancels unread response bytes",async()=>{
  for(const [header,type]of [["{","image/png"],["x".repeat(513),"image/png"],[JSON.stringify({kind:"image",mime:"text/html",size:10}),"text/html"]]){
    let cancelled=0;const response=new Response(new ReadableStream({cancel(){cancelled++;}}),{headers:{"Content-Type":type,"X-Codex-Preview":header}});
    const client=createProjectFilesClient({getToken:()=>"",getAuthMode:()=>"token",fetchImpl:async()=>response});await assert.rejects(client.openPreview({}));assert.equal(cancelled,1);
  }
});
