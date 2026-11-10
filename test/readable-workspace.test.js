import test from "node:test";
import assert from "node:assert/strict";
import { asyncQuestions, questionReply, parseQuestionReply, groupTimeline } from "../public/readable-timeline.js";
import { safeCompanionUrl, companionShortcut } from "../public/companion-apps.js";
import { mergeRecentMessages } from "../public/thread-sync.js";
import { createAsyncQuestionCards } from "../public/async-question-cards.js";
import { sendQuestionAnswer } from "../public/question-transport.js";

const item = { id: "call_example", delivery: "async", questions: [{title:"Continue?",options:["Yes","No"]},{title:"Name?"}] };
test("native async metadata is bounded and does not infer questions from markdown",()=>{
  assert.equal(asyncQuestions(item).length,2);
  assert.deepEqual(asyncQuestions({...item,questions:[{title:"Free text?",options:null}]}),[{title:"Free text?",options:[]}]);
  assert.equal(asyncQuestions({...item,delivery:undefined}),null);
  assert.equal(asyncQuestions({...item,questions:[{title:"",options:["Yes"]}]}),null);
  assert.equal(asyncQuestions({...item,questions:[{title:"x",options:[{}]}]}),null);
});
test("question replies round trip the observed host contract and reject forged wrappers",()=>{
  const value=questionReply(item,["Yes","Alex"]);
  const parsed=parseQuestionReply(value);
  assert.equal(parsed[0].questionItemId,JSON.stringify(["request_user_input_async","call_example",0]));
  assert.equal(parsed[1].answer,"Alex");
  assert.equal(parseQuestionReply("quoted: "+value),null);
  assert.equal(parseQuestionReply(value.replace("request_user_input_async","another_tool")),null);
  assert.throws(()=>questionReply(item,["Yes",""]));
});
test("compact activity spans reasoning and commands but never questions or final answers",()=>{
  const messages=[{role:"user",id:"u"},{role:"system",kind:"reasoning",id:"r"},{role:"tool",id:"t"},{role:"assistant",phase:"commentary",id:"c"},{role:"assistant",questions:[{title:"Q"}],id:"q"},{role:"assistant",phase:"final_answer",id:"f"}];
  const groups=groupTimeline(messages);
  assert.deepEqual(groups.map(x=>x.type),["message","activity","message","message"]);
  assert.equal(groups[1].messages.length,3);
  assert.equal(groupTimeline(messages,false).filter(x=>x.type==="activity").length,0);
});
test("companion URLs never accept credentials, tokens, scripts or insecure origins",()=>{
  assert.equal(safeCompanionUrl("https://example.com/hermes","hermes"),"https://example.com/hermes");
  for(const url of ["javascript:alert(1)","https://u:p@example.com","https://example.com/?token=secret","http://example.com","https://example.com/#secret"])assert.equal(safeCompanionUrl(url,"hermes"),null);
  assert.equal(safeCompanionUrl("https://example.com/mirror","mirror"),"https://example.com/mirror");
});
test("app shortcuts respect editors, IME and browser modifier combinations",()=>{
  assert.equal(companionShortcut({altKey:true,key:"2"}),"mirror");
  assert.equal(companionShortcut({altKey:true,key:"3"}),"hermes");
  assert.equal(companionShortcut({altKey:true,key:"4"}),null);
  for(const event of [{altKey:true,key:"2",ctrlKey:true},{altKey:true,key:"2",isComposing:true},{altKey:true,key:"2",editing:true},{key:"2"}])assert.equal(companionShortcut(event),null);
});

test("metadata-only question and phase recovery causes a render",()=>{
  const previous=[{id:"q",role:"assistant",text:"Q"}];
  for(const extra of [{questions:[{title:"Q"}],delivery:"async"},{phase:"commentary"},{questionReplies:[{answer:"x"}]}])assert.equal(mergeRecentMessages(previous,[{...previous[0],...extra}]).changed,true);
});

function cardDocument(){const nodes=[];const doc={createElement(tag){const node={tag,children:[],listeners:{},attrs:{},dataset:{},isConnected:true,append(...items){this.children.push(...items);},setAttribute(k,v){this.attrs[k]=v;},addEventListener(k,v){this.listeners[k]=v;}};nodes.push(node);return node;}};return {doc,nodes};}
test("question cards preserve source instructions and update after reconnection",()=>{
  const {doc,nodes}=cardDocument();let connected=false;
  const cards=createAsyncQuestionCards({document:doc,t:k=>k,getScope:()=>({threadId:"T",connected,ready:true}),send:async()=>{}});
  cards.render({...item,role:"assistant",questions:asyncQuestions(item),text:"Important condition"},[]);
  assert.ok(nodes.some(n=>n.textContent==="Important condition"));
  const submit=nodes.find(n=>n.type==="submit");assert.equal(submit.disabled,true);
  connected=true;cards.refresh();assert.equal(submit.disabled,false);
  connected=false;cards.refresh();assert.equal(submit.disabled,true);
});
test("question transport serializes with composer and records the new active turn",async()=>{
  const state={currentThread:{id:"T"},connected:true,desktopBridgeConnected:true,activeTurns:new Map(),sendingThreadId:null};
  let finish;const promise=new Promise(resolve=>{finish=resolve;});let calls=0;
  const services={state,rpc:async(method)=>{calls++;assert.equal(method,"turn/start");return promise;},onStateChange(){},onSynced(){}};
  const first=sendQuestionAnswer(services,{threadId:"T",text:"answer"});
  assert.equal(state.sendingThreadId,"T");
  await assert.rejects(sendQuestionAnswer(services,{threadId:"T",text:"second"}));assert.equal(calls,1);
  finish({turn:{id:"new-turn"}});await first;
  assert.equal(state.activeTurns.get("T"),"new-turn");assert.equal(state.sendingThreadId,null);
});
