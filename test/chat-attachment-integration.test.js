import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {startInteractiveFixture} from '../test-support/interactive-fixture.js';

test('general file API reaches the existing shared bridge for normal, guide and queued sends',async()=>{
 const f=await startInteractiveFixture();
 try{
  const client=await f.connect();
  const threadId='thread-fixture';
  const thread=(await client.rpc('thread/read',{threadId,includeTurns:false})).thread;
  for(const method of ['turn/start','turn/steer','thread/queue/add']){
   const draftId=randomUUID();
   const url=new URL('/api/chat-attachments',f.baseUrl);
   for(const [key,value] of Object.entries({token:f.token,draftId,cwd:thread.cwd,threadId}))url.searchParams.set(key,value);
   const response=await fetch(url,{method:'POST',headers:{'x-codex-webui':'1','x-file-name':encodeURIComponent('검증.xlsx'),'content-type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'},body:Buffer.from('PK-test-workbook')});
   const file=await response.json();assert.equal(response.status,200,JSON.stringify(file));assert.equal('path' in file,false);
   const request={threadId,input:[{type:'text',text:'Read the attached file',text_elements:[]}],attachmentIds:[file.id],draftId,draftCwd:thread.cwd,clientSendId:randomUUID(),clientUserMessageId:randomUUID(),...(method==='turn/steer'?{expectedTurnId:'turn-fixture'}:{})};
   const result=await client.rpc(method,request);
   const input=result.receivedParams?.input || result.queuedSubmission?.input;
   assert.ok(input,'fake native acknowledgement contains the actual input');
   const text=input.filter(x=>x.type==='text').map(x=>x.text).join('\n');
   assert.match(text,/検証|검증/);assert.equal(text.includes('<codex-webui-attachments-v1>'),false);assert.equal(text.includes(f.dataDir),false);
   assert.equal(input.some(x=>x.type==='localFile'),false);
   const outcome=await client.rpc('webui/attachment-send/status',{clientSendId:request.clientSendId});assert.equal(outcome.status,'accepted');
   const download=await fetch(`${f.baseUrl}/api/chat-attachments/${file.id}/download?threadId=${threadId}`,{headers:{authorization:`Bearer ${f.token}`}});
   assert.equal(download.status,200);assert.deepEqual(Buffer.from(await download.arrayBuffer()),Buffer.from('PK-test-workbook'));
   assert.ok(input.some(entry=>entry.webuiAttachments?.some(att=>att.id===file.id&&att.name==='검증.xlsx')),'safe history metadata survives stripping internal paths');
   await assert.rejects(client.rpc(method,{...request,attachmentIds:['f'.repeat(32)]}));
  }
  client.close();
 }finally{await f.close();}
});
