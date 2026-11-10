import test from "node:test";
import assert from "node:assert/strict";
import { createTextPreviewTools } from "../public/file-preview-tools.js";
import { createWorkspacePanel } from "../public/workspace-panel.js";

// Small DOM boundary double: textContent never parses HTML and events remain explicit.
function fixture() {
  const doc={activeElement:null,listeners:{},addEventListener(k,fn){this.listeners[k]=fn;},querySelector(){return this.modal||null;},createElement(tag){return new Element(tag);},createTextNode(value){return {textContent:String(value)};}};
  class Element {
    constructor(tag){this.tag=tag;this.ownerDocument=doc;this.children=[];this.attrs={};this.dataset={};this.listeners={};this.style={setProperty(){}};this.classList={toggle(){}};this.value="";}
    set textContent(value){this.children=[];this.content=String(value);} get textContent(){return this.children.length?this.children.map(x=>x.textContent).join(""):this.content||"";}
    append(...items){this.children.push(...items);for(const node of items)node.parentElement=this;}
    replaceChildren(...items){this.children=[];this.content="";this.append(...items);}
    setAttribute(k,v){this.attrs[k]=String(v);} getAttribute(k){return this.attrs[k];} removeAttribute(k){delete this.attrs[k];}
    addEventListener(k,fn){(this.listeners[k]??=[]).push(fn);} removeEventListener(k,fn){this.listeners[k]=this.listeners[k]?.filter(x=>x!==fn);}
    dispatch(k,event={}){for(const fn of this.listeners[k]||[])fn({target:this,preventDefault(){},...event});}
    click(){if(!this.disabled)this.dispatch("click");} focus(){doc.activeElement=this;} scrollIntoView(){this.scrolled=true;}
    contains(node){return node===this||this.children.some(x=>x.contains?.(node));}
    querySelectorAll(selector){const all=this.children.flatMap(x=>x instanceof Element?[x,...x.querySelectorAll("*")]:[]);if(selector==="*")return all;if(selector==='[aria-selected="true"]')return all.filter(x=>x.attrs["aria-selected"]==="true");if(selector==='[role="treeitem"]')return all.filter(x=>x.attrs.role==="treeitem");return [];}
    querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
    get firstChild(){return this.children[0];} get childNodes(){return this.children;}
  }
  const container=doc.createElement("section");
  const find=label=>container.querySelectorAll("*").find(x=>x.attrs["aria-label"]===label);
  return {doc,container,find};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test("individual text feature rollback removes controls and rejects focus actions",()=>{
  const f=fixture(),tools=createTextPreviewTools({document:f.doc,container:f.container,text:"a\nb",features:{F11:false}});
  assert.equal(tools.focusSearch(),false);assert.equal(f.find("본문 검색"),undefined);assert.equal(tools.focusLine(),true);
  const other=fixture(),searchOnly=createTextPreviewTools({document:other.doc,container:other.container,text:"a\nb",features:{F12:false}});
  assert.equal(searchOnly.focusLine(),false);assert.equal(other.find("줄로 이동"),undefined);assert.equal(searchOnly.focusSearch(),true);
  assert.equal(other.container.querySelectorAll("*").some(x=>x.className==="file-line-numbers"),false);
});

test("body search uses literal loaded text, cycles results and never injects markup",()=>{
  const f=fixture(),raw="<img src=x onerror=alert(1)>\r\nneedle\r\n\r\nneedle\n";
  const tools=createTextPreviewTools({document:f.doc,container:f.container,text:raw,truncated:true});
  assert.equal(tools.focusSearch(),true);const search=f.find("본문 검색");assert.equal(f.doc.activeElement,search);
  search.value="needle";search.dispatch("input");assert.equal(f.find("검색 결과").textContent,"1 / 2");
  f.find("다음 일치").click();assert.equal(f.find("검색 결과").textContent,"2 / 2");
  f.find("다음 일치").click();assert.equal(f.find("검색 결과").textContent,"1 / 2");
  f.find("이전 일치").click();assert.equal(f.find("검색 결과").textContent,"2 / 2");
  const body=f.container.querySelectorAll("*").find(x=>x.className==="file-text");assert.equal(body.textContent,raw);
  search.value=".*";search.dispatch("input");assert.equal(f.find("검색 결과").textContent,"0 / 0");
  assert.ok(f.container.textContent.includes("현재 로드된 부분만 검색"));assert.equal(f.container.querySelectorAll("*").some(x=>x.tag==="img"),false);
  tools.dispose();assert.equal(tools.focusSearch(),false);assert.equal(tools.focusLine(),false);
  search.value="needle";search.dispatch("input");assert.equal(f.container.children.length,0);
});

test("line numbers include CRLF, empty and trailing lines; jump rejects non-integers",()=>{
  const f=fixture(),tools=createTextPreviewTools({document:f.doc,container:f.container,text:"a\r\n\r\nb\n",firstLine:10});
  const gutter=f.container.querySelectorAll("*").find(x=>x.className==="file-line-numbers");assert.equal(gutter.textContent,"10\n11\n12\n13");assert.equal(gutter.style.userSelect,"none");
  tools.focusLine();const line=f.find("줄로 이동");assert.equal(f.doc.activeElement,line);
  for(const value of ["0","-1","14","10.5","abc",""]){line.value=value;line.dispatch("keydown",{key:"Enter"});assert.equal(line.attrs["aria-invalid"],"true");}
  line.value="12";line.dispatch("keydown",{key:"Enter"});assert.equal(line.attrs["aria-invalid"],undefined);
  assert.equal(f.container.querySelectorAll("*").find(x=>x.tag==="mark").textContent,"b");
  assert.ok(f.container.querySelectorAll("*").find(x=>x.tag==="mark").scrolled);
  tools.dispose();
});

test("huge text keeps bounded DOM while reaching the last loaded line",()=>{
  const f=fixture(),raw="x\n".repeat(20000),tools=createTextPreviewTools({document:f.doc,container:f.container,text:raw,firstLine:null});
  assert.ok(f.container.querySelectorAll("*").length<40);assert.ok(f.container.textContent.includes("파일 시작 위치 미확인"));
  const line=f.find("줄로 이동");line.value="20001";f.find("이동").click();assert.equal(line.attrs["aria-invalid"],undefined);
  assert.ok(f.container.querySelectorAll("*").length<40);tools.dispose();
});

test("workspace text tools expire on close and native dialogs consume Escape first",async t=>{
  const old=globalThis.matchMedia;globalThis.matchMedia=()=>({matches:false,addEventListener(){}});t.after(()=>{globalThis.matchMedia=old;});
  const navigatorDescriptor=Object.getOwnPropertyDescriptor(globalThis,"navigator"),copies=[];Object.defineProperty(globalThis,"navigator",{configurable:true,value:{clipboard:{writeText:async value=>{copies.push(value);}}}});t.after(()=>{if(navigatorDescriptor)Object.defineProperty(globalThis,"navigator",navigatorDescriptor);else delete globalThis.navigator;});
  const f=fixture(),panel=f.container,toggle=f.doc.createElement("button"),shell=f.doc.createElement("div");let reads=0;
  const client={async get(){reads++;return {context:{rootName:"fixture",rootRevision:"R"},entries:[{path:"body.txt",name:"body.txt",kind:"file"}]};},async openPreview(){reads++;return {kind:"text",text:"body-only needle\n",size:18,downloadAllowed:false};},downloadUrl(){return null;}};
  const view=createWorkspacePanel({panel,toggle,shell,client,t:key=>key,document:f.doc});view.setContext({threadId:"A"});view.setConnected(true);toggle.click();await tick();
  panel.querySelectorAll('[role="treeitem"]')[0].click();await tick();assert.equal(view.focusTextSearch(),true);const prior=reads;
  const search=f.find("본문 검색");search.value="needle";search.dispatch("input");assert.equal(reads,prior);
  const copy=panel.querySelectorAll("*").find(node=>node.className==="file-copy");copy.click();await tick();assert.deepEqual(copies,["body-only needle\n"]);
  f.doc.modal={};f.doc.listeners.keydown({key:"Escape",preventDefault(){throw new Error("Files consumed a modal Escape");}});assert.equal(view.focusTextSearch(),true);
  f.doc.modal=null;view.close();assert.equal(view.focusTextSearch(),false);assert.equal(view.focusTextLine(),false);assert.equal(view.focusPdfPage(),false);
  copy.click();assert.equal(copies.length,1);
});
