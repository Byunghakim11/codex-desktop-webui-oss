const texts={
 en:{tools:"Codex tools",plan:"Plan mode",mcp:"MCP servers",memory:"Conversation memory",skills:"Skills",plugins:"Plugins",apps:"Apps and connectors",compact:"Compact history",review:"Review changes",status:"Conversation status",close:"Close",load:"Loading…",apply:"Review action",confirm:"Confirm action",accepted:"Accepted by Codex. Refresh to read the latest native state.",unknown:"Result unknown. Check Codex before repeating.",warning:"This changes the selected conversation in the existing Codex engine. Wait for its current work to finish before continuing.",enabled:"Enable memory",disabled:"Disable memory",branch:"Base branch",commit:"Commit SHA",target:"Review target",uncommittedChanges:"Uncommitted changes",baseBranch:"Base branch",mode:"Mode for subsequent turns",refresh:"Refresh",readOnly:"Catalog only. Installations and account sign-ins remain in Codex.",empty:"No entries returned by Codex.",draft:"Keep these inputs open until you have finished reviewing the action."},
 ko:{tools:"Codex 도구",plan:"계획 모드",mcp:"MCP 서버",memory:"대화 메모리",skills:"스킬",plugins:"플러그인",apps:"앱과 커넥터",compact:"대화 기록 압축",review:"코드 변경 검토",status:"대화 상태",close:"닫기",load:"불러오는 중…",apply:"작업 검토",confirm:"작업 확인",accepted:"Codex가 요청을 수락했습니다. 새로고침하여 최신 상태를 확인하세요.",unknown:"결과가 불확실합니다. 반복하기 전에 Codex 앱에서 확인하세요.",warning:"기존 Codex 엔진에서 선택한 대화를 변경합니다. 이 대화의 현재 작업이 끝난 뒤 진행하세요.",enabled:"메모리 활성화",disabled:"메모리 비활성화",branch:"기준 브랜치",commit:"커밋 SHA",target:"검토 대상",uncommittedChanges:"커밋하지 않은 변경",baseBranch:"기준 브랜치",mode:"다음 요청에 적용할 모드",refresh:"새로고침",readOnly:"목록 조회 기능입니다. 설치와 계정 로그인은 Codex에서 진행하세요.",empty:"Codex가 반환한 항목이 없습니다.",draft:"작업 검토를 마칠 때까지 이 입력 화면을 유지하세요."}
};
export function createNativeUtilityControls({document,host,transport,getContext,t,registerMessages,onFeedback}){
 registerMessages?.(Object.fromEntries(Object.entries(texts).map(([locale,values])=>[locale,Object.fromEntries(Object.entries(values).map(([key,value])=>[`nativeUtility.${key}`,value]))])));
 const label=key=>{const value=t?.(`nativeUtility.${key}`);return value&&value!==`nativeUtility.${key}`?value:texts.en[key]||key;};
 const readAction={plan:"plan.describe",mcp:"tools.mcp",memory:"memory.read",skills:"tools.skills",plugins:"tools.plugins",apps:"tools.apps",status:"thread.status"};
 const element=(tag,text,cls="")=>{const node=document.createElement(tag);node.className=cls;if(text!==undefined)node.textContent=text;return node;};
 let dialog=null,generation=0,busy=false,relabel=null;const uncertain=new Set();
 function close(){generation++;dialog?.close?.();dialog?.remove();dialog=null;relabel=null;}
 async function open(kind="tools"){
  if(busy)return;const context={...getContext()};if(!context.threadId||!context.connected)return;
  close();const gen=generation;
  const valid=()=>gen===generation&&getContext().threadId===context.threadId&&getContext().token===context.token&&getContext().cwd===context.cwd&&getContext().connected;
  dialog=element("dialog",undefined,"wf-dialog native-utility-dialog");const title=element("h2",label(kind)),body=element("div",undefined,"native-utility-body"),status=element("p",undefined,"native-utility-status"),actions=element("div",undefined,"wf-dialog-actions"),closeButton=element("button",label("close"));closeButton.type="button";closeButton.addEventListener("click",()=>{if(!busy)close();});actions.append(closeButton);dialog.append(title,body,status,actions);host.append(dialog);dialog.showModal?.();dialog.addEventListener("cancel",event=>{if(busy)event.preventDefault();});
  relabel=()=>{title.textContent=label(kind);closeButton.textContent=label("close");};
  const button=(key,handler)=>{const node=element("button",label(key));node.type="button";node.dataset.utilityAction=key;node.addEventListener("click",handler);actions.append(node);return node;};
  if(kind==="tools"){for(const name of ["plan","mcp","memory","skills","plugins","apps","compact","review","status"]){const node=element("button",label(name),"secondary-action");node.type="button";node.dataset.utilityOpen=name;node.addEventListener("click",()=>void open(name));body.append(node);}return;}
  let result=null;
  if(readAction[kind]){
   status.textContent=label("load");try{result=await transport.execute({action:readAction[kind],threadId:context.threadId,params:{}});if(!valid())return;status.textContent="";}catch(error){if(valid())status.textContent=error.code||label("unknown");return;}
  }
  if(["mcp","skills","plugins","apps","status","memory"].includes(kind)){
   const pre=element("pre",undefined,"native-utility-result");pre.textContent=kind==="memory"?(result.summary||label("empty")):JSON.stringify(result.entries||result,null,2);body.append(pre);
   if(["mcp","skills","plugins","apps"].includes(kind))body.append(element("p",label("readOnly")));
  }
  let select,input,mode;
  if(kind==="plan"){
   body.append(element("p",label("mode")));mode=element("select");mode.className="field-input";mode.setAttribute("aria-label",label("mode"));for(const entry of result.modes||[]){const option=element("option",entry.name||entry.mode);option.value=entry.mode;mode.append(option);}body.append(mode);
  }
  if(kind==="review"){
   select=element("select");select.setAttribute("aria-label",label("target"));for(const value of ["uncommittedChanges","baseBranch","commit"]){const option=element("option",label(value));option.value=value;select.append(option);}input=element("input");input.className="field-input";input.setAttribute("aria-label",`${label("branch")} / ${label("commit")}`);body.append(select,input);
  }
  async function mutate(action,params){
   const key=`${context.token||""}|${context.threadId}|${action}`;if(busy||!valid()||uncertain.has(key))return;
   busy=true;let prepared=false;const nodes=[...actions.querySelectorAll("button")];nodes.forEach(node=>node.disabled=true);
   try{
    const receipt=await transport.prepareConfirmation({action,threadId:context.threadId,params});if(!valid())return;
    prepared=true;for(const node of [input,select,mode])if(node)node.disabled=true;
    const details=action==="plan.set"?`${label("plan")}: ${params.mode}\n${params.expectedModel} · ${params.expectedEffort||"default"}`:action==="review.start"?`${label("review")}: ${label(params.target)}\n${params.branch||params.sha||""}`:action==="thread.compact"?label("compact"):label(action==="memory.enable"?"enabled":"disabled");
    status.textContent=label("warning")+"\n\n"+details;const confirm=element("button",label("confirm"));confirm.type="button";confirm.dataset.utilityAction="confirm";actions.append(confirm);
    confirm.addEventListener("click",async()=>{
     if(busy||!valid())return;busy=true;confirm.disabled=true;uncertain.add(key);
     try{const response=await transport.execute({action,threadId:context.threadId,params,confirmationId:receipt.confirmationId});if(response.ok===true)uncertain.delete(key);if(valid())status.textContent=response.ok===true?label("accepted"):label("unknown");}
     catch(error){if(valid())status.textContent=error.code||label("unknown");}
     finally{busy=false;if(valid())closeButton.disabled=false;}
    },{once:true});
   }catch(error){if(valid())status.textContent=error.code||label("unknown");}
   finally{busy=false;if(valid()){closeButton.disabled=false;if(!prepared)nodes.forEach(node=>node.disabled=false);}}
  }
  if(kind==="memory"){button("enabled",()=>void mutate("memory.enable",{}));button("disabled",()=>void mutate("memory.disable",{}));}
  if(kind==="plan"){const apply=button("apply",()=>void mutate("plan.set",{mode:mode.value,expectedModel:result.model,expectedEffort:result.effort}));apply.disabled=!result.model||!result.modes?.length;}
  if(kind==="compact")button("apply",()=>void mutate("thread.compact",{}));
  if(kind==="review")button("apply",()=>void mutate("review.start",{target:select.value,...(select.value==="baseBranch"?{branch:input.value}:{}),...(select.value==="commit"?{sha:input.value}:{})}));
  if(readAction[kind])button("refresh",()=>void open(kind));
 }
 return {open,contextChanged:close,refreshLabels:()=>relabel?.(),dispose:close};
}
