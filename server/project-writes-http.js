import { attachmentName } from './file-preview-policy.js';
const actions=Object.freeze({
 'write-context':{method:'issueContext',keys:['threadId','rootRevision','parentPath']},
 mkdir:{method:'mkdir',keys:['contextId','path','operationId']},
 'edit-open':{method:'editOpen',keys:['contextId','path']},
 'save-text':{method:'saveText',keys:['contextId','path','operationId','text','expectedVersion']},
 'write-status':{method:'operationStatus',keys:['contextId','path','operationId','kind']},
 'write-recovery':{method:'downloadRecovery',keys:['contextId','path','operationId','kind']},
 upload:{method:'upload'}
});
const fail=(status,code)=>Object.assign(new Error(code),{status,code});
const json=(res,status,value)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(value));};
async function readJson(req,limit){
 if(String(req.headers['content-type']||'').split(';')[0].trim().toLowerCase()!=='application/json')throw fail(415,'JSON_REQUIRED');
 if(Number(req.headers['content-length'])>limit){req.resume();throw fail(413,'REQUEST_TOO_LARGE');}
 const chunks=[];let size=0;
 await new Promise((resolve,reject)=>{
   const cleanup=()=>{req.off('data',data);req.off('end',end);req.off('aborted',aborted);req.off('error',aborted);};
   const data=chunk=>{size+=chunk.length;if(size>limit){cleanup();req.resume();reject(fail(413,'REQUEST_TOO_LARGE'));}else chunks.push(chunk);};
   const end=()=>{cleanup();resolve();};const aborted=()=>{cleanup();reject(fail(499,'CANCELLED'));};
   req.on('data',data);req.once('end',end);req.once('aborted',aborted);req.once('error',aborted);
 });
 try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw fail(400,'INVALID_JSON');}
}

export async function serveProjectWrites(req,res,url,{writes,resolveScope}){
 const action=url.pathname.startsWith('/api/project-files/')?url.pathname.slice('/api/project-files/'.length):'';
 if(!Object.hasOwn(actions,action))return false;
 const abort=new AbortController(),cancel=()=>{if(!res.writableEnded)abort.abort();};
 req.once('aborted',cancel);res.once('close',cancel);
 try{
   const readOnly=action==='write-status'||action==='write-recovery';
   if(req.method!==(readOnly?'GET':'POST'))throw fail(405,'METHOD_NOT_ALLOWED');
   if(req.method==='POST'&&req.headers['x-codex-files']!=='1')throw fail(403,'REQUEST_HEADER_REQUIRED');
   const initial=await resolveScope(req,url);if(!initial)throw fail(401,'UNAUTHORIZED');
   const freshScope=async()=>{
     const value=await resolveScope(req,url);
     if(!value||value.id!==initial.id||value.tokenHash!==initial.tokenHash||value.accessEmail!==initial.accessEmail)throw fail(401,'UNAUTHORIZED');
     return value;
   };
   let input;
   if(action==='upload'){
     let relative;try{relative=decodeURIComponent(String(req.headers['x-file-path']||''));}catch{throw fail(400,'INVALID_PATH');}
     input={contextId:String(req.headers['x-write-context']||''),path:relative,operationId:String(req.headers['x-operation-id']||''),stream:req};
     if(req.headers['content-length']!==undefined)input.declaredSize=Number(req.headers['content-length']);
   }else{
     input=readOnly?Object.fromEntries(actions[action].keys.map(key=>[key,url.searchParams.get(key)])):await readJson(req,action==='save-text'?7*1048576:8192);
     if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!actions[action].keys.includes(key)))throw fail(400,'INVALID_REQUEST');
   }
   await freshScope();
   const args=action==='write-context'?{query:input,resolveScope:freshScope,signal:abort.signal}:{...input,resolveScope:freshScope,signal:abort.signal};
   const result=await writes[actions[action].method](args);
   if(action==='write-recovery'){
     await freshScope();
     res.writeHead(200,{'content-type':'application/octet-stream','content-disposition':attachmentName(result.name),'content-length':result.bytes.length,'cache-control':'private, no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; sandbox"});res.end(result.bytes);return true;
   }
   if(!res.destroyed)json(res,200,result);
 }catch(error){
   if(res.headersSent||res.destroyed){res.destroy();return true;}
   const code=/^[A-Z][A-Z0-9_]{0,63}$/.test(error.code||'')?error.code:'FILES_UNAVAILABLE';
   json(res,error.status>=400&&error.status<=599?error.status:503,{error:code,code});
 }finally{req.off('aborted',cancel);res.off('close',cancel);}
 return true;
}
