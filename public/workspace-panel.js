import { createPdfPreview } from "./pdf-preview.js";
import { createTextPreviewTools } from "./file-preview-tools.js";

export class FilePanelGate {
  constructor(){this.sequence=0;this.key="";this.controller=new AbortController();}
  invalidate(){this.controller.abort();this.controller=new AbortController();this.sequence++;}
  change(key){if(key===this.key)return false;this.key=key;this.invalidate();return true;}
  capture(){return {sequence:this.sequence,signal:this.controller.signal};}
  current(ticket){return ticket.sequence===this.sequence&&!ticket.signal.aborted;}
}

export function createWorkspacePanel({panel,toggle,shell,client,t,document:doc=panel.ownerDocument,features={}}) {
  const gate=new FilePanelGate();let threadId="",context=null,opened=false,connected=false,selection=0,previewAbort=null,objectUrl=null,authBlocked=false,pdfViewer=null,textTools=null,mode="files",searchTimer=null;
  const text=key=>t(`files.${key}`);
  const make=(tag,className,value)=>{const node=doc.createElement(tag);if(className)node.className=className;if(value!==undefined)node.textContent=value;return node;};
  const header=make("header","files-header");
  const heading=make("strong","",text("title"));heading.id="filesHeading";
  const refresh=make("button","icon-button", "↻");refresh.type="button";refresh.title=text("refresh");refresh.setAttribute("aria-label",text("refresh"));
  const close=make("button","icon-button","×");close.type="button";close.title=text("close");close.setAttribute("aria-label",text("close"));header.append(heading,refresh,close);
  const rootLabel=make("div","files-root",text("choose"));
  const controls=make("div","files-controls"),tabs=make("div","files-tabs"),allFiles=make("button","",text("allFiles")),artifacts=make("button","",text("artifacts")),search=make("input","files-search");
  allFiles.type=artifacts.type="button";allFiles.setAttribute("aria-pressed","true");artifacts.setAttribute("aria-pressed","false");tabs.append(allFiles,artifacts);search.type="search";search.value="";search.placeholder=text("searchNames");search.setAttribute("aria-label",text("searchNames"));controls.append(tabs,search);
  const provenance=make("p","files-status");
  const status=make("div","files-status");status.setAttribute("role","status");
  const tree=make("ul","files-tree");tree.setAttribute("role","tree");tree.setAttribute("aria-label",text("tree"));
  const preview=make("section","files-preview");preview.setAttribute("aria-label",text("preview"));
  const resize=make("div","files-resize");resize.tabIndex=0;resize.setAttribute("role","separator");resize.setAttribute("aria-orientation","vertical");resize.setAttribute("aria-label",text("resize"));resize.setAttribute("aria-valuemin","300");resize.setAttribute("aria-valuemax","600");
  const backdrop=make("button","files-backdrop");backdrop.type="button";backdrop.hidden=true;backdrop.tabIndex=-1;backdrop.setAttribute("aria-label",text("close"));shell.append(backdrop);
  panel.replaceChildren(resize,header,rootLabel,controls,provenance,status,tree,preview);panel.setAttribute("aria-labelledby","filesHeading");
  panel.hidden=false;panel.inert=true;panel.setAttribute("aria-hidden","true");
  const overlay=globalThis.matchMedia("(max-width: 1279px)");
  function save(key,value){try{localStorage.setItem(key,String(value));}catch{}}
  function read(key){try{return localStorage.getItem(key);}catch{return null;}}
  function setWidth(width){const value=Math.max(300,Math.min(600,width));shell.style.setProperty("--files-width",`${value}px`);resize.setAttribute("aria-valuenow",String(value));save("codex-files-width",value);}
  setWidth(Number(read("codex-files-width"))||380);
  function releasePreview(){selection++;previewAbort?.abort();previewAbort=null;textTools?.dispose();textTools=null;pdfViewer?.destroy();pdfViewer=null;if(objectUrl)URL.revokeObjectURL(objectUrl);objectUrl=null;preview.replaceChildren();}
  function clear(){clearTimeout(searchTimer);gate.invalidate();context=null;tree.replaceChildren();releasePreview();provenance.textContent="";rootLabel.textContent=threadId?text("loading"):text("choose");}
  function layout(){
    const modal=opened&&overlay.matches;backdrop.hidden=!modal;panel.setAttribute("role",modal?"dialog":"complementary");
    if(modal)panel.setAttribute("aria-modal","true");else panel.removeAttribute("aria-modal");
    toggle.tabIndex=modal?-1:0;
    resize.tabIndex=modal?-1:0;
    for(const node of [shell.querySelector(".chat-pane"),shell.querySelector(".sidebar")])if(node)node.inert=modal;
  }
  function show(value){
    opened=value;panel.inert=!value;panel.setAttribute("aria-hidden",String(!value));shell.classList.toggle("files-open",value);toggle.setAttribute("aria-expanded",String(value));save("codex-files-open",value);layout();
    if(value){close.focus();if(!context)void loadRoot();}else{clear();status.textContent="";toggle.focus();}
  }
  function fail(error,ticket){
    if(!gate.current(ticket)||error.name==="AbortError")return;
    if(error.status===409){clear();status.textContent=text("changed");return;}
    if([401,403].includes(error.status)){clear();authBlocked=true;status.textContent=text("restricted");return;}
    status.textContent=text("error");
  }
  async function loadRoot(){
    if(!opened||!threadId||!connected||authBlocked){status.textContent=text(!threadId?"choose":!connected?"disconnected":"restricted");return;}
    status.textContent=text("loading");const ticket=gate.capture();
    try{
      const term=search.value.trim(),action=mode==="artifacts"?"artifacts":term?"search":"tree";
      if(action!=="tree"&&!context){const initial=await client.get("tree",{threadId,path:""},ticket.signal);if(!gate.current(ticket))return;context=initial.context;}
      const result=await client.get(action,{threadId,path:"",rootRevision:context?.rootRevision,...(term?{search:term}:{})},ticket.signal);
      if(!gate.current(ticket)||!opened)return;context=result.context;rootLabel.textContent=result.context.rootName;
      const entries=mode==="artifacts"&&term?result.entries.filter(entry=>entry.path.toLocaleLowerCase().includes(term.toLocaleLowerCase())):result.entries;
      renderEntries(tree,entries,0);provenance.textContent=mode==="artifacts"?text("artifactSource"):"";
      status.textContent=result.truncated?text(action==="tree"?"limited":"searchLimited"):result.hiddenCount?text("hidden"):entries.length?"":text("empty");
    }
    catch(error){fail(error,ticket);}
  }
  function query(path){return {threadId,path,rootRevision:context.rootRevision};}
  function renderEntries(list,entries,depth){
    list.replaceChildren();
    for(const entry of entries){
      const li=make("li","file-node");li.setAttribute("role","none");
      const row=make("button","file-row");row.type="button";row.dataset.filePath=entry.path;row.setAttribute("role","treeitem");row.setAttribute("aria-level",String(depth+1));row.title=entry.name;row.style.setProperty("--file-depth",depth);
      row.append(make("span","file-icon",entry.kind==="directory"?"▸":"·"),make("span","file-name",entry.label||entry.name));
      const children=make("ul","files-group");children.setAttribute("role","group");children.hidden=true;
      if(entry.kind==="directory")row.setAttribute("aria-expanded","false");
      row.addEventListener("click",async()=>{
        for(const other of tree.querySelectorAll('[role="treeitem"]'))other.tabIndex=-1;row.tabIndex=0;
        if(entry.kind!=="directory"){void selectFile(entry,row);return;}
        const expand=row.getAttribute("aria-expanded")!=="true";row.setAttribute("aria-expanded",String(expand));row.firstChild.textContent=expand?"▾":"▸";children.hidden=!expand;
        if(!expand||children.childNodes.length)return;
        const ticket=gate.capture();row.setAttribute("aria-busy","true");
        try{const result=await client.get("tree",query(entry.path),ticket.signal);if(gate.current(ticket)&&row.isConnected){renderEntries(children,result.entries,depth+1);if(result.truncated)status.textContent=text("limited");}}
        catch(error){fail(error,ticket);}finally{row.removeAttribute("aria-busy");}
      });
      li.append(row,children);list.append(li);
    }
    const first=tree.querySelector('[role="treeitem"]');if(first&&!tree.querySelector('[role="treeitem"][tabindex="0"]'))first.tabIndex=0;
    for(const row of list.querySelectorAll(':scope > li > button'))if(row!==first)row.tabIndex=-1;
  }
  async function selectFile(entry,row){
    releasePreview();const selected=selection,ticket=gate.capture();previewAbort=new AbortController();const local=previewAbort;
    const abort=()=>local.abort();ticket.signal.addEventListener("abort",abort,{once:true});
    for(const node of tree.querySelectorAll('[aria-selected="true"]'))node.removeAttribute("aria-selected");row.setAttribute("aria-selected","true");
    preview.append(make("p","files-status",text("loading")));
    try{
      const result=client.openPreview?await client.openPreview(query(entry.path),local.signal):await client.get("preview",query(entry.path),local.signal);
      if(!gate.current(ticket)||selected!==selection)return;
      const toolbar=make("div","file-preview-toolbar");const title=make("strong","",entry.name);toolbar.append(title);
      const download=client.downloadUrl(query(entry.path));
      if(download&&result.downloadAllowed){const link=make("a","file-download",text("download"));link.href=download;link.download=entry.name;link.target="_blank";link.rel="noopener noreferrer";toolbar.append(link);}
      else if(result.downloadAllowed){const button=make("button","file-download",text("download"));button.type="button";button.addEventListener("click",async()=>{button.disabled=true;try{const url=await client.downloadTicket(query(entry.path),local.signal);if(!gate.current(ticket)||selected!==selection)return;const link=make("a");link.href=url;link.download=entry.name;link.rel="noreferrer";preview.append(link);link.click();link.remove();}catch(error){if(gate.current(ticket)&&selected===selection&&error.name!=="AbortError"){if([401,403,409].includes(error.status))fail(error,ticket);else status.textContent=text("downloadFailed");}}finally{button.disabled=false;}});toolbar.append(button);}
      preview.replaceChildren(toolbar,make("small","files-status",`${entry.path} · ${new Intl.NumberFormat().format(result.size)} bytes`));
      if(result.resumeAllowed)preview.append(make("small","files-status",text("resumeSupported")));
      if(result.kind==="text"){
        const copy=make("button","file-copy",text("copy"));copy.type="button";copy.addEventListener("click",()=>{if(!gate.current(ticket)||selected!==selection)return;void navigator.clipboard.writeText(result.text).then(()=>{if(gate.current(ticket)&&selected===selection)copy.textContent=text("copied");}).catch(()=>{if(gate.current(ticket)&&selected===selection)status.textContent=text("copyFailed");});});toolbar.append(copy);
        const box=make("div","text-preview");preview.append(box);
        if(features.F11===false&&features.F12===false)box.append(make("pre","file-text",result.text));
        else textTools=createTextPreviewTools({document:doc,container:box,text:result.text,truncated:result.truncated,firstLine:result.firstLine===undefined?1:result.firstLine,t,features});
        if(result.truncated)preview.append(make("p","files-status",text("truncated")));
      }else if(result.kind==="pdf"){
        const blob=result.blob||await client.get("content",query(entry.path),local.signal);if(!gate.current(ticket)||selected!==selection)return;
        const box=make("div","pdf-preview");preview.append(box);pdfViewer=createPdfPreview({container:box,t,document:doc,features});await pdfViewer.show(blob,local.signal);
      }else if(result.kind==="image"){
        const blob=result.blob||await client.get("content",query(entry.path),local.signal);
        if(!gate.current(ticket)||selected!==selection)return;
        objectUrl=URL.createObjectURL(blob);const image=make("img","file-image");image.alt=entry.name;image.src=objectUrl;image.decoding="async";preview.append(image);
      }else preview.append(make("p","files-status",text("metadata")));
    }catch(error){if(gate.current(ticket)&&selected===selection&&error.name!=="AbortError"){preview.replaceChildren();fail(error,ticket);}}
    finally{ticket.signal.removeEventListener("abort",abort);}
  }
  tree.addEventListener("keydown",event=>{
    const row=event.target.closest('[role="treeitem"]');if(!row)return;
    const rows=[...tree.querySelectorAll('[role="treeitem"]')].filter(node=>!node.closest('[hidden]'));
    const index=rows.indexOf(row);let target;
    if(event.key==="ArrowDown")target=rows[index+1];else if(event.key==="ArrowUp")target=rows[index-1];else if(event.key==="Home")target=rows[0];else if(event.key==="End")target=rows.at(-1);
    else if(event.key==="ArrowRight"&&row.getAttribute("aria-expanded")==="false")row.click();
    else if(event.key==="ArrowLeft"){if(row.getAttribute("aria-expanded")==="true")row.click();else target=row.parentElement.parentElement.closest("li")?.querySelector(":scope > button");}else return;
    event.preventDefault();if(target){row.tabIndex=-1;target.tabIndex=0;target.focus();}
  });
  resize.addEventListener("keydown",event=>{if(!["ArrowLeft","ArrowRight"].includes(event.key))return;event.preventDefault();setWidth(Number(resize.getAttribute("aria-valuenow"))+(event.key==="ArrowLeft"?24:-24));});
  resize.addEventListener("pointerdown",event=>{if(overlay.matches)return;event.preventDefault();resize.setPointerCapture(event.pointerId);});
  resize.addEventListener("pointermove",event=>{if(resize.hasPointerCapture(event.pointerId))setWidth(globalThis.innerWidth-event.clientX);});
  resize.addEventListener("pointerup",event=>{if(resize.hasPointerCapture(event.pointerId))resize.releasePointerCapture(event.pointerId);});
  toggle.addEventListener("click",()=>show(!opened));close.addEventListener("click",()=>show(false));backdrop.addEventListener("click",()=>show(false));
  const reloadView=()=>{clearTimeout(searchTimer);gate.invalidate();tree.replaceChildren();releasePreview();void loadRoot();};
  allFiles.addEventListener("click",()=>{mode="files";allFiles.setAttribute("aria-pressed","true");artifacts.setAttribute("aria-pressed","false");reloadView();});
  artifacts.addEventListener("click",()=>{mode="artifacts";allFiles.setAttribute("aria-pressed","false");artifacts.setAttribute("aria-pressed","true");reloadView();});
  search.addEventListener("input",()=>{clearTimeout(searchTimer);gate.invalidate();tree.replaceChildren();releasePreview();searchTimer=setTimeout(()=>{void loadRoot();},400);});
  refresh.addEventListener("click",()=>{authBlocked=false;reloadView();});overlay.addEventListener("change",layout);
  doc.addEventListener("keydown",event=>{
    if(!opened||event.defaultPrevented||event.isComposing||event.keyCode===229)return;
    // Native dialogs occupy the browser top layer above the narrow Files panel.
    // Leave both Escape and Tab to their own modal handlers/focus containment.
    if(doc.querySelector?.("dialog[open]"))return;
    if(event.key==="Escape"){event.preventDefault();show(false);return;}
    if(event.key==="Tab"&&overlay.matches){const nodes=[...panel.querySelectorAll('button,a[href],input,textarea,select,[tabindex="0"]')].filter(node=>!node.disabled&&!node.closest('[hidden]'));const first=nodes[0],last=nodes.at(-1);if(event.shiftKey&&doc.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&doc.activeElement===last){event.preventDefault();first?.focus();}}
  });
  if(read("codex-files-open")==="true")show(true);
  return {
    setContext(value){const key=value?.threadId?`${value.threadId}\0${value.cwdHint||""}`:"";if(!gate.change(key))return;threadId=value?.threadId||"";authBlocked=false;search.value="";clear();if(opened)void loadRoot();},
    setConnected(value){if(connected===Boolean(value))return;connected=Boolean(value);clear();status.textContent=connected?"":text("disconnected");if(connected&&opened&&!authBlocked)void loadRoot();},
    setAvailable(value){toggle.disabled=!value;if(!value&&opened)show(false);},
    getTools(){return opened&&!authBlocked?{text:textTools,pdf:pdfViewer}:null;},
    focusTextSearch(){return Boolean(opened&&!authBlocked&&textTools?.focusSearch());},
    focusTextLine(){return Boolean(opened&&!authBlocked&&textTools?.focusLine());},
    focusPdfPage(){return Boolean(opened&&!authBlocked&&pdfViewer?.focusPage());},
    close:()=>show(false)
  };
}
