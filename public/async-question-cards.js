import { questionReply } from "./readable-timeline.js";

// Only submission state is kept in session storage. Answers remain in memory.
export function createAsyncQuestionCards({document:doc=document,t,send,getScope}) {
  const drafts=new Map(),submissions=new Map(),views=new Map();
  const make=(tag,className,text)=>{const node=doc.createElement(tag);node.className=className;if(text!==undefined)node.textContent=text;return node;};
  function storageKey(key){return `codex-question-send:${key}`;}
  function statusFor(key){if(submissions.has(key))return submissions.get(key);try{if(sessionStorage.getItem(storageKey(key)))return "uncertain";}catch{}return "";}
  function setStatus(key,value){submissions.set(key,value);try{if(value)sessionStorage.setItem(storageKey(key),value);else sessionStorage.removeItem(storageKey(key));}catch{}}
  function render(message,allMessages) {
    const scope=getScope(),key=JSON.stringify([scope.threadId,message.id]);
    const answers=new Map(allMessages.flatMap(m=>m.questionReplies||[]).map(reply=>[reply.questionItemId,reply.answer]));
    const done=message.questions.every((_,index)=>answers.has(JSON.stringify(["request_user_input_async",message.id,index])));
    if(done)setStatus(key,"");
    let draft=drafts.get(key);if(!draft){draft=message.questions.map(()=>"");drafts.set(key,draft);}
    const article=make("article","message assistant async-question-card");article.dataset.messageId=message.id;
    const heading=make("strong","question-card-heading",done?t("question.answered"):t("question.request"));
    const description=make("p","question-card-hint",t("question.sameChat"));
    const source=make("details","question-source"),sourceTitle=make("summary","",t("question.source"));
    source.append(sourceTitle,make("p","question-card-hint",message.text||""));
    const form=make("form","question-card-form"),fieldset=make("fieldset","");
    const fields=[];
    message.questions.forEach((question,index)=>{
      const group=make("div","question-card-field"),label=make("label","question-card-title",`${index+1}. ${question.title}`);
      const id=`async-question-${message.id}-${index}`;label.htmlFor=id;group.append(label);
      if(done){group.append(make("p","question-card-answer",answers.get(JSON.stringify(["request_user_input_async",message.id,index]))));fieldset.append(group);return;}
      const options=make("div","question-options");const buttons=[];
      for(const option of question.options||[]){const button=make("button","question-option",option);button.type="button";button.setAttribute("aria-pressed",String(draft[index]===option));button.addEventListener("click",()=>{draft[index]=option;input.value="";for(const other of buttons)other.setAttribute("aria-pressed",String(other===button));});buttons.push(button);options.append(button);}
      const input=make("textarea","question-free-text");input.id=id;input.rows=2;input.maxLength=16000;input.placeholder=t("question.freeText");input.value=question.options?.includes(draft[index])?"":draft[index];input.dataset.asyncField=id;
      input.addEventListener("input",()=>{draft[index]=input.value;for(const button of buttons)button.setAttribute("aria-pressed","false");});fields.push(input);group.append(options,input);fieldset.append(group);
    });
    const status=make("p","question-card-status");status.setAttribute("role","status");
    const submit=make("button","primary-action",t("question.send"));submit.type="submit";
    function refresh(){const value=statusFor(key),current=getScope();fieldset.disabled=done||Boolean(value)||!current.connected||current.ready===false;submit.disabled=fieldset.disabled;submit.hidden=done;status.textContent=value?t(`question.${value}`):done?"":!current.connected?t("question.offline"):current.ready===false?t("question.busy"):"";}
    form.addEventListener("submit",async event=>{
      event.preventDefault();if(done||statusFor(key)||!getScope().connected||getScope().ready===false||getScope().threadId!==scope.threadId)return;
      let text;try{text=questionReply({...message,delivery:"async"},draft);}catch(error){status.textContent=error.message;return;}
      setStatus(key,"submitting");refresh();
      try{await send({threadId:scope.threadId,text});setStatus(key,"sent");}
      catch{setStatus(key,"uncertain");}
      refresh();
    });
    form.append(fieldset,submit,status);article.append(heading,description,source,form);views.set(key,{article,refresh});refresh();return article;
  }
  function renderReply(message){
    const article=make("article","message user question-reply-card");article.dataset.messageId=message.id||"";
    article.append(make("strong","question-card-heading",t("question.response")));
    for(const reply of message.questionReplies){const group=make("div","question-card-field");group.append(make("small","question-card-hint",reply.question),make("p","question-card-answer",reply.answer));article.append(group);}
    return article;
  }
  return {render,renderReply,refresh(){for(const [key,view] of views){if(view.article.isConnected)view.refresh();else views.delete(key);}}};
}
