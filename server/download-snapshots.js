import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { fileError } from "./file-preview-policy.js";

export const SNAPSHOT_LIMIT=128*1048576;
export function fileVersion(stat) { return [stat.dev,stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs].map(String).join(":"); }
export function singleByteRange(value,size) {
  const match=/^bytes=(\d{0,16})-(\d{0,16})$/.exec(value||"");
  if(!match||(!match[1]&&!match[2])||size===0)throw fileError(416,"INVALID_RANGE");
  let start=Number(match[1]),end=match[2]?Number(match[2]):size-1;
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end))throw fileError(416,"INVALID_RANGE");
  if(!match[1]){if(end===0)throw fileError(416,"INVALID_RANGE");start=Math.max(0,size-end);end=size-1;}
  if(start>=size||end<start)throw fileError(416,"INVALID_RANGE");return {start,end:Math.min(end,size-1)};
}

// Only derived download bytes live here. Snapshots provide a genuinely strong
// ETag and keep a resumed response on one immutable byte sequence.
export class DownloadSnapshots {
  constructor(dataDir,{now=Date.now,maxBytes=256*1048576,maxEntries=4}={}) {
    this.dir=path.join(dataDir,"download-snapshots");this.now=now;this.maxBytes=maxBytes;this.maxEntries=maxEntries;this.bytes=0;this.entries=new Map();this.building=new Map();
    this.ready=(async()=>{await fs.mkdir(this.dir,{recursive:true});for(const entry of (await fs.readdir(this.dir,{withFileTypes:true})).slice(0,256)){if(entry.isFile()&&/^snapshot-[a-f0-9]{32}\.bin$/.test(entry.name))await fs.unlink(path.join(this.dir,entry.name)).catch(()=>{});}})();
    this.timer=setInterval(()=>{void this.prune().catch(()=>{});},60000);this.timer.unref();
  }
  async drop(key,value) {
    if(value.users||value.evicting)return false;value.evicting=true;
    try{await fs.unlink(value.path).catch(error=>{if(error.code!=="ENOENT")throw error;});this.entries.delete(key);this.bytes-=value.size;return true;}
    catch{return false;}finally{value.evicting=false;}
  }
  async prune(){for(const [key,value]of this.entries)if(value.expires<=this.now())await this.drop(key,value);}
  async build(key,opened,size,signal) {
    const check=()=>{if(signal?.aborted)throw fileError(499,"DOWNLOAD_CANCELLED");};check();
    await this.ready;await this.prune();
    while(this.bytes+size>this.maxBytes||this.entries.size+this.building.size>this.maxEntries){let removed=false;for(const [k,v]of this.entries){if(await this.drop(k,v)){removed=true;break;}}if(!removed)throw fileError(429,"DOWNLOADS_BUSY");}
    this.bytes+=size;
    const target=path.join(this.dir,`snapshot-${randomBytes(16).toString("hex")}.bin`);let writer,complete=false;
    try{
      writer=await fs.open(target,"wx",0o600);const hash=createHash("sha256"),buffer=Buffer.alloc(256*1024);let offset=0;
      while(offset<size){check();const read=await opened.handle.read(buffer,0,Math.min(buffer.length,size-offset),offset);check();if(!read.bytesRead)throw fileError(409,"FILE_CHANGED");hash.update(buffer.subarray(0,read.bytesRead));let written=0;while(written<read.bytesRead){const result=await writer.write(buffer,written,read.bytesRead-written,offset+written);if(!result.bytesWritten)throw fileError(503,"DOWNLOAD_UNAVAILABLE");written+=result.bytesWritten;}offset+=read.bytesRead;}
      if(fileVersion(await opened.handle.stat({bigint:true}))!==fileVersion(opened.stat)||!opened.lease.alive)throw fileError(409,"FILE_CHANGED");
      check();await writer.close();writer=null;check();
      const value={path:target,size,etag:`"${hash.digest("hex")}"`,expires:this.now()+300000,users:0,evicting:false};this.entries.set(key,value);complete=true;return value;
    }finally{if(writer)await writer.close();if(!complete){this.bytes-=size;await fs.unlink(target).catch(()=>{});}}
  }
  async acquire(opened,scope,signal) {
    const check=()=>{if(signal?.aborted)throw fileError(499,"DOWNLOAD_CANCELLED");};check();
    const size=Number(opened.stat.size);if(size>SNAPSHOT_LIMIT)return null;
    const key=JSON.stringify([scope.id,opened.context.rootRevision,opened.relative,fileVersion(opened.stat)]);
    await this.ready;await this.prune();let value=this.entries.get(key);
    if(!value){if(this.building.has(key))throw fileError(429,"DOWNLOADS_BUSY");const job=this.build(key,opened,size,signal).finally(()=>this.building.delete(key));this.building.set(key,job);value=await job;}
    if(value.evicting)throw fileError(429,"DOWNLOADS_BUSY");value.users++;let handle;
    try{check();handle=await fs.open(value.path,"r");check();}catch(error){if(handle)await handle.close();value.users--;throw error;}
    let closed=false;return {handle,etag:value.etag,size,close:async()=>{if(closed)return;closed=true;try{await handle.close();}finally{value.users--;}}};
  }
  async close(){clearInterval(this.timer);await Promise.allSettled([...this.building.values()]);for(const [key,value]of this.entries)await this.drop(key,value);}
}
