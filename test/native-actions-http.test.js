import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {serveNativeActions} from '../server/native-actions-http.js';

async function fixture(run){
 const calls=[];let expired=false;
 const service=Object.fromEntries(['describe','getGoal','prepareConfirmation','execute'].map(name=>[name,async(scope,body)=>{calls.push({name,scope,body});return {ok:true,threadId:body.threadId};}]));
 const server=createServer(async(req,res)=>{if(!await serveNativeActions(req,res,new URL(req.url,'http://localhost'),{service,resolveScope:async()=>expired?null:{id:'owner'}})){res.writeHead(404);res.end();}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try{await run({base:`http://127.0.0.1:${server.address().port}`,calls,expire:()=>expired=true});}
 finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
const headers={'content-type':'application/json','x-codex-webui':'1'};
test('native HTTP provides typed, authenticated service actions only',()=>fixture(async({base,calls})=>{
 const response=await fetch(base+'/api/native-actions/execute',{method:'POST',headers,body:JSON.stringify({action:'goal.pause',threadId:'thread',params:{expectedVersion:'none'},requestId:'request'})});
 assert.equal(response.status,200);assert.equal(calls[0].name,'execute');assert.equal(calls[0].scope.id,'owner');
 assert.equal((await fetch(base+'/api/native-actions/mcpServer/tool/call',{method:'POST',headers,body:'{}'})).status,404);
}));
test('CSRF-simple requests, extra proxy fields, unauthenticated and oversized requests fail closed',()=>fixture(async({base,calls,expire})=>{
 assert.equal((await fetch(base+'/api/native-actions/execute',{method:'POST',body:'{}'})).status,403);
 assert.equal((await fetch(base+'/api/native-actions/execute',{method:'POST',headers,body:JSON.stringify({threadId:'thread',server:'codex_app',tool:'anything'})})).status,400);
 assert.equal((await fetch(base+'/api/native-actions/goal',{method:'POST',headers,body:JSON.stringify({threadId:'x'.repeat(40000)})})).status,413);
 expire();assert.equal((await fetch(base+'/api/native-actions/goal',{method:'POST',headers,body:'{"threadId":"thread"}'})).status,401);
 assert.equal(calls.length,0);
}));
