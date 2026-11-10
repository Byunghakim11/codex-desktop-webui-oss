import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { serveChatAttachments } from '../server/chat-attachments-http.js';
import { ChatAttachments } from '../server/chat-attachments.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('sent document downloads original bytes; ready and foreign owner are denied',async t=>{
 const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'cw-download-http-'));
 const store=new ChatAttachments({dataDir});
 const context={principalId:'owner',scopeId:'scope',cwd:path.join(os.tmpdir(),'synthetic-workspace'),threadId:'thread-synthetic',draftId:'11111111-1111-4111-8111-111111111111'};
 const bytes=Buffer.from([0x50,0x4b,0,1,255,8]);
 const item=await store.upload({context,name:'synthetic.xlsx',type:'application/octet-stream',stream:(async function*(){yield bytes;})(),declaredSize:bytes.length});
 let current=context;
 const server=createServer(async(req,res)=>{await serveChatAttachments(req,res,new URL(req.url,'http://localhost'),{store,resolveContext:async()=>({...current,draftId:null})});});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await store.close();await fs.rm(dataDir,{recursive:true,force:true,maxRetries:5});});
 const url=`http://127.0.0.1:${server.address().port}/api/chat-attachments/${item.id}/download?threadId=thread-synthetic`;
 assert.notEqual((await fetch(url)).status,200);
 const lease=await store.acquire(context,[item.id]);await lease.commit();
 const response=await fetch(url);assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes);
 assert.match(response.headers.get('content-disposition'),/attachment/);assert.match(response.headers.get('cache-control'),/no-store/);assert.equal(response.headers.get('x-content-type-options'),'nosniff');
 current={...context,principalId:'other'};assert.notEqual((await fetch(url)).status,200);
});

async function fixture(run) {
  const context = { principalId:'owner',scopeId:'scope',cwd:'workspace',draftId:'draft' };
  const calls = []; let authorized = true;
  const store = {
    async upload(value) { let size=0; for await(const chunk of value.stream) size+=chunk.length; calls.push(value); return {id:'a'.repeat(32),name:value.name,size,status:'ready'}; },
    async list() { return []; },
    async remove(ctx,id) { calls.push({removed:id}); }
  };
  const server=createServer(async(req,res)=>{
    const url=new URL(req.url,'http://localhost');
    if(!await serveChatAttachments(req,res,url,{store,resolveContext:async()=>{ if(!authorized)throw Object.assign(Error('Unauthorized'),{status:401}); return context; }})){res.writeHead(404);res.end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try { await run({base:`http://127.0.0.1:${server.address().port}`,calls,deny:()=>authorized=false}); }
  finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}

test('ordinary Excel bytes upload without an image MIME and no path in response',()=>fixture(async({base,calls})=>{
  const response=await fetch(base+'/api/chat-attachments',{method:'POST',headers:{'x-codex-webui':'1','x-file-name':encodeURIComponent('설계.xlsx'),'content-type':'application/octet-stream'},body:Buffer.from([0x50,0x4b,1,2])});
  assert.equal(response.status,200); const body=await response.json();
  assert.equal(body.name,'설계.xlsx');assert.equal(body.size,4);assert.equal('path' in body,false);assert.equal(calls[0].context.principalId,'owner');
}));
test('upload and delete require non-simple same-origin request marker',()=>fixture(async({base,calls})=>{
  const response=await fetch(base+'/api/chat-attachments',{method:'POST',body:'bytes'});assert.equal(response.status,403);
  const deletion=await fetch(base+'/api/chat-attachments/'+'a'.repeat(32),{method:'DELETE'});assert.equal(deletion.status,403);assert.equal(calls.length,0);
}));
test('fresh authority is checked after streaming and deletes only this failed upload',()=>fixture(async({base,calls,deny})=>{
  deny();const response=await fetch(base+'/api/chat-attachments',{method:'POST',headers:{'x-codex-webui':'1','x-file-name':'book.xlsx'},body:'data'});
  assert.equal(response.status,401);assert.equal(calls.length,0);
}));
test('malformed file name and method fail safely',()=>fixture(async({base})=>{
  const response=await fetch(base+'/api/chat-attachments',{method:'POST',headers:{'x-codex-webui':'1','x-file-name':'%GG'},body:'bytes'});
  assert.equal(response.status,400);assert.equal((await response.json()).error.includes('%GG'),false);
  assert.equal((await fetch(base+'/api/chat-attachments',{method:'PUT'})).status,405);
}));
