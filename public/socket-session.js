// Owns one browser transport. Reconnection restores reads; it never replays a
// chat submission, approval, file write or other application mutation.
export function createSocketSession({url,createSocket=value=>new WebSocket(value),onSocket=()=>{},onOpen=()=>{},onMessage=()=>{},onDisconnect=()=>{},onState=()=>{},onError=()=>{},probeAuth=async()=>"unavailable",online=()=>globalThis.navigator?.onLine!==false,visible=()=>!globalThis.document?.hidden,now=()=>Date.now(),setTimer=(fn,ms)=>setTimeout(fn,ms),clearTimer=id=>clearTimeout(id),random=Math.random,connectTimeoutMs=10000,heartbeatMs=20000,pongTimeoutMs=20000,probeTimeoutMs=6500,retryBaseMs=750,retryMaxMs=15000}={}){
 let socket=null,generation=0,disposed=false,blocked=false,attempts=0,openedAt=0,wasOpen=false;
 let retryTimer=null,connectTimer=null,pulseTimer=null,pongTimer=null,awaiting=null,sequence=0,authEpoch=null;
 const invoke=(fn,...args)=>{try{const result=fn(...args);if(result?.catch)result.catch(onError);}catch(error){onError(error);}};
 const clear=name=>{const id=name==="retry"?retryTimer:name==="connect"?connectTimer:name==="pulse"?pulseTimer:pongTimer;if(id!==null)clearTimer(id);if(name==="retry")retryTimer=null;else if(name==="connect")connectTimer=null;else if(name==="pulse")pulseTimer=null;else pongTimer=null;};
 const clearLink=()=>{for(const name of ["connect","pulse","pong"])clear(name);awaiting=null;};
 function schedule(){
  if(disposed||blocked||socket||retryTimer!==null)return;
  if(!online()){invoke(onState,"offline");return;}
  const delay=Math.round(Math.min(retryMaxMs,retryBaseMs*2**Math.min(attempts,6))*(0.8+random()*0.4));
  invoke(onState,"reconnecting");retryTimer=setTimer(()=>{retryTimer=null;connect();},delay);
 }
 async function checkAuth(epoch){
  if(authEpoch===epoch)return;authEpoch=epoch;
  let timer;let result="unavailable";
  try{result=await Promise.race([Promise.resolve().then(probeAuth),new Promise(resolve=>{timer=setTimer(()=>resolve("unavailable"),probeTimeoutMs);})]);}catch{}finally{if(timer!==undefined)clearTimer(timer);if(authEpoch===epoch)authEpoch=null;}
  if(disposed||generation!==epoch||socket)return;
  if(result==="auth-required"){blocked=true;invoke(onState,"auth-required");return;}
  if(result==="valid")blocked=false;
  schedule();
 }
 function retire(target,reason="disconnected",skipProbe=false){
  if(disposed||socket!==target)return;
  const opened=wasOpen;
  if(opened&&now()-openedAt>=30000)attempts=0;else attempts++;
  socket=null;wasOpen=false;generation++;const epoch=generation;clearLink();
  invoke(onSocket,null);invoke(onDisconnect,{reason,opened});
  try{target.close(1000,"Reconnecting");}catch{}
  if(!online()){invoke(onState,"offline");return;}
  invoke(onState,"reconnecting");
  if(skipProbe)schedule();else void checkAuth(epoch);
 }
 function nextPulse(){clear("pulse");if(disposed||!socket||socket.readyState!==1)return;pulseTimer=setTimer(()=>{pulseTimer=null;ping();},heartbeatMs);}
 function ping(){
  const current=socket;if(disposed||!current||current.readyState!==1)return;
  clear("pulse");clear("pong");const nonce=`${generation}-${++sequence}`;awaiting=nonce;const due=now()+pongTimeoutMs;
  try{current.send(JSON.stringify({type:"webui-ping",nonce}));}catch{retire(current,"send-failed");return;}
  pongTimer=setTimer(()=>{
   pongTimer=null;if(socket!==current||awaiting!==nonce)return;
   // Background throttling and suspend/resume must not expire an old deadline
   // before the browser has a chance to handle a fresh response.
   if(!visible()||now()>due+pongTimeoutMs){awaiting=null;nextPulse();return;}
   retire(current,"heartbeat-timeout");
  },pongTimeoutMs);
 }
 function connect(){
  if(disposed||blocked||socket)return;
  clear("retry");if(!online()){invoke(onState,"offline");return;}
  const epoch=++generation;let current;
  try{current=createSocket(typeof url==="function"?url():url);}catch(error){attempts++;invoke(onError,error);schedule();return;}
  socket=current;wasOpen=false;invoke(onSocket,current);invoke(onState,"connecting");
  connectTimer=setTimer(()=>{connectTimer=null;if(socket===current&&generation===epoch&&!wasOpen)retire(current,"connect-timeout");},connectTimeoutMs);
  current.addEventListener("open",()=>{
   if(disposed||socket!==current||generation!==epoch)return;
   clear("connect");wasOpen=true;openedAt=now();invoke(onState,"connected");invoke(onOpen,current);nextPulse();
  });
  current.addEventListener("message",event=>{
   if(disposed||socket!==current||generation!==epoch)return;
   let value;try{value=JSON.parse(event.data);}catch{invoke(onError,new Error("INVALID_SOCKET_MESSAGE"));return;}
   if(value?.type==="webui-pong"){
    if(value.nonce===awaiting){awaiting=null;clear("pong");nextPulse();}return;
   }
   invoke(onMessage,value,typeof event.data==="string"?event.data:"");
  });
  current.addEventListener("close",()=>retire(current,"disconnected"));
  current.addEventListener("error",()=>{
   if(disposed||socket!==current||generation!==epoch)return;
   retire(current,"transport-error");
  });
 }
 function checkLiveness(){
  if(disposed)return;
  if(blocked){void checkAuth(generation);return;}
  if(socket?.readyState===1){ping();return;}
  if(!socket&&!blocked){clear("retry");connect();}
 }
 function onlineChanged(){
  if(disposed)return;
  if(!online()){if(socket)retire(socket,"offline",true);clear("retry");invoke(onState,"offline");return;}
  checkLiveness();
 }
 function visibilityChanged(){
  if(disposed)return;
  if(visible())checkLiveness();else{clear("pong");awaiting=null;nextPulse();}
 }
 function retry(){if(disposed)return;blocked=false;clear("retry");checkLiveness();}
 function dispose(){
  if(disposed)return;disposed=true;generation++;for(const name of ["retry","connect","pulse","pong"])clear(name);
  const previous=socket;socket=null;awaiting=null;try{previous?.close(1000,"Page closed");}catch{}invoke(onSocket,null);
 }
 return {connect,retry,checkLiveness,onlineChanged,visibilityChanged,dispose,getSocket:()=>socket,getState:()=>({connected:Boolean(socket?.readyState===1&&wasOpen),authRequired:blocked,retryScheduled:retryTimer!==null,generation})};
}
