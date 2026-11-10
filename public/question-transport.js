import { buildPromptRequest } from "./follow-up.js";

// Shares the composer lock and native active-turn map; never touches its draft.
export async function sendQuestionAnswer({state,rpc,onStateChange,onSynced},{threadId,text}) {
  if(threadId!==state.currentThread?.id||!state.connected||state.desktopBridgeConnected!==true||state.desktopBridgeReconnecting||state.sendingThreadId||state.interruptingTurnId)throw new Error("Chat is not ready");
  state.sendingThreadId=threadId;onStateChange();
  try{
    const request=buildPromptRequest({threadId,activeTurnId:state.activeTurns.get(threadId),input:[{type:"text",text,text_elements:[]}],clientUserMessageId:crypto.randomUUID(),queue:false});
    const result=await rpc(request.method,request.params);
    const turnId=result?.turn?.id||result?.turnId;if(turnId)state.activeTurns.set(threadId,turnId);
    onSynced(threadId);
  }finally{if(state.sendingThreadId===threadId)state.sendingThreadId=null;onStateChange();}
}
