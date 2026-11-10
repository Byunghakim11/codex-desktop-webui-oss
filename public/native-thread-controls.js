const messages = {
 en: { pin:"Pin in Codex",unpin:"Unpin in Codex",read:"Mark read",unread:"Mark unread",archive:"Archive",unarchive:"Unarchive",fork:"Fork conversation",project:"Move to project",share:"Share snapshot",delete:"Delete permanently",cancel:"Cancel",continue:"Review",confirm:"Confirm",pending:"Pending approval in Codex. This action is not complete.",unknown:"Result unknown. Check Codex before repeating this action.",done:"Applied in Codex",review:"I reviewed the entire conversation for private data.",shareWarning:"Creates an external, immutable snapshot of the conversation history. Later edits are not reflected.",deleteWarning:"Permanently deletes this conversation and its child conversations. Enter its name or ID.",forkWarning:"Copies the history into a new conversation in the same directory. No follow-up work is started.",archiveWarning:"Archive this conversation in Codex?",projectWarning:"Changes project membership. Execution host and working directory remain controlled by Codex.",remove:"No project",open:"Open conversation",copy:"Copy link" },
 ko: { pin:"Codex에서 고정",unpin:"Codex 고정 해제",read:"읽음으로 표시",unread:"읽지 않음으로 표시",archive:"보관",unarchive:"보관 해제",fork:"대화 분기",project:"프로젝트로 이동",share:"대화 스냅샷 공유",delete:"영구 삭제",cancel:"취소",continue:"내용 검토",confirm:"확인",pending:"Codex 앱의 승인을 기다립니다. 아직 완료되지 않았습니다.",unknown:"결과가 불확실합니다. 반복하기 전에 Codex 앱에서 확인하세요.",done:"Codex에 적용했습니다",review:"대화 전체에 개인정보가 없는지 검토했습니다.",shareWarning:"대화 기록의 외부 공유 스냅샷을 만듭니다. 이후 수정은 공유본에 반영되지 않습니다.",deleteWarning:"이 대화와 하위 대화를 영구 삭제합니다. 대화 이름 또는 ID를 입력하세요.",forkWarning:"기록을 같은 작업 폴더의 새 대화로 복사합니다. 후속 작업은 시작하지 않습니다.",archiveWarning:"이 대화를 Codex에서 보관할까요?",projectWarning:"프로젝트 소속을 변경합니다. 실행 호스트와 작업 폴더는 Codex에서 관리합니다.",remove:"프로젝트 없음",open:"대화 열기",copy:"링크 복사" }
};
export function createNativeThreadControls({document,host,transport,getContext,t,registerMessages,onFeedback,onChanged,onOpenThread}) {
 const bundle=Object.fromEntries(Object.entries(messages).map(([locale,values])=>[locale,Object.fromEntries(Object.entries(values).map(([key,value])=>[`nativeThread.${key}`,value]))]));
 registerMessages?.(bundle);
 const label=key=>{const value=t?.(`nativeThread.${key}`);return value&&value!==`nativeThread.${key}`?value:messages.en[key]||key;};
 const blocked=new Set(); let dialog=null, generation=0, busy=false, relabel=null;
 const node=(tag,cls,text)=>{const el=document.createElement(tag);el.className=cls;if(text!==undefined)el.textContent=text;return el;};
 const feedback=text=>onFeedback?.({label:text});
 function close(){generation++;dialog?.close?.();dialog?.remove();dialog=null;relabel=null;}
 function contextChanged(){close();}
 function items(thread){
  const id=thread?.id;if(!id)return [];
  const entries=["pin","unpin","read","unread","archive","unarchive","fork","project","share","delete"];
  return entries.map(key=>({id:`native-${key}`,label:label(key),disabled:()=>!getContext().connected||busy||blocked.has(`${getContext().token||""}|${id}|${key}`),run:()=>open(thread,key)}));
 }
 async function open(thread,key){
  if(!getContext().connected||busy)return;
  const blockKey=`${getContext().token||""}|${thread.id}|${key}`;
  if(blocked.has(blockKey)){feedback(label("unknown"));return;}
  close();const gen=generation, threadId=thread.id, initial={...getContext()};
  const valid=()=>gen===generation&&getContext().connected&&getContext().token===initial.token&&getContext().cwd===initial.cwd&&getContext().threadId===initial.threadId;
  const action=key==="project"?"thread.project.move":`thread.${key}`;
  if(["pin","unpin","read","unread","unarchive"].includes(key)){
   busy=true;try{const result=await transport.execute({action,threadId,params:{}});if(valid()){feedback(result.ok===true?label("done"):label("pending"));if(result.ok===true)await onChanged?.(result);}}catch(error){if(valid())feedback(error.code||label("unknown"));}finally{busy=false;}return;
  }
  dialog=node("dialog","wf-dialog native-thread-dialog");
  const heading=node("h2","",label(key)), target=node("p","",thread.name||thread.preview||threadId);
  const notice=node("p","",label(`${key}Warning`));
  const status=node("p","native-thread-status");status.setAttribute("role","status");
  const controls=node("div","native-thread-form");
  const actions=node("div","wf-dialog-actions");
  const accept=node("button","",label("continue")),cancel=node("button","",label("cancel"));accept.type=cancel.type="button";
  actions.append(accept,cancel);dialog.append(heading,target,notice,controls,status,actions);host.append(dialog);dialog.showModal?.();
  cancel.addEventListener("click",()=>{if(!busy)close();});
  dialog.addEventListener("cancel",event=>{if(busy)event.preventDefault();});
  let checkbox,input,select,receipt=null,params={},requestId=null,reviewed=false;
  if(key==="share") {const field=node("label","native-thread-review");checkbox=node("input","");checkbox.type="checkbox";const text=node("span","",label("review"));field.append(checkbox,text);controls.append(field);}
  if(key==="delete") {input=node("input","field-input");input.type="text";input.maxLength=512;input.setAttribute("aria-label",label("deleteWarning"));controls.append(input);}
  if(key==="project"){
   select=node("select","field-input");select.setAttribute("aria-label",label("project"));select.disabled=true;accept.disabled=true;controls.append(select);
   try{const result=await transport.execute({action:"thread.project.list",threadId,params:{}});if(!valid())return;
    const option=node("option","",label("remove"));option.value="";select.append(option);
    for(const project of result.projects||[]){if(typeof project.id!=="string")continue;const option=node("option","",project.name||project.id);option.value=project.id;select.append(option);} select.disabled=false;accept.disabled=false;
   }catch(error){if(valid())status.textContent=error.code||label("unknown");}
  }
  relabel=()=>{heading.textContent=label(key);notice.textContent=label(`${key}Warning`);accept.textContent=label(reviewed?"confirm":"continue");cancel.textContent=label("cancel");};
  accept.addEventListener("click",async()=>{
   if(busy||!valid())return;
   busy=true;accept.disabled=true;cancel.disabled=true;
   try {
    if(!reviewed){
     if(key==="share"&&!checkbox.checked)return;
     if(key==="delete"&&input.value!==threadId&&input.value!==thread.name){status.textContent=label("deleteWarning");return;}
     params=key==="share"?{reviewed:true}:key==="delete"?{confirmationText:input.value}:key==="project"?{projectId:select.value||null}:{};
     if(["share","delete"].includes(key))receipt=await transport.prepareConfirmation({action,threadId,params});
     if(!valid())return;
     reviewed=true; if(input)input.disabled=true;if(checkbox)checkbox.disabled=true;if(select)select.disabled=true;
     accept.textContent=label("confirm");return;
    }
    if(["fork","share","delete"].includes(key))requestId??=newRequestId();
    if(requestId)blocked.add(blockKey);
    const result=await transport.execute({action,threadId,params,...(requestId?{requestId}:{}),...(receipt?{confirmationId:receipt.confirmationId}:{})});
    if(result?.ok===true)blocked.delete(blockKey);
    if(!valid())return;
    if(result.ok!==true){blocked.add(blockKey);status.textContent=label(result.status==="pending"?"pending":"unknown");return;}
    status.textContent=label("done");accept.disabled=true;accept.hidden=true;
    await onChanged?.(result);
    if(result.childThreadId){const button=node("button","",label("open"));button.type="button";button.addEventListener("click",()=>{close();void onOpenThread?.(result.childThreadId);});actions.append(button);}
    if(result.shareUrl){const url=new URL(result.shareUrl);if(url.protocol==="https:"&&["chatgpt.com","www.chatgpt.com"].includes(url.hostname)){const link=node("a","",result.shareUrl);link.href=url.href;link.target="_blank";link.rel="noopener noreferrer";controls.append(link);}}
   }catch(error){if(valid()){status.textContent=error.code||label("unknown");if(requestId)blocked.add(blockKey);}}
   finally{busy=false;if(dialog&&valid()){accept.disabled=blocked.has(blockKey);cancel.disabled=false;}}
  });
 }
 return {items,contextChanged,refreshLabels:()=>relabel?.(),dispose:close};
}

function newRequestId(){
 if(typeof globalThis.crypto?.randomUUID==="function")return globalThis.crypto.randomUUID();
 const bytes=new Uint8Array(16);
 if(typeof globalThis.crypto?.getRandomValues!=="function")throw Object.assign(new Error("SECURE_RANDOM_REQUIRED"),{code:"SECURE_RANDOM_REQUIRED"});
 globalThis.crypto.getRandomValues(bytes);bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
 const hex=Array.from(bytes,byte=>byte.toString(16).padStart(2,"0")).join("");
 return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
