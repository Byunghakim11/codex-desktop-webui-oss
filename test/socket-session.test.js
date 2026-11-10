import test from "node:test";import assert from "node:assert/strict";import {createSocketSession} from "../public/socket-session.js";
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
function fixture(){
 let time=0,next=0,isOnline=true,isVisible=true,auth="valid";const jobs=new Map(),sockets=[],states=[],messages=[],disconnects=[];
 const clock={set(fn,ms){const id=++next;jobs.set(id,{fn,at:time+ms});return id;},clear(id){jobs.delete(id);},async advance(ms){const end=time+ms;for(let n=0;n<1000;n++){const entry=[...jobs].filter(([,j])=>j.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!entry)break;time=entry[1].at;jobs.delete(entry[0]);entry[1].fn();await flush();}time=end;await flush();}};
 class Socket{constructor(){this.readyState=0;this.listeners={};this.sent=[];this.closed=false;sockets.push(this);}addEventListener(type,fn){this.listeners[type]=fn;}send(text){if(this.readyState!==1)throw Error("closed");this.sent.push(JSON.parse(text));}close(){this.closed=true;this.readyState=3;this.listeners.close?.({});}open(){this.readyState=1;this.listeners.open?.({});}message(value){this.listeners.message?.({data:JSON.stringify(value)});}}
 const session=createSocketSession({url:()=>"wss://synthetic.invalid/ws?token=synthetic-retained",createSocket:()=>new Socket(),now:()=>time,setTimer:clock.set,clearTimer:clock.clear,random:()=>0.5,online:()=>isOnline,visible:()=>isVisible,probeAuth:async()=>typeof auth==="function"?auth():auth,onState:value=>states.push(value),onMessage:value=>messages.push(value),onDisconnect:value=>disconnects.push(value),connectTimeoutMs:10,heartbeatMs:20,pongTimeoutMs:15,probeTimeoutMs:8,retryBaseMs:2,retryMaxMs:20});
 return {session,clock,sockets,states,messages,disconnects,setOnline:value=>isOnline=value,setVisible:value=>isVisible=value,setAuth:value=>auth=value};
}
test("transient close before open retains authentication and schedules one retry",async()=>{
 const f=fixture();f.session.connect();f.sockets[0].close();await flush();assert.equal(f.session.getState().authRequired,false);assert.equal(f.session.getState().retryScheduled,true);await f.clock.advance(4);assert.equal(f.sockets.length,2);assert.equal(f.states.includes("auth-required"),false);f.session.dispose();
});
test("silent connecting transport has a finite deadline and ignores late open/message",async()=>{
 const f=fixture();f.session.connect();const old=f.sockets[0];await f.clock.advance(11);assert.equal(old.closed,true);await f.clock.advance(5);assert.equal(f.sockets.length,2);old.open();old.message({type:"late"});assert.deepEqual(f.messages,[]);assert.equal(f.session.getState().connected,false);f.session.dispose();
});
test("half-open transport recovers after missing pong and never replays mutations",async()=>{
 const f=fixture();f.session.connect();const old=f.sockets[0];old.open();await f.clock.advance(20);assert.equal(old.sent[0].type,"webui-ping");await f.clock.advance(15);assert.equal(old.closed,true);await f.clock.advance(5);assert.equal(f.sockets.length,2);assert.equal(old.sent.every(message=>message.type==="webui-ping"),true);f.session.dispose();
});
test("healthy pong keeps a slow native request independent from transport liveness",async()=>{
 const f=fixture();f.session.connect();const socket=f.sockets[0];socket.open();for(let i=0;i<5;i++){await f.clock.advance(20);socket.message({type:"webui-pong",nonce:socket.sent.at(-1).nonce});await f.clock.advance(5);}assert.equal(socket.closed,false);assert.equal(f.sockets.length,1);assert.deepEqual(f.messages,[]);f.session.dispose();
});
test("confirmed expiry stops retries; returning with a valid session reconnects once",async()=>{
 const f=fixture();f.setAuth("auth-required");f.session.connect();f.sockets[0].close();await flush();await f.clock.advance(40);assert.equal(f.sockets.length,1);assert.equal(f.session.getState().authRequired,true);f.setAuth("valid");f.session.visibilityChanged();f.session.visibilityChanged();await flush();await f.clock.advance(4);assert.equal(f.sockets.length,2);f.session.dispose();
});
test("overlapping online/focus/visibility events cannot open duplicate sockets",async()=>{
 const f=fixture();f.session.connect();f.sockets[0].open();f.setOnline(false);f.session.onlineChanged();await flush();await f.clock.advance(40);assert.equal(f.sockets.length,1);f.setOnline(true);f.session.onlineChanged();f.session.visibilityChanged();f.session.checkLiveness();assert.equal(f.sockets.length,2);f.session.dispose();
});
test("an old auth probe cannot block a newer healthy connection",async()=>{
 const f=fixture();let resolve;f.setAuth(()=>new Promise(done=>resolve=done));f.session.connect();f.sockets[0].close();await flush();f.session.retry();f.sockets[1].open();resolve("auth-required");await flush();assert.equal(f.session.getState().connected,true);assert.equal(f.session.getState().authRequired,false);f.session.dispose();
});
test("background timer throttling does not expire a healthy resumed socket",async()=>{
 const f=fixture();f.session.connect();const socket=f.sockets[0];socket.open();await f.clock.advance(20);f.setVisible(false);f.session.visibilityChanged();await f.clock.advance(40);assert.equal(socket.closed,false);f.setVisible(true);f.session.visibilityChanged();socket.message({type:"webui-pong",nonce:socket.sent.at(-1).nonce});assert.equal(f.session.getState().connected,true);f.session.dispose();
});
