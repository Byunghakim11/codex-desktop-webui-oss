import test from "node:test";
import assert from "node:assert/strict";
import { createNativeTransport, nativeWorkspaceMessages } from "../public/native-workspace.js";
test("native transport keeps credentials in headers and rejects late changed context",async()=>{
 let context={threadId:"thread-test",token:"private-test-token",connected:true};let release;
 const transport=createNativeTransport({getContext:()=>context,fetchImpl:async(url,options)=>{
  assert.equal(url,"/api/native-actions/execute");assert.equal(url.includes(context.token),false);
  assert.equal(options.headers.authorization,"Bearer private-test-token");assert.equal(options.headers["x-codex-webui"],"1");
  await new Promise(resolve=>release=resolve);return {ok:true,json:async()=>({ok:true})};
 }});
 const request=transport.execute({action:"thread.read",threadId:"thread-test",params:{}});
 context={...context,threadId:"another"};release();await assert.rejects(request,{code:"CONTEXT_CHANGED"});
});
test("native workspace labels contain both supported languages",()=>assert.deepEqual(Object.keys(nativeWorkspaceMessages.en).sort(),Object.keys(nativeWorkspaceMessages.ko).sort()));
