import test from "node:test";
import assert from "node:assert/strict";
import { loadInitialView, restoreOwnedThread, recoverThreadPage, shouldRecoverThread, latestCachedPage } from "../public/performance-policy.js";
import { ReadRequestCoalescer } from "../server/read-request-coalescer.js";

test("linked conversation starts and becomes ready without waiting for slow manifest",async()=>{
  let resolveManifest,opened=false,manifestDone=false;const manifest=new Promise(resolve=>{resolveManifest=()=>{manifestDone=true;resolve(true);};});
  await loadInitialView({loadManifest:()=>manifest,loadSettings:async()=>[],openExplicit:async()=>{opened=true;return true;},openFallback:()=>assert.fail("no fallback"),afterSettings(){},onError(){}});
  assert.equal(opened,true);assert.equal(manifestDone,false);resolveManifest();
});

test("manifest RPC starts after foreground setup, avoiding native queue head-of-line blocking",async()=>{
  const events=[];await loadInitialView({loadManifest:async()=>events.push("manifest"),loadSettings:async()=>[],openExplicit:async()=>{events.push("open");await Promise.resolve();events.push("resumed");return true;},openFallback(){},afterSettings(){},onError(){}});assert.deepEqual(events,["open","resumed","manifest"]);
});

test("latest recovery fills unknown gaps and reestablishes a disjoint window",async()=>{
  const limits=[];const result=await recoverThreadPage({working:true,knownTurnIds:new Set(["T1"]),read:async limit=>{limits.push(limit);return {data:limit===1?[{id:"T3",status:"inProgress"}]:[{id:"T3"},{id:"T2"},{id:"T1"}],nextCursor:"older"};}});
  assert.deepEqual(limits,[1,6]);assert.equal(result.latestOnly,false);assert.equal(result.backfill,true);assert.equal(result.resetWindow,false);
  const disjoint=await recoverThreadPage({working:true,knownTurnIds:new Set(["T1"]),read:async()=>({data:[{id:"T9",status:"inProgress"}]})});assert.equal(disjoint.resetWindow,true);
  const steady=[];assert.equal((await recoverThreadPage({working:true,knownTurnIds:new Set(["T3"]),read:async limit=>{steady.push(limit);return {data:[{id:"T3",status:"inProgress"}]};}})).latestOnly,true);assert.deepEqual(steady,[1]);
});

test("recovery rechecks ownership and final head after a supplemental read",async()=>{
  let current=true;const cancelled=await recoverThreadPage({working:true,knownTurnIds:new Set(["T1"]),stillCurrent:()=>current,read:async limit=>{if(limit===6)current=false;return {data:[{id:"T3",status:"inProgress"}]};}});assert.equal(cancelled,null);
  const changed=await recoverThreadPage({working:true,knownTurnIds:new Set(["T1"]),read:async limit=>({data:limit===1?[{id:"T1",status:"completed"}]:[{id:"T9",status:"inProgress"},{id:"T8"}]})});assert.equal(changed.backfill,true);assert.equal(changed.resetWindow,true);
});
test("settings barrier settles even when setup fails, without awaiting the manifest",async()=>{
  let release;const barrier=new Promise(resolve=>{release=resolve;});let applied=false;
  await loadInitialView({loadManifest:()=>new Promise(()=>{}),loadSettings:async()=>{throw new Error("fixture");},openExplicit:async()=>{await barrier;applied=true;return true;},afterSettings(){},onSettingsSettled:release,onError(){}});assert.equal(applied,true);
});

test("startup stops its candidates when the user selects a different chat",async()=>{
  let version=0,release;const attempted=[];const pending=restoreOwnedThread(["A","C"],id=>{attempted.push(id);version++;return new Promise(resolve=>{release=resolve;});},()=>version);
  version++;release(false);const result=await pending;assert.equal(result.cancelled,true);assert.deepEqual(attempted,["A"]);
});
test("fallback waits for manifest and errors do not become unhandled rejections",async()=>{
  const events=[];await loadInitialView({loadManifest:async()=>{events.push("manifest");return true;},loadSettings:async()=>[],openExplicit:async()=>false,openFallback:async()=>events.push("fallback"),afterSettings(){},onError(){}});assert.deepEqual(events,["manifest","fallback"]);
});
test("healthy push postpones recovery only within a bounded window",()=>{
  assert.equal(shouldRecoverThread({working:true,lastPushAt:9500,lastRecoveryAt:5000,now:10000}),false);
  assert.equal(shouldRecoverThread({working:true,lastPushAt:9500,lastRecoveryAt:1000,now:10000}),true);
  assert.equal(shouldRecoverThread({working:true,lastPushAt:5000,lastRecoveryAt:9000,now:10000}),true);
  assert.equal(shouldRecoverThread({working:false,lastPushAt:9999,lastRecoveryAt:9999,now:10000}),true);
});
test("latest-only recovery preserves cached history; rollback drops future turns",()=>{
  const cache={turns:[{id:"3"},{id:"2"},{id:"1"}],nextCursor:"older",shallow:false};
  const same=latestCachedPage(cache,{data:[{id:"3",updated:true}],nextCursor:"to2"});assert.deepEqual(same.turns.map(t=>t.id),["3","2","1"]);assert.equal(same.nextCursor,"older");assert.equal(same.shallow,false);
  assert.deepEqual(latestCachedPage(cache,{data:[{id:"2"}],nextCursor:"to1"}).turns.map(t=>t.id),["2","1"]);
  assert.equal(latestCachedPage(cache,{data:[{id:"new"}],nextCursor:"to3"}).shallow,true);
});
test("identical in-flight reads coalesce, mutations never coalesce, results are not cached",async()=>{
  const coalescer=new ReadRequestCoalescer();let calls=0,release;const read=()=>{calls++;return new Promise(resolve=>{release=resolve;});};
  const a=coalescer.run("thread/list",{limit:100,archived:false},read),b=coalescer.run("thread/list",{archived:false,limit:100},read);await Promise.resolve();assert.equal(calls,1);release({data:[]});await Promise.all([a,b]);
  await coalescer.run("thread/list",{limit:100},async()=>{calls++;});assert.equal(calls,2);
  await Promise.all([coalescer.run("turn/start",{},async()=>{calls++;}),coalescer.run("turn/start",{},async()=>{calls++;})]);assert.equal(calls,4);
  await Promise.all([coalescer.run("thread/read",{threadId:"A"},async()=>{calls++;}),coalescer.run("thread/read",{threadId:"A"},async()=>{calls++;})]);assert.equal(calls,6);
});
