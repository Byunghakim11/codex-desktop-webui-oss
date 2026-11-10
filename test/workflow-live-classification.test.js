import test from "node:test";
import assert from "node:assert/strict";
import { prepareConversationText } from "../public/conversation-tools.js";
import * as sync from "../public/thread-sync.js";
import { liveHarness } from "../test-support/workflow-app-harness.js";

test("actual started -> delta keeps native classification and only trusted final gets derived surfaces",()=>{
  for(const metadata of [{phase:"commentary"},{delivery:"async",questions:[{title:"NATIVE_SENTINEL",options:[]}]},{phase:"unknown"},{},{phase:"final_answer"}]){
    const h=liveHarness();h.send("item/started",{item:{type:"agentMessage",id:"item",text:"",...metadata}});
    h.send("item/agentMessage/delta",{itemId:"item",delta:"LIVE_SENTINEL\n```js\ncode\n```"});
    assert.equal(h.state.messages[0].phase,metadata.phase);
    assert.equal(h.state.messages[0].delivery,metadata.delivery);
    if(metadata.questions)assert.equal(h.state.messages[0].questions.length,1);
    const eligible=metadata.phase==="final_answer"?1:0;assert.equal(h.snapshot().loadedMessageCount,eligible);
    assert.equal(prepareConversationText(h.snapshot(),{purpose:"message-copy",messageKey:"item"}).includedMessageCount,eligible);
    assert.equal(prepareConversationText(h.snapshot(),{purpose:"markdown-export"}).includedMessageCount,0);
    h.send("item/completed",{item:{type:"agentMessage",id:"item",text:h.state.messages[0].text}});
    assert.equal(h.state.messages[0].phase,metadata.phase);assert.equal(h.state.messages[0].delivery,metadata.delivery);
    assert.equal(h.snapshot().loadedMessageCount,eligible);
    assert.equal(prepareConversationText(h.snapshot(),{purpose:"markdown-export"}).includedMessageCount,eligible);
  }
});
test("delta before start stays excluded through terminal and sync until explicit final classification",()=>{
  const h=liveHarness();h.send("item/agentMessage/delta",{itemId:"item",delta:"unknown live"});assert.equal(h.snapshot().loadedMessageCount,0);
  h.send("turn/completed",{turn:{id:"turn",status:"completed"}});assert.equal(h.snapshot().loadedMessageCount,0);
  const incoming=h.state.messages.map(m=>({...m,id:"stable",phase:undefined,classificationPending:undefined,streamingReply:false}));
  h.state.messages=sync.mergeRecentMessages(h.state.messages,incoming,{preserveLiveState:false}).messages;assert.equal(h.snapshot().loadedMessageCount,0);
  h.send("item/completed",{item:{type:"agentMessage",id:"stable",text:"unknown live"}});assert.equal(h.snapshot().loadedMessageCount,0);
  h.send("item/completed",{item:{type:"agentMessage",id:"stable",phase:"final_answer",text:"known final"}});assert.equal(h.snapshot().loadedMessageCount,1);
  h.state.currentThread={id:"B"};h.state.messages=[];h.send("item/agentMessage/delta",{threadId:"A",itemId:"old",delta:"late"});assert.equal(h.state.messages.length,0);
});
test("late started classification preserves arrived delta; completion and alias sync keep native exclusions",()=>{
  const h=liveHarness();h.send("item/agentMessage/delta",{itemId:"temporary",delta:"native body"});
  h.send("item/started",{item:{type:"agentMessage",id:"temporary",phase:"commentary",text:""}});assert.equal(h.state.messages[0].text,"native body");assert.equal(h.snapshot().loadedMessageCount,0);
  h.send("item/completed",{item:{type:"agentMessage",id:"temporary",text:"native body"}});assert.equal(h.state.messages[0].phase,"commentary");
  h.state.messages=sync.mergeRecentMessages(h.state.messages,[{role:"assistant",id:"stable",turnId:"turn",text:"native body",phase:undefined,delivery:undefined,questions:null}],{preserveLiveState:false}).messages;
  assert.equal(h.state.messages[0].phase,"commentary");assert.equal(h.snapshot().loadedMessageCount,0);
});
