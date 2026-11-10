import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { acquireFileLease } from "./file-lease.js";
import { searchProjectFiles, recordedArtifacts } from "./project-file-discovery.js";
import { FILE_LIMITS as limits, fileError, safeRelativePath, hiddenProjectPath, restrictedProjectRoot, isTextFile, rasterInfo, pdfPreviewInfo } from "./file-preview-policy.js";

// realpath yields stored component casing. NTFS can distinguish case-only
// siblings, so path.relative()'s Windows case folding is not an auth check.
const canonicalKey = value => value.replace(/^[a-z]:/i,drive=>drive.toUpperCase()).replace(/[\\/]+$/,"");
const inside = (root,target) => { const base=canonicalKey(root),file=canonicalKey(target);return file===base||file.startsWith(base+path.sep); };
const identity = stat => `${stat.dev}:${stat.ino}`;
const abortError = () => Object.assign(fileError(499,"ABORTED"),{name:"AbortError"});
const checkAbort = signal => { if (signal?.aborted) throw abortError(); };
async function noLinkChain(value, signal) {
  checkAbort(signal);
  let current=path.parse(value).root;
  if(current.startsWith("\\\\"))throw fileError(403,"PROJECT_UNAVAILABLE");
  for(const part of path.resolve(value).slice(current.length).split(path.sep)) {
    if(!part)continue;current=path.join(current,part);
    checkAbort(signal);
    if((await fs.lstat(current)).isSymbolicLink())throw fileError(403,"PROJECT_UNAVAILABLE");
    checkAbort(signal);
  }
}

export class ProjectFiles {
  constructor({ dataDir, readThread, readChanges=async()=>[], acquireLease=acquireFileLease,openDirectory=fs.opendir }) { this.dataDir=dataDir; this.readThread=readThread; this.readChanges=readChanges; this.acquireLease=acquireLease; this.openDirectory=openDirectory; this.active=0; this.discovering=0; }
  search(scope,query,signal){return searchProjectFiles(this,scope,query,signal);}
  artifacts(scope,query,signal){return recordedArtifacts(this,scope,query,signal);}
  async context(scope, query, signal) {
    checkAbort(signal);
    if (!scope || typeof query.threadId !== "string" || !query.threadId || query.threadId.length > 256) throw fileError(403,"PROJECT_UNAVAILABLE");
    let thread;
    try { thread=await this.readThread(query.threadId); }
    catch (error) { if(signal?.aborted||error?.name==="AbortError")throw abortError(); throw fileError(403,"PROJECT_UNAVAILABLE"); }
    // Native reads cannot be interrupted; let the pending call finish, then
    // stop before any dependent filesystem work or revalidation.
    checkAbort(signal);
    if (thread?.id !== query.threadId || typeof thread.cwd !== "string" || !path.isAbsolute(thread.cwd)) throw fileError(403,"PROJECT_UNAVAILABLE");
    await noLinkChain(thread.cwd, signal);
    checkAbort(signal);
    const root=await fs.realpath(thread.cwd);
    checkAbort(signal);
    if (root.startsWith("\\\\") || root === path.parse(root).root || restrictedProjectRoot(root)) throw fileError(403,"PROJECT_UNAVAILABLE");
    const roots=scope.threadFilterCwds?.length ? scope.threadFilterCwds : scope.threadFilterCwd ? [scope.threadFilterCwd] : [];
    if (roots.length) {
      const allowed=await Promise.all(roots.map(async value=>{try{await noLinkChain(value,signal);return await fs.realpath(value);}catch{return null;}}));
      checkAbort(signal);
      if (!allowed.some(value=>value && inside(value,root))) throw fileError(403,"PROJECT_UNAVAILABLE");
    }
    const stat=await fs.stat(root,{bigint:true});
    checkAbort(signal);
    if (!stat.isDirectory()) throw fileError(403,"PROJECT_UNAVAILABLE");
    const rootRevision=createHash("sha256").update(JSON.stringify([query.threadId,thread.cwd,root,identity(stat),scope.id,roots])).digest("hex");
    if (query.rootRevision != null && query.rootRevision !== rootRevision) throw fileError(409,"PROJECT_CHANGED");
    return { root, rootIdentity:identity(stat), rootRevision, threadId:thread.id, rootName:path.basename(root) };
  }
  publicContext(context) { return { threadId:context.threadId, rootRevision:context.rootRevision, rootName:context.rootName }; }
  async open(scope, query, kind="file", signal) {
    checkAbort(signal);
    if (this.active>=4) throw fileError(429,"FILES_BUSY");
    this.active++;
    let lease, handle, released=false;
    const close=async()=>{ if(released)return; released=true; try { if(handle) await handle.close(); } finally { try { if(lease) await lease.close(); } finally { this.active--; } } };
    try {
      checkAbort(signal);
      const relative=safeRelativePath(query.path ?? "");
      if(hiddenProjectPath(relative)) throw fileError(403,"FILE_RESTRICTED");
      if ((kind === "file" || relative) && !query.rootRevision) throw fileError(400,"REVISION_REQUIRED");
      const context=await this.context(scope,query,signal);
      checkAbort(signal);
      try { lease=await this.acquireLease(this.dataDir,context.root,relative,kind); }
      catch(error) { if(signal?.aborted)throw abortError(); throw error?.name==="AbortError"?error:fileError(403,"FILE_UNAVAILABLE"); }
      // A canceled native lease cannot be killed mid-flight; release it here
      // and never begin the post-lease context read or descriptor work.
      checkAbort(signal);
      const current=await this.context(scope,{...query,rootRevision:context.rootRevision},signal);
      checkAbort(signal);
      if(current.rootIdentity!==context.rootIdentity || !lease.alive) throw fileError(409,"PROJECT_CHANGED");
      const target=path.join(context.root,...relative.split("/"));
      const canonical=await fs.realpath(target);
      checkAbort(signal);
      if(!inside(context.root,canonical) || path.relative(target,canonical)!=="") throw fileError(403,"FILE_RESTRICTED");
      const before=await fs.lstat(target,{bigint:true});
      checkAbort(signal);
      if(before.isSymbolicLink() || (kind==="directory" ? !before.isDirectory() : !before.isFile() || before.nlink!==1n)) throw fileError(403,"FILE_RESTRICTED");
      if(kind==="file") {
        handle=await fs.open(target,"r"); checkAbort(signal); const actual=await handle.stat({bigint:true});
        checkAbort(signal);
        if(identity(actual)!==identity(before) || !lease.alive) throw fileError(409,"FILE_CHANGED");
      }
      return { handle, target, relative, stat:before, context, lease, close };
    } catch(error) { await close(); if(error.status)throw error; throw fileError(error.code==="ENOENT"?404:403,"FILE_UNAVAILABLE"); }
  }
  async tree(scope,query,signal) {
    checkAbort(signal);
    const opened=await this.open(scope,query,"directory",signal);
    let directory=null,iterating=false;
    try {
      checkAbort(signal);
      const entries=[]; let scanned=0, truncated=false, hiddenCount=0;
      directory=await this.openDirectory(opened.target);
      checkAbort(signal);
      iterating=true;
      for await (const entry of directory) {
        checkAbort(signal);
        if(++scanned>limits.scanned || entries.length>=limits.entries) {truncated=true;break;}
        const relative=[opened.relative,entry.name].filter(Boolean).join("/");
        try { safeRelativePath(relative); } catch { hiddenCount++;continue; }
        if(hiddenProjectPath(relative) || entry.isSymbolicLink() || (!entry.isDirectory()&&!entry.isFile())) {hiddenCount++;continue;}
        // Hardlinks and reparse points are never offered as readable entries.
        const stat=await fs.lstat(path.join(opened.target,entry.name),{bigint:true}).catch(()=>null);
        checkAbort(signal);
        if(!stat || stat.isSymbolicLink() || (stat.isFile()&&stat.nlink!==1n)) {hiddenCount++;continue;}
        entries.push({name:entry.name,path:relative,kind:stat.isDirectory()?"directory":"file",size:stat.isFile()?Number(stat.size):null});
      }
      checkAbort(signal);
      if(!opened.lease.alive) throw fileError(409,"PROJECT_CHANGED");
      entries.sort((a,b)=>(a.kind===b.kind?0:a.kind==="directory"?-1:1)||a.name.localeCompare(b.name));
      return {context:this.publicContext(opened.context),path:opened.relative,entries,truncated,limit:limits.entries,hiddenCount};
    } finally {try{if(directory&&!iterating)await directory.close();}finally{await opened.close();}}
  }
  async preview(scope,query,signal) {
    checkAbort(signal);
    const opened=await this.open(scope,query,"file",signal);
    try { checkAbort(signal); return await this.inspect(opened,scope,signal); } finally {await opened.close();}
  }
  async inspect(opened,scope,signal) {
      checkAbort(signal);
      const size=Number(opened.stat.size), name=path.basename(opened.relative);
      const metadata={context:this.publicContext(opened.context),path:opened.relative,name,size,kind:"metadata",downloadAllowed:size<=limits.downloadBytes,resumeAllowed:scope.authMode==="cloudflare-access"&&size<=128*1048576,reason:"UNSUPPORTED_PREVIEW"};
      const head=Buffer.alloc(Math.min(size,65536)); const {bytesRead}=await opened.handle.read(head,0,head.length,0);
      checkAbort(signal);
      const raster=rasterInfo(head.subarray(0,bytesRead));
      const pdf=pdfPreviewInfo(head.subarray(0,bytesRead),size);if(pdf)return {...metadata,...pdf,reason:null};
      if(raster&&size<=limits.imageBytes) return {...metadata,...raster,kind:"image",reason:null};
      if(!isTextFile(name)) return metadata;
      const buffer=Buffer.alloc(Math.min(size,limits.textBytes));
      let count=0;
      while(count<buffer.length) { checkAbort(signal); const read=await opened.handle.read(buffer,count,buffer.length-count,count);checkAbort(signal);if(!read.bytesRead)break;count+=read.bytesRead; }
      const bytes=buffer.subarray(0,count);
      if(bytes.includes(0)) return {...metadata,reason:"BINARY_PREVIEW"};
      let text;
      try {text=new TextDecoder("utf-8",{fatal:true}).decode(bytes,{stream:size>count});}catch{return {...metadata,reason:"ENCODING_PREVIEW"};}
      const lines=text.split("\n"), truncated=size>count||lines.length>limits.lines;
      if(lines.length>limits.lines)text=lines.slice(0,limits.lines).join("\n");
      return {...metadata,kind:"text",text,truncated,reason:null};
  }
  async image(scope,query,signal) {return this.content(scope,query,true,signal);}
  async content(scope,query,imageOnly=false,signal) {
    checkAbort(signal);
    const opened=await this.open(scope,query,"file",signal);
    try {
      checkAbort(signal);
      if(opened.stat.size>BigInt(imageOnly?limits.imageBytes:25*1048576))throw fileError(413,"PREVIEW_TOO_LARGE");
      const head=Buffer.alloc(Math.min(Number(opened.stat.size),65536));const read=await opened.handle.read(head,0,head.length,0);
      checkAbort(signal);
      const bytes=head.subarray(0,read.bytesRead),info=(!imageOnly&&pdfPreviewInfo(bytes,Number(opened.stat.size)))||(opened.stat.size<=BigInt(limits.imageBytes)&&rasterInfo(bytes));if(!info)throw fileError(415,"UNSUPPORTED_PREVIEW");
      return {...opened,...info};
    }catch(error){await opened.close();throw error;}
  }
}
