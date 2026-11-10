import test from "node:test";
import assert from "node:assert/strict";
import { singleByteRange, fileVersion, DownloadSnapshots } from "../server/download-snapshots.js";
import { DownloadTickets } from "../server/download-tickets.js";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { nativeRecordedChanges } from "../server/project-file-discovery.js";

test("single ranges validate bounds, suffixes and multipart rejection",()=>{
  assert.deepEqual(singleByteRange("bytes=2-5",10),{start:2,end:5});assert.deepEqual(singleByteRange("bytes=-3",10),{start:7,end:9});assert.deepEqual(singleByteRange("bytes=8-",10),{start:8,end:9});
  for(const value of ["bytes=10-","bytes=8-2","bytes=-0","bytes=1-2,4-5","bytes=999999999999999999999-"])assert.throws(()=>singleByteRange(value,10),e=>e.status===416);
  assert.throws(()=>singleByteRange("bytes=0-",0),e=>e.status===416);
});

test("native artifact order favors latest delete and hides the old rename target",()=>{
  const turns=[{id:"T",items:[{type:"fileChange",status:"completed",changes:[{path:"a",kind:{type:"add"}}]},{type:"fileChange",status:"completed",changes:[{path:"a",kind:{type:"delete"}}]},{type:"fileChange",status:"completed",changes:[{path:"old",kind:{type:"update",move_path:"new"}}]}]}];
  const result=nativeRecordedChanges(turns);assert.equal(result.find(c=>c.path==="a").kind,"delete");assert.equal(result.find(c=>c.path==="old").kind,"delete");assert.equal(result.find(c=>c.path==="new").kind,"update");
});
test("snapshot abort during copying removes partial bytes and releases quota",async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"cw-copy-abort-"));const cache=new DownloadSnapshots(dir),source=await fs.open(path.join(dir,"input.bin"),"w+");t.after(async()=>{await source.close();await cache.close();await fs.rm(dir,{recursive:true,force:true});});await source.writeFile(Buffer.alloc(1048576,1));
  const abort=new AbortController(),stat=await source.stat({bigint:true}),opened={stat,context:{rootRevision:"R"},relative:"input.bin",lease:{alive:true},handle:{read:async(...args)=>{const result=await source.read(...args);abort.abort();return result;},stat:(...args)=>source.stat(...args)}};
  await assert.rejects(cache.acquire(opened,{id:"A"},abort.signal),e=>e.status===499);assert.equal(cache.bytes,0);assert.equal(cache.entries.size,0);assert.deepEqual(await fs.readdir(cache.dir),[]);
});
test("file version changes for identity, length and write metadata",()=>{
  const a={dev:1n,ino:2n,size:3n,mtimeNs:4n,ctimeNs:5n};assert.notEqual(fileVersion(a),fileVersion({...a,ctimeNs:6n}));
});

test("snapshot capacity respects active readers and expires derived bytes",async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"cw-quota-"));let now=0;const cache=new DownloadSnapshots(dir,{now:()=>now,maxBytes:10,maxEntries:2}),handles=[];t.after(async()=>{for(const handle of handles)await handle.close();await cache.close();await fs.rm(dir,{recursive:true,force:true});});
  const opened=async name=>{const handle=await fs.open(path.join(dir,name),"w+");handles.push(handle);await handle.writeFile("0123456789");return {handle,stat:await handle.stat({bigint:true}),relative:name,context:{rootRevision:"R"},lease:{alive:true}};};
  const a=await opened("a"),b=await opened("b"),reader=await cache.acquire(a,{id:"A"});await assert.rejects(cache.acquire(b,{id:"A"}),e=>e.status===429);assert.equal(cache.bytes,10);await reader.close();const second=await cache.acquire(b,{id:"A"});assert.equal(cache.entries.size,1);await second.close();now=300001;await cache.prune();assert.equal(cache.bytes,0);
  assert.equal(await cache.acquire({stat:{size:129n*1048576n}},{id:"A"}),null);
});
test("tickets are bounded, one-file, expiring, single use and recheck live scope",async()=>{
  let now=0,enabled=true;const scope={id:"A",tokenHash:"HASH",authMode:"token"};
  const tickets=new DownloadTickets({now:()=>now,resolveScope:hash=>enabled&&hash==="HASH"?scope:null});
  const query={threadId:"T",path:"one.txt",rootRevision:"R"};
  const value=tickets.issue(scope,query,"V");assert.deepEqual(tickets.consume(value).query,query);assert.throws(()=>tickets.consume(value),e=>e.status===403);
  const expired=tickets.issue(scope,query,"V");now=61000;assert.throws(()=>tickets.consume(expired),e=>e.status===403);
  const revoked=tickets.issue(scope,query,"V");enabled=false;assert.throws(()=>tickets.consume(revoked),e=>e.status===403);
  assert.throws(()=>tickets.issue({...scope,authMode:"cloudflare-access"},query,"V"),e=>e.status===400);
});
