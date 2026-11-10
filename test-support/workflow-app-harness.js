import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { asyncQuestions } from "../public/readable-timeline.js";
import { buildConversationSnapshot } from "../public/conversation-tools.js";
import * as sync from "../public/thread-sync.js";
const source=fs.readFileSync(new URL("../public/app.js",import.meta.url),"utf8");
export function actualAppFunction(name){const start=source.indexOf(`function ${name}(`);assert.ok(start>=0,name);const end=source.indexOf("\n}",start)+2;return source.slice(start,end);}
// Actual notification/normalization code; no boot, network, permissions or DOM.
export function liveHarness(){
  const state={currentThread:{id:"A"},messages:[],lastThreadPushAt:new Map(),turnDiagnostics:new Map(),activeTurns:new Map()};
  const noop=()=>{};
  const context=vm.createContext({state,asyncQuestions,...sync,performance,Date,t:key=>key,
    BACKGROUND_CACHE_NOTIFICATION_METHODS:new Set(),markRetryRecovered:noop,shouldStickToLiveOutput:()=>false,
    logTurnDebug:noop,currentUnixSeconds:()=>1,streamingRenderBatcher:{schedule:noop,cancel:noop},
    renderMessages:noop,scheduleCurrentThreadSync:noop,ensureReplyProgressIndicator:noop,
    updateSendMode:noop,setThreadActivity:noop,notifyTurnCompletion:noop,stopReplyProgress:noop,
    loadThreads:noop,shouldAdvanceQueueAfterTurn:()=>false,formatStatus:x=>typeof x==="string"?x:"completed",
    turnTimestamp:()=>1,formatStatusLabel:x=>x,els:{threadMeta:{}},invalidateWorkflow:noop,
    itemTimestamp:()=>1,parseAutomationHeartbeat:()=>null,parseAutomationHeartbeatResult:()=>null,parseQuestionReply:()=>null,
  });
  vm.runInContext(["cleanAssistantText","messageFromItem","replaceOrAppendMessage","takePendingReplyMessage","removePendingReplyMessages","clearStreamingReply","clearStreamingReplies","handleNotification"].map(actualAppFunction).join("\n"),context);
  return {state,send(method,params){context.handleNotification({method,params:{threadId:"A",turnId:"turn",...params}});},snapshot(){return buildConversationSnapshot({threadKey:state.currentThread.id,revision:1,messages:state.messages});}};
}
