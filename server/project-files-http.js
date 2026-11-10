import { pipeline } from "node:stream/promises";
import path from "node:path";
import { FILE_LIMITS, attachmentName, fileError } from "./file-preview-policy.js";
import { DownloadSnapshots, fileVersion, singleByteRange } from "./download-snapshots.js";

export async function serveProjectFiles(req,res,url,scope,files,tickets) {
  let opened,snapshot;const downloadAbort=new AbortController(),cancelDownload=()=>downloadAbort.abort();req.once("aborted",cancelDownload);res.once("close",cancelDownload);
  res.setHeader("Cache-Control","private, no-store");
  res.setHeader("X-Content-Type-Options","nosniff");
  res.setHeader("Referrer-Policy","no-referrer");
  const json=(status,value)=>{res.writeHead(status,{"Content-Type":"application/json; charset=utf-8"});res.end(JSON.stringify(value));};
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
      opened=await files.open(scope,query);if(opened.stat.size>BigInt(FILE_LIMITS.downloadBytes))throw fileError(413,"FILE_TOO_LARGE");
      const key=tickets.issue(scope,query,fileVersion(opened.stat));json(200,{url:`/api/project-files/download?ticket=${key}`,expiresIn:60});return;
    }
    if(req.method!=="GET"&&!(req.method==="HEAD"&&["content","download"].includes(action)))throw fileError(405,"METHOD_NOT_ALLOWED");
    if(action==="search"||action==="artifacts") {
      const abort=new AbortController(),cancel=()=>abort.abort();req.once("aborted",cancel);res.once("close",cancel);
      try{const result=await files[action](scope,query,abort.signal);if(!res.destroyed)json(200,result);}finally{req.off("aborted",cancel);res.off("close",cancel);}return;
    }
    if(action==="tree"||action==="preview") {const result=await files[action](scope,query);if(!res.destroyed)json(200,result);return;}
    if(!["content","download","preview-open"].includes(action))throw fileError(404,"NOT_FOUND");
    if(action==="download"&&!ticket&&scope.authMode!=="cloudflare-access")throw fileError(403,"DOWNLOAD_REQUIRES_TICKET");
    opened=action==="content"?await files.content(scope,query):await files.open(scope,query);
    if(action==="preview-open") {
      const meta=await files.inspect(opened,scope);
      if(!["image","pdf"].includes(meta.kind)){if(!res.destroyed)json(200,meta);return;}
      opened.mime=meta.mime;
      // Fixed, bounded metadata only; names, paths, credentials and contents do
      // not enter headers. Binary bytes use this same validated descriptor.
      res.setHeader("X-Codex-Preview",JSON.stringify({kind:meta.kind,mime:meta.mime,size:meta.size,width:meta.width,height:meta.height,downloadAllowed:meta.downloadAllowed,resumeAllowed:meta.resumeAllowed}));
    }
    if(res.destroyed)return;
    const size=Number(opened.stat.size);
    if(size>FILE_LIMITS.downloadBytes)throw fileError(413,"FILE_TOO_LARGE");
    if(ticket&&fileVersion(opened.stat)!==ticket.version)throw fileError(409,"FILE_CHANGED");
    let start=0,end=size-1,status=200;
    if(action==="download"&&!ticket) {
      files.downloads||=new DownloadSnapshots(files.dataDir);snapshot=await files.downloads.acquire(opened,scope,downloadAbort.signal);if(res.destroyed)return;
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
    const deadline=setTimeout(()=>stream.destroy(new Error("Download timeout")),590000);deadline.unref();
    try{await pipeline(stream,res);}finally{clearTimeout(deadline);}
  } catch(error) {
    if(res.headersSent||res.destroyed){res.destroy();return;}
    json(error.status||503,{error:error.code&&error.status?error.code:"FILES_UNAVAILABLE"});
  } finally {req.off("aborted",cancelDownload);res.off("close",cancelDownload);try{if(snapshot)await snapshot.close();}finally{if(opened)await opened.close();}}
}
