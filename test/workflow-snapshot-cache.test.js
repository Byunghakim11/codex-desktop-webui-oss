import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { actualAppFunction } from "../test-support/workflow-app-harness.js";
import { createConversationSnapshotCache } from "../public/workflow-tools.js";
import { buildConversationSnapshot } from "../public/conversation-tools.js";

function appCache(){
  const state={currentThread:{id:"A",name:"Title A"},threadLoadSeq:1,connected:true,desktopBridgeConnected:true,activeTurns:new Map(),messages:[{id:"a",role:"assistant",phase:"final_answer",turnId:"turn",text:"first"}]};
  const seen=[],noop=()=>{},bubble={},article={dataset:{messageId:"a"},querySelector:()=>bubble,classList:{toggle:noop}},messages={scrollTop:0,querySelectorAll:()=>[article],append:noop};
  let builds=0;
  const node=()=>({append:noop});
  const context=vm.createContext({state,workflowRevision:0,workflowDraftSerial:0,t:key=>key,
    els:{messages},attachmentDownloadViews:new Set(),document:{activeElement:null,createElement:node},groupTimeline:items=>items.map(message=>({type:"message",message})),
    renderMessage:()=>{seen.push(context.workflowSnapshot());return node();},renderHistoryLoader:()=>null,renderReplyProgressFooter:()=>null,renderLastMessageTime:()=>null,
    updateTrafficSummary:noop,scrollMessagesToBottom:noop,renderMarkdown:x=>x,bindImagePlaceholders:noop,bindMarkdownImages:noop,
    conversationTools:{update(){context.workflowSnapshot();},decorateMessage(){seen.push(context.workflowSnapshot());}},
  });
  vm.runInContext(["workflowInput","workflowSnapshot","invalidateWorkflow","renderMessages","patchStreamingMessage"].map(actualAppFunction).join("\n"),context);
  context.workflowSnapshotCache=createConversationSnapshotCache({getInput:()=>context.workflowInput(),build:input=>{builds++;return buildConversationSnapshot(input);}});
  return {state,context,seen,get builds(){return builds;}};
}
test("actual render and streaming patch invalidate before decoration, not once per article",()=>{
  const f=appCache();f.context.workflowSnapshot();assert.equal(f.builds,1);
  f.state.messages[0].text="updated";f.context.renderMessages(false);assert.equal(f.builds,2);assert.equal(f.seen.at(-1).messages[0].text,"updated");
  f.state.messages[0].phase="commentary";f.context.patchStreamingMessage(f.state.messages[0],false);assert.equal(f.builds,3);assert.equal(f.seen.at(-1).loadedMessageCount,0);
  f.state.messages[0].phase="final_answer";f.state.messages[0].delivery="async";f.context.renderMessages(false);assert.equal(f.seen.at(-1).loadedMessageCount,0);
  f.state.messages[0].delivery=undefined;f.state.messages[0].text="new final";f.context.patchStreamingMessage(f.state.messages[0],false);assert.equal(f.seen.at(-1).messages[0].text,"new final");
  f.state.messages[0].classificationPending=true;f.context.renderMessages(false);assert.equal(f.seen.at(-1).loadedMessageCount,0);
});
test("actual snapshot keys invalidate on active-turn, load, thread, title and connection scope",()=>{
  const f=appCache();let previous=f.context.workflowSnapshot();assert.equal(f.context.workflowSnapshot(),previous);
  for(const mutate of [()=>f.state.activeTurns.set("A","turn"),()=>f.state.activeTurns.delete("A"),()=>f.state.threadLoadSeq++,()=>{f.state.currentThread.name="Title B";},()=>{f.state.connected=false;},()=>{f.state.desktopBridgeConnected=false;},()=>{f.state.currentThread={id:"B",name:"B"};},()=>{f.state.messages=[...f.state.messages];}]){
    mutate();const next=f.context.workflowSnapshot();assert.notEqual(next,previous);previous=next;
  }
  const before=f.builds;f.context.workflowSnapshot();assert.equal(f.builds,before);
  f.context.invalidateWorkflow();assert.notEqual(f.context.workflowSnapshot(),previous);assert.equal(f.builds,before+1);
});
