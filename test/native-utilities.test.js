import test from "node:test";import assert from "node:assert/strict";import fs from "node:fs/promises";import os from "node:os";import path from "node:path";
import {createNativeUtilities} from "../server/native-utilities.js";import {createConfirmationStore} from "../server/native-confirmations.js";
async function fixture(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),"cw-utilities-"));t.after(()=>fs.rm(dir,{recursive:true,force:true,maxRetries:5}));const state={id:"thread-1",cwd:dir,status:{type:"idle"},model:"configured-model",reasoningEffort:"high"};const calls=[];let callback;
 const service=createNativeUtilities({callNative:async(method,params)=>{calls.push({method,params});if(callback)return callback(method,params);if(method==="collaborationMode/list")return {data:[{name:"Plan",mode:"plan"},{name:"Default",mode:"default"}]};if(method==="thread/memory/read")return {summary:"thread-only synthetic memory"};if(method==="mcpServerStatus/list")return {data:[{name:"test",authStatus:"loggedIn",tools:{sample:{secret:"never expose tool config"}}}]};if(method==="skills/list")return {data:[{skills:[{name:"demo",description:"test",path:"never expose path"}]}]};if(method==="plugin/list")return {marketplaces:[{plugins:[{id:"demo",name:"Test",installed:true,source:{token:"never expose"}}]}]};if(method==="app/list")return {data:[{id:"app-demo",name:"Demo",isEnabled:true,installUrl:"never expose"}]};return {};},authorizeThread:async(_scope,id)=>{assert.equal(id,state.id);return {...state};},confirmations:createConfirmationStore({dataDir:dir})});return {service,calls,state,setCallback:fn=>callback=fn};}
const scope={id:"owner",tokenHash:"a".repeat(64)};
test("catalog routes use fixed native methods and strip raw credentials, tool schemas and paths",async t=>{
 const f=await fixture(t);for(const action of ["tools.mcp","tools.skills","tools.plugins","tools.apps","memory.read","plan.describe","thread.status"]){const result=await f.service.execute(scope,{action,threadId:f.state.id,params:{}});assert.equal(result.ok,true);assert.equal(JSON.stringify(result).includes("never expose"),false);}
 assert.deepEqual(f.calls.map(call=>call.method),["mcpServerStatus/list","skills/list","plugin/list","app/list","thread/memory/read","collaborationMode/list"]);
 assert.equal(f.calls.find(call=>call.method==="skills/list").params.cwds[0],f.state.cwd);
 for(const action of ["tools.mcp","tools.plugins","tools.apps"])await assert.rejects(f.service.execute({...scope,threadFilterCwds:[f.state.cwd]},{action,threadId:f.state.id,params:{}}),{code:"THREAD_SCOPE_FORBIDDEN"});
});
test("utility mutations require fresh single-use confirmations and never change the configured model",async t=>{
 const f=await fixture(t),params={mode:"plan",expectedModel:f.state.model,expectedEffort:"high"},request={action:"plan.set",threadId:f.state.id,params};
 await assert.rejects(f.service.execute(scope,request),{code:"CONFIRMATION_REQUIRED"});const receipt=await f.service.prepareConfirmation(scope,request);
 const result=await f.service.execute(scope,{...request,confirmationId:receipt.confirmationId});assert.equal(result.status,"accepted");
 assert.deepEqual(f.calls.at(-1),{method:"thread/settings/update",params:{threadId:f.state.id,collaborationMode:{mode:"plan",settings:{model:"configured-model",reasoning_effort:"high",developer_instructions:null}}}});
 await assert.rejects(f.service.execute(scope,{...request,confirmationId:receipt.confirmationId}));assert.equal(f.calls.filter(call=>call.method==="thread/settings/update").length,1);
});
test("state changes, running work and arbitrary native parameters are refused before mutation",async t=>{
 const f=await fixture(t),request={action:"thread.compact",threadId:f.state.id,params:{}};const receipt=await f.service.prepareConfirmation(scope,request);f.state.model="changed";
 await assert.rejects(f.service.execute(scope,{...request,confirmationId:receipt.confirmationId}));assert.equal(f.calls.length,0);
 f.state.status={type:"active"};await assert.rejects(f.service.prepareConfirmation(scope,request),{code:"THREAD_BUSY"});
 for(const action of ["memory.disable","tools.mcp","thread.compact"])await assert.rejects(f.service.execute(scope,{action,threadId:f.state.id,params:{cwd:"C:/outside",_meta:{approved:true}}}));assert.equal(f.calls.length,0);
});
test("review runs inline and memory mode changes affect only the selected thread",async t=>{
 const f=await fixture(t);
 for(const [action,params,method,expected]of [["review.start",{target:"commit",sha:"abcdef1"},"review/start",{threadId:f.state.id,target:{type:"commit",sha:"abcdef1"},delivery:"inline"}],["memory.disable",{},"thread/memoryMode/set",{threadId:f.state.id,mode:"disabled"}],["thread.compact",{},"thread/compact/start",{threadId:f.state.id}]]){
 const request={action,threadId:f.state.id,params},receipt=await f.service.prepareConfirmation(scope,request);await f.service.execute(scope,{...request,confirmationId:receipt.confirmationId});assert.deepEqual(f.calls.at(-1),{method,params:expected});}
});
