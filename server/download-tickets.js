import { randomBytes } from "node:crypto";
import { fileError } from "./file-preview-policy.js";

export class DownloadTickets {
  constructor({ resolveScope, now = Date.now }) { this.resolveScope=resolveScope;this.now=now;this.pending=new Map(); }
  issue(scope,query,version) {
    if((scope.authMode&&scope.authMode!=="token")||!scope.tokenHash)throw fileError(400,"TICKET_NOT_AVAILABLE");
    for(const [key,value]of this.pending)if(value.expires<=this.now())this.pending.delete(key);
    if(this.pending.size>=64||[...this.pending.values()].filter(v=>v.tokenHash===scope.tokenHash).length>=8)throw fileError(429,"TICKETS_BUSY");
    const key=randomBytes(24).toString("base64url");
    this.pending.set(key,{tokenHash:scope.tokenHash,scopeId:scope.id,query:{threadId:query.threadId,path:query.path,rootRevision:query.rootRevision},version,expires:this.now()+60000});return key;
  }
  consume(key) {
    if(typeof key!=="string"||!/^[\w-]{32}$/.test(key))throw fileError(403,"TICKET_UNAVAILABLE");
    const value=this.pending.get(key);this.pending.delete(key);
    if(!value||value.expires<=this.now())throw fileError(403,"TICKET_UNAVAILABLE");
    const scope=this.resolveScope(value.tokenHash);
    if(!scope||scope.id!==value.scopeId)throw fileError(403,"TICKET_UNAVAILABLE");
    return {...value,scope};
  }
}
