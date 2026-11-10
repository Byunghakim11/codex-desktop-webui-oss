import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {serveProjectWrites} from '../server/project-writes-http.js';

async function fixture(run){
 const calls=[];let available=true;
 const writes={};
 for(const key of ['issueContext','mkdir','editOpen','saveText','operationStatus'])writes[key]=async input=>{
   assert.deepEqual(await input.resolveScope(),{id:'scope'});calls.push({key,input});return {ok:true};
 };
 writes.upload=async input=>{let size=0;for await(const chunk of input.stream)size+=chunk.length;calls.push({key:'upload',input,size});return {status:'succeeded'};};
 const server=createServer(async(req,res)=>{if(!await serveProjectWrites(req,res,new URL(req.url,'http://localhost'),{writes,resolveScope:async()=>available?{id:'scope'}:null})){res.writeHead(404);res.end();}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{await run({base:`http://127.0.0.1:${server.address().port}`,calls,deny:()=>available=false});}
 finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
const headers={'content-type':'application/json','x-codex-files':'1'};
test('write HTTP maps typed JSON actions and keeps scope server-owned',()=>fixture(async({base,calls})=>{
 const response=await fetch(base+'/api/project-files/write-context',{method:'POST',headers,body:JSON.stringify({threadId:'thread',rootRevision:'revision',parentPath:'docs'})});
 assert.equal(response.status,200);assert.equal(calls[0].key,'issueContext');assert.deepEqual(calls[0].input.query,{threadId:'thread',rootRevision:'revision',parentPath:'docs'});
 assert.equal((await fetch(base+'/api/project-files/save-text',{method:'POST',headers,body:JSON.stringify({contextId:'id',path:'docs/a.md',operationId:'operation',text:'',expectedVersion:'version'})})).status,200);
 assert.equal(calls[1].input.text,'');
}));
test('project uploads stream to the selected target and retain request cancellation',()=>fixture(async({base,calls})=>{
 const response=await fetch(base+'/api/project-files/upload',{method:'POST',headers:{'x-codex-files':'1','x-write-context':'context','x-file-path':encodeURIComponent('docs/검증.xlsx'),'x-operation-id':'operation','content-type':'application/octet-stream'},body:Buffer.from([1,2,3,4])});
 assert.equal(response.status,200);assert.equal(calls[0].size,4);assert.equal(calls[0].input.path,'docs/검증.xlsx');assert.ok(calls[0].input.signal instanceof AbortSignal);
}));
test('write HTTP denies simple requests, forged roots, unauthenticated and oversized JSON',()=>fixture(async({base,deny,calls})=>{
 assert.equal((await fetch(base+'/api/project-files/mkdir',{method:'POST',body:'{}'})).status,403);
 assert.equal((await fetch(base+'/api/project-files/mkdir',{method:'POST',headers,body:'{"root":"C:\\\\private"}'})).status,400);
 assert.equal((await fetch(base+'/api/project-files/save-text',{method:'POST',headers,body:JSON.stringify({text:'x'.repeat(8*1048576)})})).status,413);
 deny();assert.equal((await fetch(base+'/api/project-files/edit-open',{method:'POST',headers,body:'{}'})).status,401);assert.equal(calls.length,0);
}));
