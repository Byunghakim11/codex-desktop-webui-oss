import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeRecovery} from '../public/native-recovery.js';
const flush=async()=>{for(let n=0;n<18;n++)await Promise.resolve();};
function fixture(options={}){
 let clock=0,serial=0;const timers=new Map(),calls=[],states=[];
 const context={key:'A:1',browserConnected:true,nativeConnected:false,needsSettings:true,visible:true};
 const recovery=createNativeRecovery({getContext:()=>({...context}),probe:async()=>{calls.push('probe');context.nativeConnected=true;},restore:async()=>{calls.push('settings');context.needsSettings=false;},onRecovered:()=>calls.push('ready'),onState:s=>states.push(s),setTimer:(fn,ms)=>{const id=++serial;timers.set(id,{fn,at:clock+ms});return id;},clearTimer:id=>timers.delete(id),baseDelayMs:10,maxDelayMs:80,maxAttempts:3,...options});
 const advance=async ms=>{const end=clock+ms;for(let n=0;n<30;n++){const next=[...timers].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;clock=next[1].at;timers.delete(next[0]);next[1].fn();await flush();}clock=end;await flush();};
 return {context,calls,states,recovery,timers,advance};
}
test('native recovery owns one probe and one settings read through overlapping status requests',async()=>{
 const f=fixture();f.recovery.request();f.recovery.request();assert.equal(f.timers.size,1);await f.advance(10);assert.deepEqual(f.calls,['probe','settings','ready']);assert.equal(f.timers.size,0);f.recovery.dispose();
});
test('settings failure retries with backoff and success releases Send readiness',async()=>{
 let attempts=0;let f;f=fixture({restore:async()=>{attempts++;f.calls.push('settings');if(attempts===1)throw Error('transient');f.context.needsSettings=false;}});
 f.recovery.request();await f.advance(10);assert.equal(f.context.needsSettings,true);await f.advance(19);assert.equal(attempts,1);await f.advance(1);assert.equal(attempts,2);assert.equal(f.context.needsSettings,false);assert.equal(f.calls.filter(x=>x==='probe').length,1);assert.equal(f.calls.at(-1),'ready');f.recovery.dispose();
});
test('native reconnect cannot start a second restoration from its own status event',async()=>{
 let f;f=fixture({probe:async()=>{f.calls.push('probe');f.context.nativeConnected=true;f.recovery.request({immediate:true});}});f.recovery.request();await f.advance(10);assert.deepEqual(f.calls,['probe','settings','ready']);f.recovery.dispose();
});
test('recovery is bounded and an explicit retry can restart it without replaying a turn',async()=>{
 let count=0;const f=fixture({probe:async()=>{count++;throw Error('down');}});f.recovery.request();await f.advance(1000);assert.equal(count,3);assert.equal(f.recovery.getState().exhausted,true);assert.equal(f.timers.size,0);f.recovery.request({immediate:true});await f.advance(100);assert.equal(count,3);f.recovery.retry();await f.advance(0);assert.equal(count,4);f.recovery.dispose();
});
test('browser-offline and hidden contexts do not issue recovery RPCs',async()=>{
 const f=fixture();f.context.browserConnected=false;f.recovery.request();await f.advance(100);assert.deepEqual(f.calls,[]);f.context.browserConnected=true;f.context.visible=false;f.recovery.request();await f.advance(100);assert.deepEqual(f.calls,[]);f.context.visible=true;f.recovery.request({immediate:true});await f.advance(0);assert.deepEqual(f.calls,['probe','settings','ready']);f.recovery.dispose();
});
test('a stale navigation completion cannot mark another conversation ready',async()=>{
 let finish;let f;f=fixture({restore:()=>new Promise(resolve=>{finish=resolve;})});f.recovery.request();await f.advance(10);f.context.key='B:2';f.context.needsSettings=false;finish(true);await flush();assert.equal(f.calls.includes('ready'),false);assert.equal(f.timers.size,0);f.recovery.dispose();
});
test('disposal clears timers and prevents later work',async()=>{
 const f=fixture();f.recovery.request();f.recovery.dispose();await f.advance(100);assert.deepEqual(f.calls,[]);assert.equal(f.timers.size,0);
});
