// Read-only, loaded-text tools. Only the active result is marked; DOM size does not
// grow with the number of lines or matches, and raw text remains intact.
export function createTextPreviewTools({container,document:doc=container.ownerDocument,text,truncated=false,firstLine=1,t,features={}}) {
  const raw=String(text??""),knownStart=Number.isSafeInteger(firstLine)&&firstLine>0,base=knownStart?firstLine:1;
  let disposed=false,matches=[],matchIndex=-1;
  const cleanups=[];
  const label=(key,fallback)=>{const value=t?.(`files.${key}`);return !value||value===`files.${key}`?fallback:value;};
  const node=(tag,value)=>{const element=doc.createElement(tag);if(value!==undefined)element.textContent=value;return element;};
  const bind=(target,type,fn)=>{target.addEventListener(type,fn);cleanups.push(()=>target.removeEventListener(type,fn));};
  const named=(tag,name)=>{const element=node(tag);element.setAttribute("aria-label",name);return element;};
  const toolbar=node("div");toolbar.className="file-text-tools";Object.assign(toolbar.style,{display:"flex",flexWrap:"wrap",gap:"6px",alignItems:"center",padding:"8px 16px"});
  const search=named("input",label("bodySearch","본문 검색"));search.type="search";search.placeholder=label("bodySearch","본문 검색");search.style.minWidth="0";search.style.width="10rem";
  const previous=named("button",label("previousMatch","이전 일치")),next=named("button",label("nextMatch","다음 일치"));previous.textContent="↑";next.textContent="↓";previous.type=next.type="button";
  const count=named("span",label("matchCount","검색 결과"));count.setAttribute("role","status");count.setAttribute("aria-live","polite");
  const line=named("input",label("goToLine","줄로 이동"));line.type="text";line.inputMode="numeric";line.placeholder=label("goToLine","줄로 이동");line.style.width="7rem";
  const go=named("button",label("go","이동"));go.type="button";go.textContent=label("go","이동");
  const feedback=node("span");feedback.setAttribute("role","status");
  if(features.F11!==false)toolbar.append(search,previous,count,next);
  if(features.F12!==false)toolbar.append(line,go,feedback);
  const scope=node("small",label(truncated?"loadedTextScope":"loadedText","현재 로드된 부분만 검색")+(knownStart?"":` · ${label("unknownLineOffset","미리보기 기준 줄 · 파일 시작 위치 미확인")}`));scope.className="files-status";
  const starts=[0];for(const match of raw.matchAll(/\r\n|\r|\n/g))starts.push(match.index+match[0].length);
  const viewport=node("div");viewport.className="file-text-viewport";Object.assign(viewport.style,{display:"flex",alignItems:"flex-start",overflow:"auto",maxHeight:"60vh",margin:"8px 16px",border:"1px solid var(--line)",borderRadius:"8px"});
  const gutter=node("pre",starts.map((_,i)=>String(base+i)).join("\n"));gutter.className="file-line-numbers";gutter.setAttribute("aria-hidden","true");
  Object.assign(gutter.style,{userSelect:"none",pointerEvents:"none",margin:"0",padding:"12px 8px",font:"11px/1.7 ui-monospace, Consolas, monospace",whiteSpace:"pre",color:"var(--muted)",borderRight:"1px solid var(--line)"});
  const body=node("pre",raw);body.className="file-text";body.tabIndex=0;body.setAttribute("aria-label",label("loadedBody","읽기 전용 파일 본문"));
  Object.assign(body.style,{margin:"0",padding:"12px",whiteSpace:"pre",overflowWrap:"normal",border:"0",borderRadius:"0",flex:"1",minWidth:"0"});
  if(features.F12!==false)viewport.append(gutter);
  viewport.append(body);container.append(toolbar,scope,viewport);
  function mark(start,length){
    if(disposed)return;
    const highlight=node("mark",raw.slice(start,start+length));highlight.className="file-text-active";
    if(!length)Object.assign(highlight.style,{display:"inline-block",minWidth:"1px",height:"1em"});
    body.replaceChildren(doc.createTextNode(raw.slice(0,start)),highlight,doc.createTextNode(raw.slice(start+length)));
    highlight.scrollIntoView?.({block:"nearest",inline:"nearest"});
  }
  function showMatch(){
    if(disposed)return;count.textContent=`${matches.length?matchIndex+1:0} / ${matches.length}`;previous.disabled=next.disabled=!matches.length;
    if(matches.length)mark(matches[matchIndex],search.value.length);else body.textContent=raw;
  }
  function searchBody(){
    if(disposed)return;matches=[];matchIndex=-1;const query=search.value;
    if(query){let index=raw.indexOf(query);while(index!==-1){matches.push(index);index=raw.indexOf(query,index+Math.max(1,query.length));}if(matches.length)matchIndex=0;}
    showMatch();
  }
  function move(delta){if(disposed||!matches.length)return;matchIndex=(matchIndex+delta+matches.length)%matches.length;showMatch();}
  function jump(){
    if(disposed)return;const value=line.value.trim(),number=/^[1-9]\d*$/.test(value)?Number(value):NaN,index=number-base;
    if(!Number.isSafeInteger(number)||index<0||index>=starts.length){line.setAttribute("aria-invalid","true");feedback.textContent=`${base}–${base+starts.length-1} ${label("validLineRange","범위의 줄 번호를 입력하세요")}`;return;}
    line.removeAttribute("aria-invalid");feedback.textContent="";const start=starts[index],end=index+1<starts.length?starts[index+1]:raw.length;
    mark(start,raw.slice(start,end).replace(/[\r\n]+$/,"").length);
  }
  if(features.F11!==false){bind(search,"input",searchBody);bind(previous,"click",()=>move(-1));bind(next,"click",()=>move(1));bind(search,"keydown",event=>{if(event.isComposing||event.keyCode===229)return;if(event.key==="Enter"){event.preventDefault();move(event.shiftKey?-1:1);}});}
  if(features.F12!==false){bind(go,"click",jump);bind(line,"keydown",event=>{if(event.isComposing||event.keyCode===229)return;if(event.key==="Enter"){event.preventDefault();jump();}});}
  // Clip any selection crossing the number gutter to the original body. Explicit
  // file-copy/download elsewhere also continue to use the untouched source text.
  bind(viewport,"copy",event=>{
    const selection=doc.getSelection?.();if(!event.clipboardData||!selection?.rangeCount)return;
    const selected=selection.getRangeAt(0);if(!selected.intersectsNode(body))return;
    const original=doc.createRange();original.selectNodeContents(body);const clipped=selected.cloneRange();
    if(clipped.compareBoundaryPoints(0,original)<0)clipped.setStart(original.startContainer,original.startOffset);
    if(clipped.compareBoundaryPoints(2,original)>0)clipped.setEnd(original.endContainer,original.endOffset);
    event.clipboardData.setData("text/plain",clipped.toString());event.preventDefault();
  });
  showMatch();
  return {
    focusSearch(){if(disposed||features.F11===false)return false;search.focus();return true;},
    focusLine(){if(disposed||features.F12===false)return false;line.focus();return true;},
    dispose(){if(disposed)return;disposed=true;matches=[];for(const cleanup of cleanups)cleanup();toolbar.replaceChildren();viewport.replaceChildren();container.replaceChildren();}
  };
}
