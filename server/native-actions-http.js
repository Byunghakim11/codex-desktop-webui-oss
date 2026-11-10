const handlers=Object.freeze({describe:'describe',goal:'getGoal',confirm:'prepareConfirmation',execute:'execute'});
const allowedKeys={describe:['threadId'],goal:['threadId'],confirm:['action','threadId','params'],execute:['action','threadId','params','requestId','confirmationId']};
const json=(res,status,value)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(value));};
const fail=(status,code)=>Object.assign(new Error(code),{status,code});

export async function serveNativeActions(req,res,url,{service,resolveScope}){
 if(!url.pathname.startsWith('/api/native-actions/'))return false;
 try{
  const action=url.pathname.slice('/api/native-actions/'.length);
  if(!Object.hasOwn(handlers,action))throw fail(404,'NOT_FOUND');
  if(req.method!=='POST')throw fail(405,'METHOD_NOT_ALLOWED');
  if(req.headers['x-codex-webui']!=='1')throw fail(403,'REQUEST_HEADER_REQUIRED');
  if(String(req.headers['content-type']||'').split(';')[0].trim().toLowerCase()!=='application/json')throw fail(415,'JSON_REQUIRED');
  const initial=await resolveScope(req,url);if(!initial)throw fail(401,'UNAUTHORIZED');
  const chunks=[];let size=0;
  // Do not destroy IncomingMessage on a size error before returning the error.
  await new Promise((resolve,reject)=>{
   const cleanup=()=>{req.off('data',data);req.off('end',end);req.off('aborted',aborted);req.off('error',aborted);};
   const data=chunk=>{size+=chunk.length;if(size>32768){cleanup();req.resume();reject(fail(413,'REQUEST_TOO_LARGE'));}else chunks.push(chunk);};
   const end=()=>{cleanup();resolve();};const aborted=()=>{cleanup();reject(fail(400,'REQUEST_ABORTED'));};
   req.on('data',data);req.once('end',end);req.once('aborted',aborted);req.once('error',aborted);
  });
  let body;try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw fail(400,'INVALID_JSON');}
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(key=>!allowedKeys[action].includes(key)))throw fail(400,'INVALID_REQUEST');
  const scope=await resolveScope(req,url);
  if(!scope||scope.id!==initial.id||scope.tokenHash!==initial.tokenHash||scope.accessEmail!==initial.accessEmail)throw fail(401,'UNAUTHORIZED');
  const result=await service[handlers[action]](scope,body);
  if(!res.destroyed)json(res,200,result);
 }catch(error){
  if(res.headersSent||res.destroyed){res.destroy();return true;}
  const code=/^[A-Z][A-Z0-9_]{0,63}$/.test(error.code||'')?error.code:'NATIVE_ACTION_FAILED';
  json(res,error.status>=400&&error.status<=599?error.status:503,{error:code,code,retryable:Boolean(error.retryable)});
 }
 return true;
}
