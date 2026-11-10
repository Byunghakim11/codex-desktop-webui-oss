import { pipeline } from "node:stream/promises";
import path from "node:path";
import { FILE_LIMITS, attachmentName, fileError } from "./file-preview-policy.js";
import { DownloadSnapshots, fileVersion, singleByteRange } from "./download-snapshots.js";

export async function serveProjectFiles(req,res,url,scope,files,tickets) {
  let opened,snapshot;const abort=new AbortController(),cancel=()=>abort.abort(),signal=abort.signal;req.once("aborted",cancel);res.once("close",cancel);
  res.setHeader("Cache-Control","private, no-store");
  res.setHeader("X-Content-Type-Options","nosniff");
  res.setHeader("Referrer-Policy","no-referrer");
  const json=(status,value)=>{if(res.headersSent||res.destroyed||res.writableEnded)return false;res.writeHead(status,{"Content-Type":"application/json; charset=utf-8"});res.end(JSON.stringify(value));return true;};
  try {
    const action=url.pathname.split("/").pop();
    let ticket;
    if(action==="download"&&url.searchParams.has("ticket")) {
      if(req.method!=="GET"||!tickets)throw fileError(403,"TICKET_UNAVAILABLE");
      ticket=tickets.consume(url.searchParams.get("ticket"));scope=ticket.scope;
    }
    if(!scope)throw fileError(401,"AUTH_REQUIRED");
    let query=ticket?.query||Object.fromEntries(["threadId","path","rootRevision","search"].map(key=>[key,url.searchParams.has(key)?url.searchParams.get(key):undefined]));
    if(action==="download-ticket") {
      if(req.method!=="POST"||req.headers["x-codex-files"]!=="1"||!/^application\/json(?:;|$)/i.test(req.headers["content-type"]||"")||!tickets)throw fileError(400,"TICKET_REQUEST_INVALID");
      let bytes=0,chunks=[];for await(const chunk of req){bytes+=chunk.length;if(bytes>8192)throw fileError(413,"REQUEST_TOO_LARGE");chunks.push(chunk);}
      try{const body=JSON.parse(Buffer.concat(chunks).toString("utf8"));query={threadId:body.threadId,path:body.path,rootRevision:body.rootRevision};}catch{throw fileError(400,"TICKET_REQUEST_INVALID");}
      opened=await files.open(scope,query,"file",signal);if(opened.stat.size>BigInt(FILE_LIMITS.downloadBytes))throw fileError(413,"FILE_TOO_LARGE");
      const key=tickets.issue(scope,query,fileVersion(opened.stat));if(!signal.aborted)json(200,{url:`/api/project-files/download?ticket=${key}`,expiresIn:60});return;
    }
    if(req.method!=="GET"&&!(req.method==="HEAD"&&["content","download"].includes(action)))throw fileError(405,"METHOD_NOT_ALLOWED");
    if(action==="search"||action==="artifacts") {
      const result=await files[action](scope,query,signal);if(!res.destroyed&&!signal.aborted)json(200,result);return;
    }
    if(action==="tree"||action==="preview") {const result=await files[action](scope,query,signal);if(!res.destroyed&&!signal.aborted)json(200,result);return;}
    if(!["content","download","preview-open"].includes(action))throw fileError(404,"NOT_FOUND");
    if(action==="download"&&!ticket&&scope.authMode!=="cloudflare-access")throw fileError(403,"DOWNLOAD_REQUIRES_TICKET");
    opened=action==="content"?await files.content(scope,query,false,signal):await files.open(scope,query,"file",signal);
    if(action==="preview-open") {
      const meta=await files.inspect(opened,scope,signal);
      if(!["image","pdf"].includes(meta.kind)){if(!res.destroyed&&!signal.aborted)json(200,meta);return;}
      opened.mime=meta.mime;
      // Fixed, bounded metadata only; names, paths, credentials and contents do
      // not enter headers. Binary bytes use this same validated descriptor.
      res.setHeader("X-Codex-Preview",JSON.stringify({kind:meta.kind,mime:meta.mime,size:meta.size,width:meta.width,height:meta.height,downloadAllowed:meta.downloadAllowed,resumeAllowed:meta.resumeAllowed}));
    }
    if(res.destroyed)return;
    if(signal.aborted)throw fileError(499,"ABORTED");
    const size=Number(opened.stat.size);
    if(size>FILE_LIMITS.downloadBytes)throw fileError(413,"FILE_TOO_LARGE");
    if(ticket&&fileVersion(opened.stat)!==ticket.version)throw fileError(409,"FILE_CHANGED");
    let start=0,end=size-1,status=200;
    if(action==="download"&&!ticket) {
      files.downloads||=new DownloadSnapshots(files.dataDir);snapshot=await files.downloads.acquire(opened,scope,signal);
      if(signal.aborted)throw fileError(499,"ABORTED");
      if(res.destroyed)return;
      if(snapshot){res.setHeader("ETag",snapshot.etag);res.setHeader("Accept-Ranges","bytes");
        if(req.headers.range&&(!req.headers["if-range"]||req.headers["if-range"]===snapshot.etag)){
          try{({start,end}=singleByteRange(req.headers.range,size));}catch(error){res.setHeader("Content-Range",`bytes */${size}`);throw error;}
          status=206;res.setHeader("Content-Range",`bytes ${start}-${end}/${size}`);
        }
      }else res.setHeader("Accept-Ranges","none");
    }else res.setHeader("Accept-Ranges","none");
    const inline=action==="content"||action==="preview-open";
    res.setHeader("Content-Type",inline?opened.mime:"application/octet-stream");
    res.setHeader("Content-Length",Math.max(0,end-start+1));
    res.setHeader("Content-Disposition",inline?"inline":attachmentName(path.basename(opened.relative)));
    res.setHeader("Content-Security-Policy","default-src 'none'; sandbox");
    res.statusCode=status;
    if(size===0||req.method==="HEAD") {res.end();return;}
    const stream=(snapshot?.handle||opened.handle).createReadStream({start,end,autoClose:false});
    const onAbort=()=>{if(!res.writableEnded&&!stream.destroyed)stream.destroy(Object.assign(new Error("Request aborted"),{name:"AbortError"}));};
    if(signal.aborted)onAbort();else signal.addEventListener("abort",onAbort,{once:true});
    const deadline=setTimeout(()=>stream.destroy(new Error("Download timeout")),590000);deadline.unref();
    try{await pipeline(stream,res);}finally{signal.removeEventListener("abort",onAbort);clearTimeout(deadline);}
  } catch(error) {
    if(error?.status===499||error?.name==="AbortError") {
      if(!res.headersSent&&!res.destroyed)json(499,{error:error.code||"ABORTED"});
      else if(!res.writableEnded)res.destroy();
      return;
    }
    if(res.headersSent||res.destroyed){res.destroy();return;}
    json(error.status||503,{error:error.code&&error.status?error.code:"FILES_UNAVAILABLE"});
  } finally {req.off("aborted",cancel);res.off("close",cancel);try{if(snapshot)await snapshot.close();}finally{if(opened)await opened.close();}}
}
