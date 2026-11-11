// One owner for passive native reconnection and profile reads. Never sends turns,
// answers, file writes or other user mutations.
export function createNativeRecovery({getContext,probe,restore,onRecovered=()=>{},onState=()=>{},onError=()=>{},setTimer=(fn,ms)=>setTimeout(fn,ms),clearTimer=id=>clearTimeout(id),baseDelayMs=1000,maxDelayMs=15000,maxAttempts=5}={}){
 let timer=null,task=null,attempts=0,lastKey=null,disposed=false;
 const context=()=>getContext();
 const canRun=c=>c.browserConnected&&c.visible!==false&&c.canRecover!==false;
 const needed=c=>!c.nativeConnected||c.needsSettings;
 const getState=()=>({running:Boolean(task),scheduled:timer!==null,attempts,exhausted:attempts>=maxAttempts});
 const emit=()=>onState(getState());
 function clear(){if(timer!==null){clearTimer(timer);timer=null;}}
 function request({immediate=false}={}){
  if(disposed)return;
  const c=context();
  if(lastKey!==c.key){lastKey=c.key;attempts=0;clear();}
  if(!canRun(c)){clear();emit();return;}
  if(!needed(c)){clear();attempts=0;emit();return;}
  if(task||attempts>=maxAttempts)return;
  if(timer!==null){if(!immediate)return;clear();}
  const delay=immediate?0:Math.min(maxDelayMs,baseDelayMs*2**attempts);
  timer=setTimer(()=>{timer=null;void run();},delay);emit();
 }
 async function run(){
  if(disposed||task)return;
  const initial=context();if(!canRun(initial)||!needed(initial))return;
  const current={key:initial.key};task=current;emit();
  let completed=false;
  try{
   if(!initial.nativeConnected)await probe();
   let c=context();if(disposed||c.key!==current.key||!canRun(c)||!c.nativeConnected)return;
   if(c.needsSettings)await restore();
   c=context();
   if(!disposed&&c.key===current.key&&canRun(c)&&!needed(c)){attempts=0;completed=true;onRecovered();}
  }catch(error){if(!disposed&&context().key===current.key)onError(error);}
  finally{
   if(task===current)task=null;
   if(!disposed){const c=context();if(!completed&&c.key===current.key&&needed(c))attempts++;emit();request();}
  }
 }
 function retry(){if(disposed)return;attempts=0;clear();request({immediate:true});}
 function dispose(){disposed=true;clear();}
 return {request,retry,dispose,getState};
}
