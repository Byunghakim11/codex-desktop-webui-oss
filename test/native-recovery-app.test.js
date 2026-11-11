import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {actualAppFunction} from '../test-support/workflow-app-harness.js';
function classes(){const values=new Set();return {add:(...keys)=>keys.forEach(key=>values.add(key)),remove:(...keys)=>keys.forEach(key=>values.delete(key)),toggle:(key,on)=>{if(on)values.add(key);else values.delete(key);},contains:key=>values.has(key)};}
test('new draft clears only its inherited stale profile flag after a successful draft switch',()=>{
 const noop=()=>{},state={currentThread:{id:'A'},threadLoadSeq:1,needsConnectionSettingsRefresh:true};const context=vm.createContext({state,workflowDraftSerial:0,composerDrafts:{switchThread:()=>true},els:{projectSelect:{value:''},sidebar:{classList:classes()},promptInput:{focus:noop}},stopCurrentThreadSync:noop,preferredScopedCwd:()=>'',setProjectSelection:noop,updateThreadUrl:noop,t:key=>key,resetTurnPaging:noop,updateThreadHeader:noop,updateProjectSelectState:noop,updateTrafficSummary:noop,renderEmpty:noop,renderThreads:noop,applyBridgeModeUi:noop,refreshWorkflow:noop});
 vm.runInContext(actualAppFunction('createThread'),context);assert.equal(context.createThread(),true);assert.equal(state.currentThread.draft,true);assert.equal(state.needsConnectionSettingsRefresh,false);
 state.needsConnectionSettingsRefresh=true;state.currentThread={id:'B'};context.composerDrafts.switchThread=()=>false;assert.equal(context.createThread(),false);assert.equal(state.needsConnectionSettingsRefresh,true);assert.equal(state.currentThread.id,'B');
});
test('a loaded chat with stale settings exposes an enabled retry instead of a disabled connected button',()=>{
 const button={classList:classes()},state={desktopBridgeConnected:true,currentThread:{id:'A',status:'idle'},needsConnectionSettingsRefresh:true};
 const context=vm.createContext({state,els:{resumeStatus:button,chatPane:{classList:classes()}},asyncQuestionCards:{refresh(){}},nativeRecovery:{getState:()=>({running:false})},formatStatus:value=>value,t:key=>key});
 vm.runInContext(actualAppFunction('updateResumeStatus'),context);context.updateResumeStatus(state.currentThread);
 assert.equal(button.disabled,false);assert.equal(button.textContent,'connectionRuntime.settingsRetry');
});
test('transport and native readiness are part of Send gating independently of cached content',()=>{
 const state={connected:false,desktopBridgeConnected:true};const context=vm.createContext({state});vm.runInContext(actualAppFunction('isSendBlocked'),context);assert.equal(context.isSendBlocked(),true);state.connected=true;state.desktopBridgeConnected=false;assert.equal(context.isSendBlocked(),true);state.desktopBridgeConnected=true;assert.equal(context.isSendBlocked(),false);
});
test('settings recovery requests metadata only and updates Send after clearing stale state',async()=>{
 const calls=[],sendStates=[],state={connected:true,desktopBridgeConnected:true,currentThread:{id:'A'},threadLoadSeq:1,nativeBridgeEpoch:1,needsConnectionSettingsRefresh:true};const noop=()=>{};
 const context=vm.createContext({state,connectionSession:{getState:()=>({generation:1})},connectionSettingsTask:null,rpc:async(method,params)=>{calls.push({method,params});return {thread:{id:'A'},model:'same-native-model'};},threadSettingsFromResume:result=>result,applyThreadSettings:noop,cacheThreadSettings:noop,updateThreadHeader:noop,applyBridgeModeUi:noop,updateSendMode:()=>sendStates.push(!state.needsConnectionSettingsRefresh),t:key=>key});
 vm.runInContext(actualAppFunction('refreshConnectionSettings'),context);assert.equal(await context.refreshConnectionSettings(),true);assert.deepEqual(JSON.parse(JSON.stringify(calls[0])),{method:'thread/resume',params:{threadId:'A',excludeTurns:true}});assert.deepEqual(sendStates,[true]);
});
test('background cache uses a shallow display summary instead of full tool output',async()=>{
 let params;const state={backgroundCacheLastReadAt:new Map(),currentThread:{id:'A'},threads:[]};const context=vm.createContext({state,Date,TURN_ITEMS_VIEW:'full',BACKGROUND_REFRESH_MS:1000,rpc:async(_method,value)=>{params=value;return {data:[]};},latestTurnTimestamp:()=>null,threadTimestamp:()=>null,cacheRecentThreadPage(){},turnLifecycle:()=>null,scheduleBackgroundThreadCache(){}});vm.runInContext('async '+actualAppFunction('refreshBackgroundThreadCache'),context);await context.refreshBackgroundThreadCache('B');assert.equal(params.itemsView,'summary');
});
