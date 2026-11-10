import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {AttachmentSendLedger} from '../server/chat-attachment-send.js';

test('uncertain native calls never auto-send a second time, including after restart',async()=>{
 const dataDir=await mkdtemp(path.join(os.tmpdir(),'chat-send-ledger-'));
 try{
  const params={threadId:'thread',attachmentIds:['a'.repeat(32)],clientSendId:'11c69e42-09a8-4e3c-8df5-e9eb7affef4a'};
  let calls=0; const ledger=new AttachmentSendLedger({dataDir});
  await assert.rejects(ledger.send('principal',params,async()=>{calls++;throw Error('timeout');}),e=>e.code==='ATTACHMENT_SEND_UNKNOWN');
  const next=new AttachmentSendLedger({dataDir});
  await assert.rejects(next.send('principal',params,async()=>{calls++;}),e=>e.code==='ATTACHMENT_SEND_UNKNOWN');
  assert.equal(calls,1);assert.equal((await next.status('principal',params.clientSendId)).status,'unknown');
 }finally{await rm(dataDir,{recursive:true,force:true});}
});
test('accepted retries reuse the native acknowledgement and different payloads conflict',async()=>{
 const dataDir=await mkdtemp(path.join(os.tmpdir(),'chat-send-ledger-'));
 try{
  const ledger=new AttachmentSendLedger({dataDir});let calls=0;
  const params={threadId:'thread',clientSendId:'e233421b-989d-4c8d-bb16-873f48cf58f4',attachmentIds:['b'.repeat(32)]};
  await ledger.send('principal',params,async()=>{calls++;return {turn:{id:'turn'},privateStuff:'do not persist'};});
  assert.deepEqual(await ledger.send('principal',params,async()=>{calls++;}),{turn:{id:'turn'}});
  await assert.rejects(ledger.send('principal',{...params,threadId:'other'},async()=>{}),e=>e.code==='ATTACHMENT_SEND_CONFLICT');
  assert.equal(calls,1);assert.equal((await ledger.status('other',params.clientSendId)).status,'missing');
 }finally{await rm(dataDir,{recursive:true,force:true});}
});
