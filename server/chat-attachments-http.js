import {createReadStream} from 'node:fs';
import {pipeline} from 'node:stream/promises';
import {attachmentName} from './file-preview-policy.js';
const PREFIX = '/api/chat-attachments';

function json(res,status,value){
  res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});
  res.end(JSON.stringify(value));
}
function sameContext(a,b){return ['principalId','scopeId','cwd','draftId','threadId'].every(key=>(a?.[key]||'')===(b?.[key]||''));}

// The caller resolves current token/Access identity and authoritative workspace.
// Requiring a non-simple header prevents browser cross-site form requests;
// this endpoint deliberately provides neither CORS nor a preflight grant.
export async function serveChatAttachments(req,res,url,{store,resolveContext}){
  if(url.pathname!==PREFIX&&!url.pathname.startsWith(PREFIX+'/'))return false;
  let downloadLease;
  try{
    const download=url.pathname.match(/^\/api\/chat-attachments\/([a-f0-9]{32})\/download$/);
    if(download){
      if(req.method!=='GET')throw Object.assign(Error('Method not allowed'),{status:405,code:'METHOD_NOT_ALLOWED'});
      const context=await resolveContext(req,url,{download:true});
      if(!context)throw Object.assign(Error('Unauthorized'),{status:401,code:'UNAUTHORIZED'});
      downloadLease=await store.openForDownload(context,download[1]);
      const file=downloadLease.files[0];
      const fresh=await resolveContext(req,url,{download:true});
      if(!fresh||!['principalId','scopeId','cwd','threadId'].every(key=>fresh[key]===context[key]))throw Object.assign(Error('Unauthorized'),{status:401,code:'UNAUTHORIZED'});
      if(!Number.isSafeInteger(file.size)||file.size<0||file.size>25*1048576)throw Object.assign(Error('Unavailable'),{status:404,code:'NOT_FOUND'});
      res.writeHead(200,{'content-type':'application/octet-stream','content-disposition':attachmentName(file.name),'content-length':file.size,'cache-control':'private, no-store','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; sandbox"});
      const stream=createReadStream(file.path);const timeout=setTimeout(()=>stream.destroy(Error('Download timeout')),590000);timeout.unref();
      try{await pipeline(stream,res);}finally{clearTimeout(timeout);}
      return true;
    }
    const id=url.pathname===PREFIX?'':url.pathname.slice(PREFIX.length+1);
    if(id&&!/^[a-f0-9]{32}$/.test(id)){json(res,404,{error:'Attachment not found',code:'NOT_FOUND'});return true;}
    if(!['GET','POST','DELETE'].includes(req.method)||(id&&req.method==='POST')||(!id&&req.method==='DELETE')){
      json(res,405,{error:'Method not allowed',code:'METHOD_NOT_ALLOWED'});return true;
    }
    if(req.method!=='GET'&&req.headers['x-codex-webui']!=='1'){
      json(res,403,{error:'A same-origin attachment request is required',code:'REQUEST_HEADER_REQUIRED'});return true;
    }
    const context=await resolveContext(req,url);
    if(!context)throw Object.assign(Error('Unauthorized'),{status:401,code:'UNAUTHORIZED'});
    if(req.method==='GET'){
      if(id){json(res,404,{error:'Attachment not found',code:'NOT_FOUND'});return true;}
      json(res,200,{attachments:await store.list(context)});return true;
    }
    if(req.method==='DELETE'){
      await store.remove(context,id);json(res,200,{removed:true});return true;
    }
    let name;
    try{name=decodeURIComponent(String(req.headers['x-file-name']||''));}catch{throw Object.assign(Error('Invalid attachment filename'),{status:400,code:'INVALID_NAME'});}
    if(!name||name.length>512)throw Object.assign(Error('Invalid attachment filename'),{status:400,code:'INVALID_NAME'});
    const declaredSize=req.headers['content-length']===undefined?undefined:Number(req.headers['content-length']);
    if(declaredSize!==undefined&&(!Number.isSafeInteger(declaredSize)||declaredSize<0))throw Object.assign(Error('Invalid attachment length'),{status:400,code:'INVALID_SIZE'});
    const value=await store.upload({context,name,type:String(req.headers['content-type']||'application/octet-stream'),stream:req,declaredSize});
    try{
      const fresh=await resolveContext(req,url);
      if(!sameContext(context,fresh))throw Object.assign(Error('Attachment authority changed'),{status:403,code:'CONTEXT_CHANGED'});
    }catch(error){
      await store.remove(context,value.id).catch(()=>{});
      throw error;
    }
    json(res,200,value);
  }catch(error){
    if(res.headersSent){res.destroy();return true;}
    const status=Number(error.status||error.statusCode);
    // Storage/native errors must not expose physical paths or supplied filenames.
    const code=/^[a-z][a-z0-9_]{0,63}$/i.test(error.code||'')?error.code.toUpperCase():'ATTACHMENT_ERROR';
    json(res,status>=400&&status<=599?status:400,{error:code==='UNAUTHORIZED'||status===401?'Unauthorized':'Attachment request failed',code});
  }finally{await downloadLease?.release();}
  return true;
}
