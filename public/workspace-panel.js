import { createPdfPreview } from "./pdf-preview.js";
import { createTextPreviewTools } from "./file-preview-tools.js";
import { createContextMenu } from "./ui/context-menu.js";
import { createFileEditor } from "./file-editor.js";
import { registerMessages } from "./i18n.js";
import { fileWritePanelMessages } from "./file-write-messages.js";

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const OPERATION_ID = /^[0-9a-f]{32}$/;
const COLLISION = /exist|conflict|file[_-]?changed|stale[_-]?version/i;
const TEXT_NAME = /\.(txt|md|markdown|json|jsonc|js|mjs|cjs|jsx|ts|tsx|css|scss|sass|less|html?|xml|ya?ml|toml|ini|cfg|conf|properties|csv|tsv|log|py|rb|go|rs|java|c|h|cc|cpp|hpp|cs|sh|bash|zsh|ps1|bat|sql|kt|kts|swift|php|lua|pl|r|dart|vue|svelte|env|gitignore|editorconfig)$/i;

export class FilePanelGate {
  constructor(){this.sequence=0;this.key="";this.controller=new AbortController();}
  invalidate(){this.controller.abort();this.controller=new AbortController();this.sequence++;}
  change(key){if(key===this.key)return false;this.key=key;this.invalidate();return true;}
  capture(){return {sequence:this.sequence,signal:this.controller.signal};}
  current(ticket){return ticket.sequence===this.sequence&&!ticket.signal.aborted;}
}

// A relative child path inside the project root. The native writer re-validates
// every path; this is only a UI pre-check so obvious mistakes never reach it.
export function targetRelativePath(parentPath, name) {
  const parent = typeof parentPath === "string" ? parentPath : "";
  const clean = typeof name === "string" ? name : "";
  if (!clean || clean.length > 255) return null;
  if (clean === "." || clean === "..") return null;
  if (clean !== clean.trim()) return null;
  if (clean.endsWith(".")) return null;
  if (/[/\\\u0000-\u001f\u007f]/.test(clean)) return null;
  if (!parent) return clean;
  if (parent.startsWith("/") || parent.startsWith("\\") || /^[A-Za-z]:/.test(parent)) return null;
  if (/[\\\u0000-\u001f\u007f]/.test(parent)) return null;
  if (parent.split("/").some(part => part === "" || part === "." || part === "..")) return null;
  return `${parent}/${clean}`;
}

export function writeOperationSucceeded(dto) {
  return Boolean(dto && typeof dto === "object" && dto.status === "succeeded");
}

// A write that collides with an existing entry is never retried, renamed or forced.
export function isCollision(value) {
  if (!value || typeof value !== "object") return false;
  if (value.status === 409) return true;
  if (value.status === "failed" && COLLISION.test(`${value.result?.reason ?? ""} ${value.result?.code ?? ""}`)) return true;
  return COLLISION.test(`${value.code ?? ""} ${value.error ?? ""}`);
}

// Merge the native edit-open DTO with the write context that authorized it.
// The editor needs a string version and the original context id unchanged.
export function mergeEditOpen({ context, path, dto } = {}) {
  if (!context || typeof context !== "object") return null;
  if (typeof context.contextId !== "string" || context.contextId === "") return null;
  if (typeof context.threadId !== "string" || context.threadId === "") return null;
  if (context.rootRevision === undefined || context.rootRevision === null) return null;
  if (typeof path !== "string" || path === "") return null;
  if (!dto || typeof dto !== "object" || dto.status !== "succeeded") return null;
  const result = dto.result;
  if (!result || typeof result !== "object" || result.editable !== true) return null;
  if (typeof result.text !== "string") return null;
  const version = typeof result.version === "string" && result.version !== ""
    ? result.version
    : Number.isSafeInteger(result.version) ? String(result.version) : null;
  if (!version) return null;
  return {
    contextId: context.contextId,
    threadId: context.threadId,
    rootRevision: String(context.rootRevision),
    path: typeof dto.path === "string" && dto.path !== "" ? dto.path : path,
    version,
    text: result.text,
    editable: true,
    bom: result.bom === true,
    eol: typeof result.eol === "string" && result.eol !== "" ? result.eol : "lf",
    size: Number.isFinite(Number(result.size)) ? Number(result.size) : undefined
  };
}

export function isTextEditableName(name) {
  return TEXT_NAME.test(String(name ?? ""));
}

function dragTypes(dataTransfer) {
  try {
    return dataTransfer?.types ? Array.from(dataTransfer.types) : [];
  } catch {
    return [];
  }
}

export function dragHasFiles(dataTransfer) {
  try {
    if (dataTransfer?.files && dataTransfer.files.length > 0) return true;
  } catch {
    // A locked DataTransfer exposes no files; fall through to the type list.
  }
  return dragTypes(dataTransfer).includes("Files");
}

// Only real File objects are accepted: incoming text/uri-list drags are never
// read, so a dragged path string can never become a write target.
export function dropFiles(dataTransfer) {
  if (!dragHasFiles(dataTransfer)) return [];
  let files = [];
  try {
    files = dataTransfer?.files ? Array.from(dataTransfer.files) : [];
  } catch {
    files = [];
  }
  return files.filter(file => file && typeof file === "object" && typeof file.name === "string");
}

export function createFolderDragOverHandler({ enabled = () => true } = {}) {
  return function handleFolderDragOver(event) {
    if (!event || !dragHasFiles(event.dataTransfer)) return false;
    if (typeof enabled === "function" && !enabled()) return false;
    event.preventDefault?.();
    event.stopPropagation?.();
    return true;
  };
}

// Nested folder handlers mark the event and stop propagation, so one drop can
// never be uploaded twice (child folder first, panel fallback second).
export function createFolderDropHandler({ getTarget, onFiles, enabled = () => true } = {}) {
  return function handleFolderDrop(event) {
    if (!event || event.__workspaceFilesDrop === true) return false;
    const files = dropFiles(event.dataTransfer);
    if (!files.length) return false;
    if (typeof enabled === "function" && !enabled()) return false;
    event.__workspaceFilesDrop = true;
    event.preventDefault?.();
    event.stopPropagation?.();
    let target = "";
    try {
      target = typeof getTarget === "function" ? String(getTarget() ?? "") : "";
    } catch {
      target = "";
    }
    try {
      onFiles?.(files, target);
    } catch {
      // A consumer failure cannot break the drop listener.
    }
    return true;
  };
}

// Sequential raw-byte uploads. Every file gets a fresh write context for the
// target parent, a 32 hex operation id and its own progress callback. One
// failure never removes or renames the other files in the batch.
export function createUploadBatch({ upload, writeContext, getScope, maxBytes = MAX_UPLOAD_BYTES, createId } = {}) {
  let controller = null;
  let generation = 0;

  function newOperationId() {
    try {
      const raw = typeof createId === "function" ? createId() : globalThis.crypto?.randomUUID?.();
      const hex = String(raw ?? "").replace(/-/g, "").toLowerCase();
      return OPERATION_ID.test(hex) ? hex : null;
    } catch {
      return null;
    }
  }

  function cancel() {
    generation += 1;
    try {
      controller?.abort();
    } catch {
      // Abort is best effort.
    }
    controller = null;
  }

  async function run(files, options = {}) {
    const parentPath = typeof options.parentPath === "string" ? options.parentPath : "";
    const onUpdate = typeof options.onUpdate === "function" ? options.onUpdate : () => {};
    const list = Array.from(files ?? []).filter(file => file && typeof file === "object");
    const items = list.map(file => ({
      file,
      name: typeof file.name === "string" ? file.name : "",
      size: Number.isSafeInteger(file.size) ? file.size : 0,
      status: "queued",
      path: null,
      progress: 0,
      loaded: 0,
      total: Number.isSafeInteger(file.size) ? file.size : 0,
      error: null
    }));
    try {
      controller?.abort();
    } catch {
      // Replacing a previous batch is best effort.
    }
    const local = new AbortController();
    controller = local;
    generation += 1;
    const batch = generation;
    const live = () => batch === generation && !local.signal.aborted;
    const emit = (item, patch) => {
      Object.assign(item, patch);
      if (!live()) return;
      try {
        onUpdate(item);
      } catch {
        // Render callbacks cannot fail the transfer.
      }
    };

    for (const item of items) emit(item, {});
    for (const item of items) {
      if (!live()) {
        emit(item, { status: "cancelled" });
        continue;
      }
      if (item.size > maxBytes) {
        emit(item, { status: "too-large", error: "FILE_TOO_LARGE" });
        continue;
      }
      const path = targetRelativePath(parentPath, item.name);
      if (!path) {
        emit(item, { status: "failed", error: "INVALID_NAME" });
        continue;
      }
      const operationId = newOperationId();
      if (!operationId) {
        emit(item, { status: "failed", error: "NO_OPERATION_ID" });
        continue;
      }
      let scope = null;
      try {
        scope = typeof getScope === "function" ? getScope() : null;
      } catch {
        scope = null;
      }
      if (!scope || typeof scope.threadId !== "string" || scope.threadId === ""
        || scope.rootRevision === undefined || scope.rootRevision === null) {
        emit(item, { status: "failed", error: "NO_WRITE_CONTEXT" });
        continue;
      }
      let context = null;
      try {
        context = await writeContext({ threadId: scope.threadId, rootRevision: scope.rootRevision, parentPath }, local.signal);
      } catch (error) {
        if (!live() || error?.name === "AbortError") {
          emit(item, { status: "cancelled" });
          continue;
        }
        emit(item, { status: isCollision(error) ? "exists" : "failed", error: error?.code || error?.message || "WRITE_CONTEXT_FAILED" });
        continue;
      }
      if (!live()) {
        emit(item, { status: "cancelled" });
        continue;
      }
      if (!context || typeof context.contextId !== "string" || context.contextId === "") {
        emit(item, { status: "failed", error: "NO_WRITE_CONTEXT" });
        continue;
      }
      emit(item, { status: "uploading", path });
      try {
        const dto = await upload({
          contextId: context.contextId,
          path,
          operationId,
          file: item.file,
          onProgress: progress => {
            const total = Number(progress?.total) > 0 ? Number(progress.total) : item.size;
            const loaded = Number(progress?.loaded) >= 0 ? Number(progress.loaded) : 0;
            emit(item, {
              loaded,
              total,
              progress: total > 0 ? Math.min(1, loaded / total) : 0
            });
          }
        }, local.signal);
        if (!live()) {
          emit(item, { status: "cancelled" });
          continue;
        }
        if (writeOperationSucceeded(dto)) emit(item, { status: "done", progress: 1, loaded: item.size, total: item.size, path });
        else emit(item, { status: dto?.status==="unknown"?"unknown":isCollision(dto) ? "exists" : "failed", error: dto?.result?.reason || dto?.status || "UPLOAD_FAILED" });
      } catch (error) {
        if (!live() || error?.name === "AbortError") {
          emit(item, { status: "cancelled" });
          continue;
        }
        emit(item, { status: isCollision(error) ? "exists" : "failed", error: error?.code || error?.message || "UPLOAD_FAILED" });
      }
    }
    const summary = {
      total: items.length,
      done: items.filter(item => item.status === "done").length,
      failed: items.filter(item => ["failed", "exists", "too-large"].includes(item.status)).length,
      cancelled: items.filter(item => item.status === "cancelled").length
    };
    if (controller === local) controller = null;
    return { items, summary, cancelled: !live() };
  }

  return { run, cancel, isRunning: () => Boolean(controller) };
}

export function createWorkspacePanel({panel,toggle,shell,client,t,document:doc=panel.ownerDocument,features={},contextMenu,canWrite=()=>false,onFeedback,createEditor=createFileEditor}={}) {
  const gate=new FilePanelGate();let threadId="",context=null,opened=false,connected=false,selection=0,editorOpenGeneration=0,previewAbort=null,objectUrl=null,authBlocked=false,pdfViewer=null,textTools=null,mode="files",searchTimer=null;
  let selectedFolder="",selectedRow=null,writeOverride=null;
  let uploadGeneration=0,uploadRefs=[],uploadHeadingNode=null,uploadCancelNode=null,uploadHeadingCount=0,pendingUploadTarget=null;
  let fileEditor=null,editorSnapshot=null,editorContext=null;
  let menu=null,ownsMenu=false,disposed=false;
  try{registerMessages(fileWritePanelMessages);}catch{/* Already registered by another panel or test runtime. */}
  if(contextMenu)menu=contextMenu;
  else{try{menu=createContextMenu({document:doc,t});ownsMenu=true;}catch{menu=null;}}
  const text=key=>t(`files.${key}`);
  function msg(key,params){
    let template;
    try{const value=params?t(key,params):t(key);if(typeof value==="string"&&value!==""&&value!==key)template=value;}catch{/* Fall back to the bundled English label. */}
    if(template===undefined)template=fileWritePanelMessages.en[key]??key;
    if(!params)return template;
    return template.replace(/\{(\w+)\}/g,(match,name)=>params[name]===undefined?match:String(params[name]));
  }
  const wlabel=(key,params)=>msg(`files.write.${key}`,params);
  const make=(tag,className,value)=>{const node=doc.createElement(tag);if(className)node.className=className;if(value!==undefined)node.textContent=value;return node;};
  const header=make("header","files-header");
  const heading=make("strong","",text("title"));heading.id="filesHeading";
  const refresh=make("button","icon-button","↻");refresh.type="button";refresh.title=text("refresh");refresh.setAttribute("aria-label",text("refresh"));
  const close=make("button","icon-button","×");close.type="button";close.title=text("close");close.setAttribute("aria-label",text("close"));header.append(heading,refresh,close);
  const rootLabel=make("div","files-root",text("choose"));
  const targetLabel=make("div","files-root","");targetLabel.setAttribute("aria-live","polite");
  const bufferDownload=make("button","secondary-action",wlabel("bufferDownload"));bufferDownload.type="button";bufferDownload.hidden=true;
  bufferDownload.addEventListener("click",()=>{
    if(!editorSnapshot||!connected||authBlocked||editorSnapshot.threadId!==threadId||String(editorSnapshot.rootRevision)!==rootRevisionString())return;
    const url=URL.createObjectURL(new Blob([editorSnapshot.text],{type:"text/plain;charset=utf-8"}));
    try{const link=make("a","","");link.href=url;link.download=editorSnapshot.path.split("/").at(-1)+".unsaved.txt";doc.body.append(link);link.click();link.remove();}finally{setTimeout(()=>URL.revokeObjectURL(url),1000);}
  });
  const writeBar=make("div","files-controls"),writeRow=make("div","files-tabs");
  const newFolderButton=make("button","",wlabel("newFolder")),uploadButton=make("button","",wlabel("upload"));
  const rootTargetButton=make("button","",wlabel("rootTarget"));rootTargetButton.type="button";rootTargetButton.addEventListener("click",()=>setSelectedFolder(""));
  newFolderButton.type=uploadButton.type="button";
  newFolderButton.hidden=uploadButton.hidden=true;newFolderButton.disabled=uploadButton.disabled=true;
  const fileInput=make("input","files-upload-input");fileInput.type="file";fileInput.multiple=true;fileInput.hidden=true;fileInput.setAttribute("aria-label",wlabel("upload"));
  writeRow.append(newFolderButton,uploadButton,rootTargetButton,bufferDownload);writeBar.append(writeRow,fileInput);
  const uploadHost=make("div","files-uploads");uploadHost.setAttribute("aria-live","polite");
  const controls=make("div","files-controls"),tabs=make("div","files-tabs"),allFiles=make("button","",text("allFiles")),artifacts=make("button","",text("artifacts")),search=make("input","files-search");
  allFiles.type=artifacts.type="button";allFiles.setAttribute("aria-pressed","true");artifacts.setAttribute("aria-pressed","false");tabs.append(allFiles,artifacts);search.type="search";search.value="";search.placeholder=text("searchNames");search.setAttribute("aria-label",text("searchNames"));controls.append(tabs,search);
  const provenance=make("p","files-status");
  const status=make("div","files-status");status.setAttribute("role","status");
  const tree=make("ul","files-tree");tree.setAttribute("role","tree");tree.setAttribute("aria-label",text("tree"));
  const preview=make("section","files-preview");preview.setAttribute("aria-label",text("preview"));
  const editorHost=make("div","file-editor-host");
  const resize=make("div","files-resize");resize.tabIndex=0;resize.setAttribute("role","separator");resize.setAttribute("aria-orientation","vertical");resize.setAttribute("aria-label",text("resize"));resize.setAttribute("aria-valuemin","300");resize.setAttribute("aria-valuemax","600");
  const backdrop=make("button","files-backdrop");backdrop.type="button";backdrop.hidden=true;backdrop.tabIndex=-1;backdrop.setAttribute("aria-label",text("close"));shell.append(backdrop);
  panel.replaceChildren(resize,header,rootLabel,targetLabel,writeBar,controls,provenance,status,uploadHost,tree,preview,editorHost);panel.setAttribute("aria-labelledby","filesHeading");
  panel.hidden=false;panel.inert=true;panel.setAttribute("aria-hidden","true");
  const overlay=globalThis.matchMedia("(max-width: 1279px)");
  function save(key,value){try{localStorage.setItem(key,String(value));}catch{}}
  function read(key){try{return localStorage.getItem(key);}catch{return null;}}
  function setWidth(width){const value=Math.max(300,Math.min(600,width));shell.style.setProperty("--files-width",`${value}px`);resize.setAttribute("aria-valuenow",String(value));save("codex-files-width",value);}
  setWidth(Number(read("codex-files-width"))||380);

  function writesEnabled(){
    if(!connected||authBlocked||!threadId||!context?.rootRevision)return false;
    if(typeof client?.writeContext!=="function"||typeof client?.uploadFile!=="function")return false;
    if(writeOverride!==null)return writeOverride;
    try{return Boolean(canWrite());}catch{return false;}
  }
  function renderTarget(){
    const path=selectedFolder||context?.rootName||"";
    targetLabel.textContent=wlabel("target",{path:path||wlabel("rootTarget")});
  }
  function syncWriteUi(){
    bufferDownload.hidden=!editorSnapshot||!connected||authBlocked||editorSnapshot.threadId!==threadId||String(editorSnapshot.rootRevision)!==rootRevisionString();
    const enabled=writesEnabled();
    newFolderButton.hidden=uploadButton.hidden=!enabled;
    rootTargetButton.hidden=!enabled;rootTargetButton.disabled=!enabled;
    newFolderButton.disabled=uploadButton.disabled=!enabled;
    renderTarget();
  }
  function setSelectedFolder(path){selectedFolder=typeof path==="string"?path:"";renderTarget();}
  function setSelectedRow(row){
    if(selectedRow&&selectedRow!==row){
      selectedRow.removeAttribute("aria-selected");
      if(selectedRow.__more)selectedRow.__more.hidden=true;
    }
    selectedRow=row??null;
    if(selectedRow){
      selectedRow.setAttribute("aria-selected","true");
      if(selectedRow.__more)selectedRow.__more.hidden=false;
    }
  }
  function reportFeedback(entry){
    try{onFeedback?.(entry);}catch{/* Advisory only. */}
    if(entry&&typeof entry.label==="string"&&entry.label!==""&&opened)status.textContent=entry.label;
  }

  function releasePreview(){selection++;editorOpenGeneration++;previewAbort?.abort();previewAbort=null;textTools?.dispose();textTools=null;pdfViewer?.destroy();pdfViewer=null;if(objectUrl)URL.revokeObjectURL(objectUrl);objectUrl=null;preview.replaceChildren();}

  function safeEditorState(editor){try{return editor?.getState?.()??null;}catch{return null;}}
  function disposeEditor({capture=false}={}){
    if(!fileEditor){editorContext=null;return;}
    const before=safeEditorState(fileEditor);
    try{fileEditor.dispose();}catch{/* Editor cleanup is best effort. */}
    const after=safeEditorState(fileEditor);
    if(capture&&(before?.dirty||before?.status==="unknown"||before?.status==="saving")){
      editorSnapshot=after?.snapshot??(before?{text:before.text,path:before.path,status:before.status,contextId:before.contextId,threadId:before.threadId,rootRevision:before.rootRevision,reason:"forced"}:null);
      reportFeedback({kind:"warning",code:"files.write.bufferKept",label:wlabel("bufferKept",{path:before?.path??""})});
    }
    fileEditor=null;editorContext=null;
    if(typeof editorHost.replaceChildren==="function")editorHost.replaceChildren();
  }
  async function guardEditor(){
    if(!fileEditor)return true;
    try{return (await fileEditor.beforeContextChange())!==false;}catch{return false;}
  }

  function clear(){
    clearTimeout(searchTimer);gate.invalidate();context=null;tree.replaceChildren();releasePreview();
    uploadHost.replaceChildren();uploadRefs=[];uploadHeadingNode=null;uploadCancelNode=null;uploadHeadingCount=0;
    selectedRow=null;
    provenance.textContent="";rootLabel.textContent=threadId?text("loading"):text("choose");renderTarget();
  }
  function layout(){
    const modal=opened&&overlay.matches;backdrop.hidden=!modal;panel.setAttribute("role",modal?"dialog":"complementary");
    if(modal)panel.setAttribute("aria-modal","true");else panel.removeAttribute("aria-modal");
    toggle.tabIndex=modal?-1:0;
    resize.tabIndex=modal?-1:0;
    for(const node of [shell.querySelector(".chat-pane"),shell.querySelector(".sidebar")])if(node)node.inert=modal;
  }
  function show(value){
    opened=value;panel.inert=!value;panel.setAttribute("aria-hidden",String(!value));shell.classList.toggle("files-open",value);toggle.setAttribute("aria-expanded",String(value));save("codex-files-open",value);layout();
    if(value){renderTarget();close.focus();if(!context)void loadRoot();}else{clear();status.textContent="";toggle.focus();}
  }
  // Closing, switching files, refreshing or changing the tree all run through
  // this guard so a dirty editor is saved or explicitly discarded first.
  function closePanel(){
    if(!fileEditor){show(false);return true;}
    return guardEditor().then(ok=>{if(!ok)return false;disposeEditor();show(false);return true;});
  }
  function fail(error,ticket){
    if(!gate.current(ticket)||error.name==="AbortError")return;
    if(error.status===409){disposeEditor({capture:true});cancelUploads();clear();status.textContent=text("changed");return;}
    if([401,403].includes(error.status)){disposeEditor({capture:true});cancelUploads();clear();authBlocked=true;status.textContent=text("restricted");return;}
    status.textContent=text("error");
  }
  function rootRevisionString(){return context?.rootRevision===undefined||context?.rootRevision===null?"":String(context.rootRevision);}
  function query(path){return {threadId,path,rootRevision:context.rootRevision};}
  async function writeContextFor(parentPath,signal){
    if(!threadId)throw Object.assign(new Error("NO_THREAD"),{status:0});
    if(!connected||authBlocked)throw Object.assign(new Error("OFFLINE"),{status:0});
    if(!context||context.rootRevision===undefined||context.rootRevision===null)throw Object.assign(new Error("NO_CONTEXT"),{status:0});
    if(typeof client?.writeContext!=="function")throw Object.assign(new Error("UNAVAILABLE"),{status:0});
    const fresh=await client.writeContext({threadId,rootRevision:context.rootRevision,parentPath},signal);
    if(!fresh||typeof fresh.contextId!=="string"||fresh.contextId==="")throw Object.assign(new Error("INVALID_CONTEXT"),{status:0});
    return fresh;
  }
  async function loadRoot(){
    if(!opened||!threadId||!connected||authBlocked){status.textContent=text(!threadId?"choose":!connected?"disconnected":"restricted");return;}
    status.textContent=text("loading");const ticket=gate.capture();
    try{
      const term=search.value.trim(),action=mode==="artifacts"?"artifacts":term?"search":"tree";
      if(action!=="tree"&&!context){const initial=await client.get("tree",{threadId,path:""},ticket.signal);if(!gate.current(ticket))return;context=initial.context;}
      const result=await client.get(action,{threadId,path:"",rootRevision:context?.rootRevision,...(term?{search:term}:{})},ticket.signal);
      if(!gate.current(ticket)||!opened)return;context=result.context;rootLabel.textContent=result.context.rootName;renderTarget();syncWriteUi();
      const entries=mode==="artifacts"&&term?result.entries.filter(entry=>entry.path.toLocaleLowerCase().includes(term.toLocaleLowerCase())):result.entries;
      renderEntries(tree,entries,0);provenance.textContent=mode==="artifacts"?text("artifactSource"):"";
      status.textContent=result.truncated?text(action==="tree"?"limited":"searchLimited"):result.hiddenCount?text("hidden"):entries.length?"":text("empty");
    }
    catch(error){fail(error,ticket);}
  }

  function openRowMenu(entry,row,anchor,event){
    if(!menu||disposed)return false;
    setSelectedRow(row);
    let point;
    if(!event&&anchor&&typeof anchor.getBoundingClientRect==="function"){
      const rect=anchor.getBoundingClientRect();
      if(rect&&Number.isFinite(rect.left)&&Number.isFinite(rect.top))point={x:rect.left+8,y:rect.top+Math.min(Number(rect.height)||0,32)};
    }
    try{
      return menu.show({event,anchor,items:rowMenuItems(entry,row),menuLabel:wlabel("menu",{name:entry.name}),point});
    }catch{return false;}
  }
  function rowMenuItems(entry,row){
    const items=[];
    if(entry.kind==="directory"){
      items.push({id:"new-folder",label:wlabel("newFolderHere"),run:()=>openNewFolderDialog(entry.path),disabled:()=>!writesEnabled()});
      items.push({id:"upload-here",label:wlabel("uploadHere"),run:()=>pickUpload(entry.path),disabled:()=>!writesEnabled()});
    }else{
      items.push({id:"edit",label:wlabel("edit"),run:()=>void openEditor(entry,row),disabled:()=>!writesEnabled()||!isTextEditableName(entry.name)});
      items.push({id:"download",label:text("download"),run:()=>void downloadEntry(entry),disabled:false});
    }
    items.push({id:"copy-relative-path",label:wlabel("copyPath"),run:()=>void copyRelativePath(entry.path),disabled:false});
    return items;
  }
  async function copyRelativePath(path){
    try{
      await globalThis.navigator.clipboard.writeText(String(path??""));
      status.textContent=wlabel("pathCopied");
    }catch{status.textContent=text("copyFailed");}
  }
  function absoluteDownloadUrl(value){
    if(typeof value!=="string"||value==="")return null;
    try{const base=globalThis.location?.origin;return base?new URL(value,base).href:null;}catch{return null;}
  }
  function clickDownload(url,name){
    const link=make("a");link.href=url;link.download=name;link.rel="noreferrer";
    if(doc.body&&typeof doc.body.append==="function")doc.body.append(link);else panel.append(link);
    try{link.click?.();}catch{/* A blocked programmatic click leaves the link removed. */}
    link.remove?.();
  }
  async function downloadEntry(entry){
    if(!threadId||!context)return;
    const target=query(entry.path);
    let url=null;
    try{url=client.downloadUrl?.(target)??null;}catch{url=null;}
    if(!url){
      try{url=await client.downloadTicket?.(target);}catch(error){status.textContent=[401,403].includes(error?.status)?text("restricted"):text("downloadFailed");return;}
    }
    if(!url){status.textContent=text("downloadFailed");return;}
    clickDownload(url,entry.name);
  }

  function renderEntries(list,entries,depth){
    list.replaceChildren();
    for(const entry of entries){
      const li=make("li","file-node");li.setAttribute("role","none");
      const row=make("button","file-row");row.type="button";row.dataset.filePath=entry.path;row.setAttribute("role","treeitem");row.setAttribute("aria-level",String(depth+1));row.title=entry.name;row.style.setProperty("--file-depth",depth);
      row.append(make("span","file-icon",entry.kind==="directory"?"▸":"·"),make("span","file-name",entry.label||entry.name));
      const more=make("button","file-more","⋯");more.type="button";more.hidden=true;more.title=wlabel("more");more.setAttribute("aria-label",wlabel("more"));
      row.__more=more;row.__entry=entry;
      const children=make("ul","files-group");children.setAttribute("role","group");children.hidden=true;
      if(entry.kind==="directory")row.setAttribute("aria-expanded","false");
      more.addEventListener("click",event=>{event?.stopPropagation?.();openRowMenu(entry,row,more);});
      row.addEventListener("contextmenu",event=>{openRowMenu(entry,row,row,event);});
      if(entry.kind==="directory"){
        const childDragOver=createFolderDragOverHandler({enabled:()=>writesEnabled()});
        const childDrop=createFolderDropHandler({enabled:()=>writesEnabled(),getTarget:()=>entry.path,onFiles:(files,target)=>{setSelectedFolder(target);void startUpload(files,target);}});
        li.addEventListener("dragover",childDragOver);
        li.addEventListener("drop",childDrop);
      }else{
        // Chrome drag-out only when a credential-free Access download URL already
        // exists; otherwise the existing Download button stays the fallback.
        let dragUrl=null;
        try{dragUrl=absoluteDownloadUrl(client.downloadUrl?.(query(entry.path))??null);}catch{dragUrl=null;}
        if(dragUrl){
          row.draggable=true;
          row.addEventListener("dragstart",event=>{
            const transfer=event?.dataTransfer;
            if(!transfer||typeof transfer.setData!=="function")return;
            try{transfer.setData("DownloadURL",`text/plain:${entry.name}:${dragUrl}`);}catch{/* Unsupported transfer. */}
          });
        }
      }
      row.addEventListener("click",async()=>{
        for(const other of tree.querySelectorAll('[role="treeitem"]'))other.tabIndex=-1;row.tabIndex=0;
        setSelectedRow(row);
        if(entry.kind!=="directory"){void selectFile(entry,row);return;}
        setSelectedFolder(entry.path);
        const expand=row.getAttribute("aria-expanded")!=="true";row.setAttribute("aria-expanded",String(expand));row.firstChild.textContent=expand?"▾":"▸";children.hidden=!expand;
        if(!expand||children.childNodes.length)return;
        const ticket=gate.capture();row.setAttribute("aria-busy","true");
        try{const result=await client.get("tree",query(entry.path),ticket.signal);if(gate.current(ticket)&&row.isConnected){renderEntries(children,result.entries,depth+1);if(result.truncated)status.textContent=text("limited");}}
        catch(error){fail(error,ticket);}finally{row.removeAttribute("aria-busy");}
      });
      li.append(row,more,children);list.append(li);
    }
    const first=tree.querySelector('[role="treeitem"]');if(first&&!tree.querySelector('[role="treeitem"][tabindex="0"]'))first.tabIndex=0;
    for(const row of list.querySelectorAll(':scope > li > button'))if(row!==first)row.tabIndex=-1;
  }

  async function selectFile(entry,row){
    if(!(await guardEditor()))return;
    if(editorContext?.path!==entry.path)disposeEditor();
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
      // The Edit button opens the native editor for a text file; the preview
      // text itself is never used as a save baseline.
      if(result.kind==="text"&&isTextEditableName(entry.name)&&writesEnabled()){
        const edit=make("button","file-edit",wlabel("edit"));edit.type="button";edit.addEventListener("click",()=>void openEditor(entry,row));toolbar.append(edit);
      }
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

  function parentPathOf(path){const value=String(path??"");const index=value.lastIndexOf("/");return index<=0?"":value.slice(0,index);}
  async function renewEditorContext(input,signal){
    const editor=fileEditor, before=editor?.getState?.(), ticket=gate.capture();
    if(!before||before.path!==input.path||before.threadId!==threadId||String(before.rootRevision)!==rootRevisionString())throw Object.assign(new Error("PROJECT_CHANGED"),{status:409,code:"PROJECT_CHANGED"});
    const fresh=await writeContextFor(parentPathOf(input.path),signal);
    if(!gate.current(ticket)||fileEditor!==editor||fresh.threadId!==before.threadId||String(fresh.rootRevision)!==String(before.rootRevision)
      ||!editor.renewAuthority({...fresh,path:input.path}))throw Object.assign(new Error("PROJECT_CHANGED"),{status:409,code:"PROJECT_CHANGED"});
    editorContext={...fresh,path:input.path};
    return {...input,contextId:fresh.contextId};
  }
  function ensureEditor(){
    if(fileEditor)return fileEditor;
    if(typeof createEditor!=="function")return null;
    try{
      fileEditor=createEditor({
        document:doc,
        container:editorHost,
        t,
        registerMessages,
        transport:{
          saveText:async(input,signal)=>client.saveText(await renewEditorContext(input,signal),signal),
          operationStatus:async(input,signal)=>client.operationStatus(await renewEditorContext(input,signal),signal),
          recoveryDownload:async input=>{
            const request=await renewEditorContext({contextId:input.contextId,path:input.path,operationId:input.operationId,kind:"save-text"});
            const ticket=gate.capture(),blob=await client.recoveryDownload(request);
            if(!gate.current(ticket))return;
            const url=URL.createObjectURL(blob);try{const link=make("a","","");link.href=url;link.download=input.path.split("/").at(-1)+".recovery";doc.body.append(link);link.click();link.remove();}finally{setTimeout(()=>URL.revokeObjectURL(url),1000);}
          },
          editOpen:async(input,signal)=>{
            const request=await renewEditorContext({contextId:input.contextId,path:input.path},signal);
            const dto=await client.editOpen(request,signal);
            return mergeEditOpen({context:editorContext,path:input.path,dto});
          }
        },
        getContext:()=>({threadId,rootRevision:rootRevisionString(),connected:connected&&!authBlocked,contextId:editorContext?.contextId??null}),
        onFeedback:entry=>reportFeedback(entry),
        onDirtyChange:()=>{}
      })??null;
    }catch{fileEditor=null;}
    return fileEditor;
  }
  async function openEditor(entry,row){
    const openGeneration=++editorOpenGeneration;
    if(!writesEnabled()){status.textContent=wlabel("unavailable");return;}
    if(!isTextEditableName(entry.name)){status.textContent=wlabel("editUnavailable");return;}
    if(!(await guardEditor())||openGeneration!==editorOpenGeneration)return;
    if(!opened||!threadId||!connected||authBlocked||!context)return;
    if(row)setSelectedRow(row);
    const ticket=gate.capture();
    try{
      const writeContext=await writeContextFor(parentPathOf(entry.path),ticket.signal);
      if(!gate.current(ticket)||openGeneration!==editorOpenGeneration)return;
      const dto=await client.editOpen({contextId:writeContext.contextId,path:entry.path},ticket.signal);
      if(!gate.current(ticket)||openGeneration!==editorOpenGeneration)return;
      const openDto=mergeEditOpen({context:writeContext,path:entry.path,dto});
      if(!openDto){
        const reason=typeof dto?.result?.reason==="string"?dto.result.reason:"";
        status.textContent=reason?wlabel("notEditable",{reason}):wlabel("editUnavailable");
        reportFeedback({kind:"error",code:"files.write.notEditable",label:status.textContent});
        return;
      }
      if(fileEditor?.hasUnsavedChanges?.()){status.textContent=wlabel("blocked");return;}
      disposeEditor();
      editorContext={...writeContext,path:openDto.path};
      const editor=ensureEditor();
      if(!editor||editor.open(openDto)!==true){status.textContent=wlabel("editUnavailable");return;}
      status.textContent="";
    }catch(error){
      if(!gate.current(ticket)||openGeneration!==editorOpenGeneration||error?.name==="AbortError")return;
      fail(error,ticket);
    }
  }

  function formatBytes(value){
    const size=Number(value);
    if(!Number.isFinite(size)||size<0)return "0 B";
    if(size<1024)return `${Math.round(size)} B`;
    const units=["KB","MB","GB"];let amount=size/1024,index=0;
    while(amount>=1024&&index<units.length-1){amount/=1024;index+=1;}
    return `${amount.toFixed(amount>=10?0:1)} ${units[index]}`;
  }
  function describeUploadItem(item){
    if(item.status==="unknown")return wlabel("uploadUnknown");
    if(item.status==="queued")return wlabel("uploadQueued");
    if(item.status==="uploading")return wlabel("uploadProgress",{loaded:formatBytes(item.loaded),total:formatBytes(item.total||item.size)});
    if(item.status==="done")return wlabel("uploadDone");
    if(item.status==="exists")return wlabel("uploadExists");
    if(item.status==="too-large")return wlabel("uploadTooLarge");
    if(item.status==="cancelled")return wlabel("uploadCancelled");
    return wlabel("uploadFailed");
  }
  const uploader=createUploadBatch({
    getScope:()=>({threadId,rootRevision:context?.rootRevision}),
    writeContext:(input,signal)=>client.writeContext(input,signal),
    upload:(input,signal)=>client.uploadFile(input,signal)
  });
  function cancelUploads(){uploadGeneration+=1;uploader.cancel();}
  async function startUpload(files,parentPath){
    if(!writesEnabled()){status.textContent=wlabel("unavailable");return false;}
    if(!opened||!threadId||!connected||authBlocked||!context)return false;
    const target=typeof parentPath==="string"?parentPath:selectedFolder;
    setSelectedFolder(target);
    const list=Array.from(files??[]);
    if(!list.length)return false;
    cancelUploads();
    const generation=uploadGeneration;
    uploadHost.replaceChildren();uploadRefs=[];
    const headerRow=make("div","files-tabs");
    uploadHeadingCount=list.length;
    uploadHeadingNode=make("small","files-status",wlabel("uploadHeading",{count:list.length}));
    uploadCancelNode=make("button","",wlabel("cancelUploads"));uploadCancelNode.type="button";
    headerRow.append(uploadHeadingNode,uploadCancelNode);uploadHost.append(headerRow);
    const refs=new Map();
    for(const file of list){
      const item=make("div","files-status");
      const nameNode=make("span","file-name",String(file.name??""));
      const sizeNode=make("span",""," · "+(formatBytes(file.size)));
      const stateNode=make("span",""," · "+wlabel("uploadQueued"));
      item.append(nameNode,sizeNode,stateNode);
      const ref={item,stateNode};
      refs.set(file,ref);uploadRefs.push(ref);
      uploadHost.append(item);
    }
    uploadCancelNode.addEventListener("click",()=>{
      cancelUploads();
      uploadCancelNode.disabled=true;
      for(const ref of uploadRefs)ref.stateNode.textContent=" · "+wlabel("uploadCancelled");
    });
    const result=await uploader.run(list,{parentPath:target,onUpdate:updated=>{
      if(generation!==uploadGeneration)return;
      const ref=refs.get(updated.file);
      if(ref){ref.state=updated;ref.stateNode.textContent=" · "+describeUploadItem(updated);}
    }});
    if(generation!==uploadGeneration)return false;
    uploadCancelNode.disabled=true;
    for(const item of result.items){
      const ref=refs.get(item.file);
      if(ref){ref.state=item;ref.stateNode.textContent=" · "+describeUploadItem(item);}
    }
    status.textContent=wlabel("uploadSummary",{done:result.summary.done,failed:result.summary.failed});
    if(result.summary.done>0)await refreshTree();
    return true;
  }
  function pickUpload(parentPath){
    if(!writesEnabled()){status.textContent=wlabel("unavailable");return false;}
    if(!opened||!threadId||!connected||authBlocked)return false;
    pendingUploadTarget={path:typeof parentPath==="string"?parentPath:selectedFolder,threadId,rootRevision:rootRevisionString(),ticket:gate.capture()};
    try{fileInput.value="";}catch{/* Some engines reject file input resets. */}
    fileInput.click?.();
    return true;
  }
  async function refreshTree(){
    if(!opened||!threadId||!connected||authBlocked)return;
    selectedRow=null;
    await loadRoot();
    expandSelectedFolder();
  }
  function expandSelectedFolder(){
    if(!selectedFolder)return;
    let row=null;
    try{row=[...tree.querySelectorAll('[role="treeitem"]')].find(node=>node.dataset?.filePath===selectedFolder);}catch{row=null;}
    if(row&&row.getAttribute("aria-expanded")==="false")row.click?.();
  }

  function openNewFolderDialog(parentPath){
    if(!writesEnabled()||!context||!threadId)return false;
    const parent=typeof parentPath==="string"?parentPath:selectedFolder;
    const dialog=make("dialog","files-dialog");
    const title=make("h2","file-editor-dialog-title",wlabel("newFolderHere"));
    const input=make("input","files-search");input.type="text";input.setAttribute("aria-label",wlabel("folderName"));input.placeholder=wlabel("folderName");
    const errorLine=make("p","files-status");errorLine.setAttribute("role","alert");
    const actions=make("div","files-tabs");
    const createButton=make("button","",wlabel("createFolder"));createButton.type="button";
    const cancelButton=make("button","",wlabel("cancel"));cancelButton.type="button";
    actions.append(createButton,cancelButton);
    dialog.append(title,input,errorLine,actions);
    panel.append(dialog);
    const closeDialog=()=>{try{dialog.close?.();}catch{/* Already closed. */}dialog.remove?.();};
    cancelButton.addEventListener("click",closeDialog);
    dialog.addEventListener("cancel",event=>{event?.preventDefault?.();closeDialog();});
    createButton.addEventListener("click",async()=>{
      const path=targetRelativePath(parent,input.value);
      if(!path){errorLine.textContent=wlabel("invalidName");return;}
      createButton.disabled=true;cancelButton.disabled=true;errorLine.textContent="";
      const ticket=gate.capture();
      try{
        const writeContext=await writeContextFor(parent,ticket.signal);
        const dto=await client.mkdir({contextId:writeContext.contextId,path},ticket.signal);
        if(!gate.current(ticket))return;
        if(!writeOperationSucceeded(dto)){errorLine.textContent=isCollision(dto)?wlabel("uploadExists"):wlabel("createFailed");return;}
        closeDialog();
        const created=wlabel("created",{path});
        status.textContent=created;
        reportFeedback({kind:"info",code:"files.write.created",label:created});
        setSelectedFolder(parent);
        await refreshTree();
      }catch(error){
        if(!gate.current(ticket))return;
        if([401,403].includes(error?.status)){fail(error,ticket);closeDialog();return;}
        errorLine.textContent=isCollision(error)?wlabel("uploadExists"):wlabel("createFailed");
      }finally{
        if(gate.current(ticket)){createButton.disabled=false;cancelButton.disabled=false;}
      }
    });
    if(typeof dialog.showModal==="function")dialog.showModal();else dialog.setAttribute("open","");
    input.focus?.();
    return true;
  }

  newFolderButton.addEventListener("click",()=>openNewFolderDialog(selectedFolder));
  uploadButton.addEventListener("click",()=>pickUpload(selectedFolder));
  fileInput.addEventListener("change",()=>{
    let files=[];
    try{files=Array.from(fileInput.files??[]);}catch{files=[];}
    const picker=pendingUploadTarget;pendingUploadTarget=null;
    try{fileInput.value="";}catch{/* Ignore reset failures. */}
    if(picker&&(!gate.current(picker.ticket)||picker.threadId!==threadId||picker.rootRevision!==rootRevisionString())){
      status.textContent=wlabel("uploadCancelled");return;
    }
    const target=picker?.path??selectedFolder;
    if(files.length)void startUpload(files,target);
  });
  const panelDragOver=createFolderDragOverHandler({enabled:()=>writesEnabled()});
  const panelDrop=createFolderDropHandler({enabled:()=>writesEnabled(),getTarget:()=>selectedFolder,onFiles:(files,target)=>{setSelectedFolder(target);void startUpload(files,target);}});
  tree.addEventListener("dragover",panelDragOver);
  tree.addEventListener("drop",panelDrop);

  tree.addEventListener("keydown",event=>{
    const row=event.target.closest('[role="treeitem"]');if(!row)return;
    if(event.key==="ContextMenu"||(event.shiftKey&&event.key==="F10")){
      event.preventDefault();const entry=row.__entry;
      if(entry)openRowMenu(entry,row,row);
      return;
    }
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
  toggle.addEventListener("click",()=>{if(opened)void closePanel();else show(true);});
  close.addEventListener("click",()=>void closePanel());backdrop.addEventListener("click",()=>void closePanel());
  function doReloadView(){clearTimeout(searchTimer);gate.invalidate();tree.replaceChildren();selectedRow=null;releasePreview();void loadRoot();}
  function guardedReload(blockedMessage){
    if(!fileEditor){doReloadView();return true;}
    void guardEditor().then(ok=>{if(!ok){if(blockedMessage)status.textContent=blockedMessage;return;}disposeEditor();doReloadView();});
    return false;
  }
  allFiles.addEventListener("click",()=>{mode="files";allFiles.setAttribute("aria-pressed","true");artifacts.setAttribute("aria-pressed","false");guardedReload(wlabel("blocked"));});
  artifacts.addEventListener("click",()=>{mode="artifacts";allFiles.setAttribute("aria-pressed","false");artifacts.setAttribute("aria-pressed","true");guardedReload(wlabel("blocked"));});
  search.addEventListener("input",()=>{
    clearTimeout(searchTimer);
    searchTimer=setTimeout(()=>{guardedReload(wlabel("blocked"));},400);
  });
  refresh.addEventListener("click",()=>{authBlocked=false;guardedReload(null);});overlay.addEventListener("change",layout);
  function onDocumentKeydown(event){
    if(!opened||disposed||event.defaultPrevented||event.isComposing||event.keyCode===229)return;
    // Native dialogs occupy the browser top layer above the narrow Files panel.
    // Leave both Escape and Tab to their own modal handlers/focus containment.
    if(doc.querySelector?.("dialog[open]"))return;
    if(event.key==="Escape"){event.preventDefault();void closePanel();return;}
    if(event.key==="Tab"&&overlay.matches){const nodes=[...panel.querySelectorAll('button,a[href],input,textarea,select,[tabindex="0"]')].filter(node=>!node.disabled&&!node.closest('[hidden]'));const first=nodes[0],last=nodes.at(-1);if(event.shiftKey&&doc.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&doc.activeElement===last){event.preventDefault();first?.focus();}}
  }
  doc.addEventListener("keydown",onDocumentKeydown);
  syncWriteUi();
  if(read("codex-files-open")==="true")show(true);
  return {
    setContext(value){
      const key=value?.threadId?`${value.threadId}\0${value.cwdHint||""}`:"";
      if(!gate.change(key))return;
      // A forced project/thread switch keeps the unsaved buffer in RAM only:
      // no autosave, no old-principal content on screen, no localStorage text.
      disposeEditor({capture:true});
      cancelUploads();
      threadId=value?.threadId||"";authBlocked=false;search.value="";selectedFolder="";clear();
      if(opened)void loadRoot();
    },
    setConnected(value){
      if(connected===Boolean(value))return;
      connected=Boolean(value);
      if(!connected){disposeEditor({capture:true});cancelUploads();}
      clear();status.textContent=connected?"":text("disconnected");
      if(connected&&opened&&!authBlocked)void loadRoot();
    },
    setAvailable(value){toggle.disabled=!value;if(!value&&opened)void closePanel();},
    setWriteAvailable(value){writeOverride=Boolean(value);syncWriteUi();},
    hasUnsavedChanges(){try{return Boolean(fileEditor?.hasUnsavedChanges?.());}catch{return false;}},
    beforeContextChange(){return fileEditor?guardEditor():true;},
    refreshLabels(){
      if(disposed)return;
      heading.textContent=text("title");
      refresh.title=text("refresh");refresh.setAttribute("aria-label",text("refresh"));
      close.title=text("close");close.setAttribute("aria-label",text("close"));
      search.placeholder=text("searchNames");search.setAttribute("aria-label",text("searchNames"));
      allFiles.textContent=text("allFiles");artifacts.textContent=text("artifacts");
      resize.setAttribute("aria-label",text("resize"));tree.setAttribute("aria-label",text("tree"));preview.setAttribute("aria-label",text("preview"));
      newFolderButton.textContent=wlabel("newFolder");uploadButton.textContent=wlabel("upload");
      rootTargetButton.textContent=wlabel("rootTarget");
      bufferDownload.textContent=wlabel("bufferDownload");
      fileInput.setAttribute("aria-label",wlabel("upload"));
      if(uploadHeadingNode)uploadHeadingNode.textContent=wlabel("uploadHeading",{count:uploadHeadingCount});
      if(uploadCancelNode)uploadCancelNode.textContent=wlabel("cancelUploads");
      for(const ref of uploadRefs)ref.stateNode.textContent=" · "+describeUploadItem(ref.state??{status:"queued"});
      renderTarget();
      try{fileEditor?.refreshLabels?.();}catch{/* Editor labels are advisory. */}
    },
    getTools(){return opened&&!authBlocked&&!fileEditor?{text:textTools,pdf:pdfViewer}:null;},
    focusTextSearch(){return Boolean(opened&&!authBlocked&&textTools?.focusSearch());},
    focusTextLine(){return Boolean(opened&&!authBlocked&&textTools?.focusLine());},
    focusPdfPage(){return Boolean(opened&&!authBlocked&&pdfViewer?.focusPage());},
    getState(){return {open:opened,selectedFolder,writesEnabled:writesEnabled(),editor:safeEditorState(fileEditor),snapshot:editorSnapshot?{...editorSnapshot}:null};},
    close(){return closePanel();},
    dispose(){
      if(disposed)return;
      disposed=true;
      clearTimeout(searchTimer);
      cancelUploads();
      gate.invalidate();
      releasePreview();
      disposeEditor();
      if(ownsMenu){try{menu?.dispose?.();}catch{/* Already disposed. */}}
      try{doc.removeEventListener("keydown",onDocumentKeydown);}catch{/* Detached document. */}
      try{if(typeof overlay.removeEventListener==="function")overlay.removeEventListener("change",layout);}catch{/* Media query stub. */}
      preview.replaceChildren();tree.replaceChildren();uploadHost.replaceChildren();editorHost.replaceChildren();panel.replaceChildren();
    }
  };
}
