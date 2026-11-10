import {createHash} from 'node:crypto';
import {mkdir,open,readFile,lstat,realpath} from 'node:fs/promises';
import path from 'node:path';

const hash=value=>createHash('sha256').update(value).digest('hex');
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const failure=code=>Object.assign(new Error('Attachment send needs reconciliation; it was not sent again.'),{code});
function ack(result){
 if(typeof result?.turn?.id==='string')return {turn:{id:result.turn.id}};
 if(typeof result?.turnId==='string')return {turnId:result.turnId};
 if(typeof result?.queuedSubmission?.id==='string')return {queuedSubmission:{id:result.queuedSubmission.id}};
 return {};
}

// Durable at-most-one dispatch from this WebUI operation. A crash before/after
// native acceptance remains unknown, rather than promising exactly-once delivery.
export class AttachmentSendLedger{
 constructor({dataDir}){this.dataDir=dataDir;this.dir=path.join(dataDir,'chat-attachment-sends');}
 async directory(){
  const base=await realpath(this.dataDir);this.dir=path.join(base,'chat-attachment-sends');
  await mkdir(this.dir,{recursive:true,mode:0o700});const s=await lstat(this.dir);
  if(s.isSymbolicLink()||!s.isDirectory()||path.resolve(await realpath(this.dir))!==path.resolve(this.dir))throw failure('ATTACHMENT_LEDGER_UNAVAILABLE');
 }
 key(principal,id){if(!principal||!uuid(id))throw failure('INVALID_SEND_ID');return path.join(this.dir,hash(principal+'\0'+id)+'.json');}
 async read(file){try{const s=await lstat(file);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>8192)throw failure('ATTACHMENT_LEDGER_UNAVAILABLE');return JSON.parse(await readFile(file,'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
 async status(principal,id){await this.directory();const value=await this.read(this.key(principal,id));return value?{status:value.status==='accepted'?'accepted':'unknown',result:value.status==='accepted'?value.result:undefined}:{status:'missing'};}
 async send(principal,params,dispatch){
  await this.directory();const file=this.key(principal,params.clientSendId);
  const digest=hash(JSON.stringify(params));
  let handle;
  try{handle=await open(file,'wx',0o600);}
  catch(e){
   if(e.code!=='EEXIST')throw failure('ATTACHMENT_LEDGER_UNAVAILABLE');
   const previous=await this.read(file);
   if(previous?.digest!==digest)throw failure('ATTACHMENT_SEND_CONFLICT');
   if(previous.status==='accepted')return previous.result;
   throw failure('ATTACHMENT_SEND_UNKNOWN');
  }
  try{
   await handle.writeFile(JSON.stringify({digest,status:'unknown',createdAt:Date.now()}));await handle.sync();
   let result;
   try{result=await dispatch();}catch{throw failure('ATTACHMENT_SEND_UNKNOWN');}
   const record=Buffer.from(JSON.stringify({digest,status:'accepted',createdAt:Date.now(),result:ack(result)}));
   // A partial rewrite is conservatively unreadable/unknown on restart; never retry.
   await handle.truncate(0);await handle.write(record,0,record.length,0);await handle.sync();
   return result;
  }finally{await handle.close();}
 }
}
