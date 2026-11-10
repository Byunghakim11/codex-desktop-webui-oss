import test from "node:test";
import assert from "node:assert/strict";
import { pdfPreviewInfo } from "../server/file-preview-policy.js";
import { pdfAsset, pdfAssetRoot } from "../server/pdf-assets.js";
import { boundedPdfViewport, createPdfPreview } from "../public/pdf-preview.js";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createProjectFilesClient } from "../public/project-files-client.js";

test("PDF preview requires signature and bounded bytes; vendor paths cannot traverse",()=>{
  assert.equal(pdfPreviewInfo(Buffer.from("%PDF-1.7\n"),100).mime,"application/pdf");
  assert.equal(pdfPreviewInfo(Buffer.from("<html>fake.pdf"),100),null);assert.equal(pdfPreviewInfo(Buffer.from("%PDF-1.7\n"),26*1048576),null);
  assert.equal(pdfAsset("/vendor/pdfjs/pdf.mjs","C:/package").relative,"build/pdf.min.mjs");
  assert.equal(pdfAsset("/vendor/pdfjs/cmaps/../../auth.json","C:/package"),null);assert.equal(pdfAsset("/vendor/pdfjs/cmaps/%2e%2e.bcmap","C:/package"),null);
});

test("PDF asset selection accepts only the pinned local package",async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"cw-pdf-root-"));t.after(()=>fs.rm(root,{recursive:true,force:true}));const staged=path.join(root,".vendor/pdfjs-dist");await fs.mkdir(staged,{recursive:true});await fs.writeFile(path.join(staged,"package.json"),JSON.stringify({version:"wrong"}));assert.equal(pdfAssetRoot(path.join(root,"modules"),root),null);await fs.writeFile(path.join(staged,"package.json"),JSON.stringify({version:"6.5.438"}));assert.equal(pdfAssetRoot(path.join(root,"modules"),root),staged);
});
test("ticket client normalizes auth redirects and rejects foreign download URLs",async()=>{
  const args={getToken:()=>"SYNTHETIC",getAuthMode:()=>"token"};const redirected=createProjectFilesClient({...args,fetchImpl:async()=>({ok:false,status:0,type:"opaqueredirect"})});await assert.rejects(redirected.downloadTicket({}),e=>e.status===401);
  const foreign=createProjectFilesClient({...args,fetchImpl:async()=>({ok:true,json:async()=>({url:"https://foreign.invalid/download?ticket="+"a".repeat(32)})})});await assert.rejects(foreign.downloadTicket({}));
});

test("closing a loading PDF leaves late document cleanup with its loading task",async()=>{
  let resolveDocument,started,workerDestroyed=0,taskDestroyed=0,lateDestroyed=0;
  const ready=new Promise(resolve=>{started=resolve;}),documentPromise=new Promise(resolve=>{resolveDocument=resolve;});
  const doc={createElement:()=>({textContent:""})},container={ownerDocument:doc,children:[],replaceChildren(...nodes){this.children=nodes;}};
  const lib={GlobalWorkerOptions:{},PDFWorker:class{constructor(){this.promise=Promise.resolve();this.port={};}destroy(){workerDestroyed++;}},getDocument(){started();return {promise:documentPromise,destroy:async()=>{taskDestroyed++;}};}};
  const view=createPdfPreview({container,t:key=>key,loadLibrary:async()=>lib});const pending=view.show(new Blob(["SYNTHETIC"]));await ready;view.destroy();resolveDocument({destroy:async()=>{lateDestroyed++;}});await pending;
  assert.equal(workerDestroyed,1);assert.equal(taskDestroyed,1);assert.equal(lateDestroyed,0);assert.equal(container.children.length,0);
});
test("PDF canvas size stays bounded regardless of document dimensions",()=>{
  const viewport=boundedPdfViewport(100000,100000,500,2);assert.ok(viewport.width*viewport.height<=8000000);assert.ok(viewport.scale>0);
  for(const [width,height]of [[1,1e12],[1e12,1],[0.001,1e9],[1e9,0.001]]){const result=boundedPdfViewport(width,height,500,2);assert.ok(result.width*result.height<=8000000);assert.ok(result.width<=8192&&result.height<=8192);}
});

function pdfControlsFixture({pages=300,features}={}) {
  const doc={activeElement:null,createElement(tag){return {tag,ownerDocument:doc,children:[],attrs:{},dataset:{},style:{},listeners:{},setAttribute(k,v){this.attrs[k]=String(v);},removeAttribute(k){delete this.attrs[k];},append(...nodes){this.children.push(...nodes);},replaceChildren(...nodes){this.children=nodes;},addEventListener(k,fn){(this.listeners[k]??=[]).push(fn);},removeEventListener(k,fn){this.listeners[k]=this.listeners[k]?.filter(x=>x!==fn);},dispatch(k,event={}){for(const fn of this.listeners[k]||[])fn({preventDefault(){},...event});},click(){if(!this.disabled)this.dispatch("click");},focus(){doc.activeElement=this;},getContext(){return {};}};}};
  const container=doc.createElement("section");container.clientWidth=500;
  let delayed=false,cancelled=0,cleaned=0,destroyed=0;const jobs=[],pageRequests=new Map();
  const loaded={numPages:pages,async getPage(number){if(pageRequests.has(number))await pageRequests.get(number);return {getViewport:({scale})=>({width:600*scale,height:800*scale}),cleanup(){cleaned++;},render({canvas,intent,annotationMode}){let resolve,reject;const promise=delayed?new Promise((done,fail)=>{resolve=done;reject=fail;}):Promise.resolve();const job={number,canvas,intent,annotationMode,resolve:()=>resolve?.(),reject:()=>reject?.(new Error("Obsolete renderer failure")),promise,cancel(){cancelled++;}};jobs.push(job);return job;}};},async destroy(){destroyed++;}};
  const lib={GlobalWorkerOptions:{},AnnotationMode:{DISABLE:0},PDFWorker:class{constructor(){this.promise=Promise.resolve();this.port={};}destroy(){destroyed++;}},getDocument(){return {promise:Promise.resolve(loaded),destroy:async()=>{destroyed++;}};}};
  const view=createPdfPreview({container,t:key=>key,loadLibrary:async()=>lib,features});
  const flatten=node=>[node,...node.children.flatMap(flatten)];
  return {view,container,doc,jobs,delay(){delayed=true;},blockPage(number){let reject;pageRequests.set(number,new Promise((_,fail)=>{reject=fail;}));return ()=>reject(new Error("Obsolete getPage failure"));},find(label){return flatten(container).find(node=>node.attrs["aria-label"]===label);},get cancelled(){return cancelled;},get cleaned(){return cleaned;},get destroyed(){return destroyed;}};
}

test("PDF feature rollback keeps previous/next and disables page/zoom actions",async()=>{
  const f=pdfControlsFixture({pages:2,features:{F13:false}}),view=f.view;
  await view.show(new Blob(["synthetic"]));
  assert.equal(view.focusPage(),false);assert.equal(view.setView({page:2}),false);
  const toolbar=f.container.children[0];assert.equal(toolbar.children.some(x=>x.tag==="input"),false);
  toolbar.children.at(-1).click();await new Promise(resolve=>setImmediate(resolve));assert.equal(view.getState().page,2);view.destroy();
});
const pdfTick=()=>new Promise(resolve=>setImmediate(resolve));

test("canvas PDF viewer declares static print intent for initial, resize, page and zoom renders",async t=>{
  const originalObserver=globalThis.ResizeObserver;let resized;
  globalThis.ResizeObserver=class{constructor(callback){resized=callback;}observe(){}disconnect(){}};t.after(()=>{globalThis.ResizeObserver=originalObserver;});
  const f=pdfControlsFixture({pages:2});t.after(()=>f.view.destroy());await f.view.show(new Blob(["fixture"]));
  assert.equal(f.jobs[0].intent,"print");assert.equal(f.jobs[0].annotationMode,0);
  assert.equal(f.container.children.some(node=>node.textContent==="Print preview"),true);
  f.container.clientWidth=485;resized();await new Promise(resolve=>setTimeout(resolve,80));
  assert.equal(f.jobs.length,2);assert.equal(f.jobs.at(-1).intent,"print");assert.equal(f.jobs.at(-1).annotationMode,0);
  f.view.setView({page:2,zoom:150});await pdfTick();
  assert.equal(f.jobs.at(-1).intent,"print");assert.equal(f.jobs.at(-1).annotationMode,0);
  assert.notEqual(f.jobs[0].canvas,f.jobs.at(-1).canvas);assert.equal(f.view.getState().page,2);assert.equal(f.view.getState().zoom,150);
});

test("PDF direct pages and zoom validate bounds and synchronize navigation",async t=>{
  const f=pdfControlsFixture();t.after(()=>f.view.destroy());assert.equal(f.view.focusPage?.(),false);
  await f.view.show(new Blob(["fixture"]));assert.equal(typeof f.view.setView,"function");
  assert.equal(f.view.getState().pageCount,200);assert.equal(f.view.focusPage(),true);assert.equal(f.doc.activeElement,f.find("PDF 페이지 번호"));
  for(const page of [0,-1,201,1.5,NaN])assert.equal(f.view.setView({page}),false);
  assert.equal(f.view.getState().page,1);
  f.view.setView({page:200,zoom:200});await pdfTick();assert.equal(f.view.getState().page,200);assert.equal(f.view.getState().zoom,200);
  assert.equal(f.find("다음 페이지").disabled,true);assert.equal(f.find("이전 페이지").disabled,false);
  f.find("이전 페이지").click();await pdfTick();assert.equal(f.view.getState().page,199);
  for(const zoom of [49,201,Infinity,NaN])assert.equal(f.view.setView({zoom}),false);
  const page=f.find("PDF 페이지 번호");page.value="abc";page.dispatch("keydown",{key:"Enter"});assert.equal(page.attrs["aria-invalid"],"true");assert.equal(f.view.getState().page,199);
  page.value="3";page.dispatch("keydown",{key:"Enter"});await pdfTick();assert.equal(f.view.getState().page,3);assert.equal(page.attrs["aria-invalid"],undefined);
  f.find("너비 맞춤").click();await pdfTick();assert.equal(f.view.getState().zoom,100);assert.equal(f.view.getState().fitWidth,true);
  f.view.destroy();assert.equal(f.view.setView({page:1}),false);assert.equal(f.view.focusPage(),false);assert.equal(f.view.getState(),null);
});

test("obsolete PDF canvases cannot replace the latest page after rapid controls or abort",async()=>{
  const f=pdfControlsFixture({pages:5}),abort=new AbortController();await f.view.show(new Blob(["fixture"]),abort.signal);f.delay();
  f.view.setView({page:2});await pdfTick();const older=f.jobs.at(-1);
  f.view.setView({page:3,zoom:150});await pdfTick();const latest=f.jobs.at(-1);latest.resolve();await pdfTick();
  assert.equal(f.container.children.at(-1).children[0],latest.canvas);older.resolve();await pdfTick();assert.equal(f.container.children.at(-1).children[0],latest.canvas);assert.ok(f.cancelled>=1);
  f.view.setView({page:4});await pdfTick();const closing=f.jobs.at(-1);abort.abort();closing.resolve();await pdfTick();
  assert.equal(f.container.children.length,0);assert.equal(f.view.getState(),null);assert.ok(f.cleaned>=3);assert.ok(f.destroyed>=2);
});

test("an obsolete PDF render rejection cannot fail or destroy the current page",async t=>{
  const f=pdfControlsFixture({pages:5});t.after(()=>f.view.destroy());await f.view.show(new Blob(["fixture"]));f.delay();
  f.view.setView({page:2});await pdfTick();const older=f.jobs.at(-1);
  f.view.setView({page:3});await pdfTick();const latest=f.jobs.at(-1);latest.resolve();await pdfTick();older.reject();await pdfTick();
  assert.equal(f.view.getState().page,3);assert.equal(f.container.children.at(-1).children[0],latest.canvas);assert.equal(f.destroyed,0);
});

test("an obsolete getPage rejection cannot destroy a newer PDF view",async t=>{
  const f=pdfControlsFixture({pages:5});t.after(()=>f.view.destroy());await f.view.show(new Blob(["fixture"]));const rejectOld=f.blockPage(2);
  f.view.setView({page:2});await pdfTick();f.view.setView({page:3});await pdfTick();rejectOld();await pdfTick();
  assert.equal(f.view.getState().page,3);assert.equal(f.container.children.at(-1).children[0].dataset.page,"3");assert.equal(f.destroyed,0);
});

test("zoomed PDF viewport keeps pixel and axis limits and reports capped resolution",()=>{
  const result=boundedPdfViewport(100000,100000,10000,2,200);assert.ok(result.width*result.height<=8000000);assert.ok(result.width<=8192&&result.height<=8192);assert.equal(result.limited,true);
  assert.throws(()=>boundedPdfViewport(600,800,500,1,201));assert.throws(()=>boundedPdfViewport(600,800,500,1,0));
});
