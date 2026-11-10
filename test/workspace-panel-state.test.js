import test from "node:test";
import assert from "node:assert/strict";
import { FilePanelGate, createWorkspacePanel } from "../public/workspace-panel.js";
import { projectDownloadUrl } from "../public/project-files-client.js";

test("panel invalidates late responses on thread switch, close, auth loss and root change",()=>{
  const gate=new FilePanelGate();gate.change("A");const a=gate.capture();
  gate.change("B");assert.equal(gate.current(a),false);const b=gate.capture();
  gate.invalidate();assert.equal(gate.current(b),false);assert.equal(b.signal.aborted,true);
});

test("controller refresh retains revision; root conflict clears it before explicit reload",async t=>{
  const oldMedia=globalThis.matchMedia;globalThis.matchMedia=()=>({matches:false,addEventListener(){}});t.after(()=>{globalThis.matchMedia=oldMedia;});
  const nodes=[];const doc={activeElement:null,addEventListener(){},createElement(tag){
    const node={tag,ownerDocument:doc,children:[],attrs:{},listeners:{},style:{setProperty(){}},classList:{toggle(){}},setAttribute(k,v){this.attrs[k]=v;},getAttribute(k){return this.attrs[k];},removeAttribute(k){delete this.attrs[k];},append(...items){this.children.push(...items);},replaceChildren(...items){this.children=items;},querySelector(){return null;},querySelectorAll(){return[];},addEventListener(k,fn){this.listeners[k]=fn;},focus(){doc.activeElement=this;},click(){this.listeners.click?.({});}};nodes.push(node);return node;
  }};
  const panel=doc.createElement("aside"),toggle=doc.createElement("button"),shell=doc.createElement("div");
  const calls=[];let conflict=false;
  const client={async get(action,query){calls.push({...query});if(conflict){conflict=false;throw Object.assign(new Error("changed"),{status:409});}return {context:{rootName:"fixture",rootRevision:"R"},entries:[]};}};
  const view=createWorkspacePanel({panel,toggle,shell,client,t:key=>key,document:doc});view.setContext({threadId:"A"});view.setConnected(true);toggle.click();
  await new Promise(resolve=>setImmediate(resolve));assert.equal(calls.at(-1).rootRevision,undefined);
  const refresh=nodes.find(node=>node.attrs["aria-label"]==="files.refresh");refresh.click();await new Promise(resolve=>setImmediate(resolve));assert.equal(calls.at(-1).rootRevision,"R");
  conflict=true;refresh.click();await new Promise(resolve=>setImmediate(resolve));assert.equal(calls.at(-1).rootRevision,"R");
  refresh.click();await new Promise(resolve=>setImmediate(resolve));assert.equal(calls.at(-1).rootRevision,undefined);
});
test("new download links use same-origin Access cookies and never query tokens",()=>{
  const query={threadId:"A",path:"한글.txt",rootRevision:"R"};
  const url=projectDownloadUrl(query,"cloudflare-access","https://example.test");
  assert.equal(new URL(url,"https://example.test").origin,"https://example.test");assert.doesNotMatch(url,/token=/);assert.match(url,/rootRevision=R/);
  assert.equal(projectDownloadUrl(query,"token","https://example.test"),null);
});

test("narrow Files Tab wraps past its hidden resize control and wide keyboard resizing returns",t=>{
  const oldMedia=globalThis.matchMedia,media={matches:true,addEventListener(type,handler){if(type==="change")this.changed=handler;}};
  globalThis.matchMedia=()=>media;t.after(()=>{globalThis.matchMedia=oldMedia;});
  const nodes=[],doc={activeElement:null,listeners:{},addEventListener(type,handler){this.listeners[type]=handler;},querySelector(){return null;},createElement(tag){
    const node={tag,ownerDocument:doc,children:[],attrs:{},listeners:{},style:{setProperty(){}},classList:{toggle(){}},setAttribute(k,v){this.attrs[k]=String(v);},getAttribute(k){return this.attrs[k];},removeAttribute(k){delete this.attrs[k];},append(...items){this.children.push(...items);},replaceChildren(...items){this.children=items;},querySelector(){return null;},querySelectorAll(selector){
      const descendants=this.children.flatMap(child=>[child,...child.querySelectorAll("*")]);
      if(selector==="*")return descendants;
      if(selector==='button,a[href],input,textarea,select,[tabindex="0"]')return descendants.filter(child=>["button","input","textarea","select"].includes(child.tag)||child.tabIndex===0);
      return [];
    },closest(){return null;},addEventListener(type,handler){this.listeners[type]=handler;},focus(){if(!(media.matches&&this.className==="files-resize"))doc.activeElement=this;},click(){this.listeners.click?.({});}};nodes.push(node);return node;
  }};
  const panel=doc.createElement("aside"),toggle=doc.createElement("button"),shell=doc.createElement("div");
  const view=createWorkspacePanel({panel,toggle,shell,client:{},t:key=>key,document:doc});toggle.click();
  const refresh=nodes.find(node=>node.attrs["aria-label"]==="files.refresh"),resize=nodes.find(node=>node.className==="files-resize");
  const preview=nodes.find(node=>node.className==="files-preview"),last=doc.createElement("button");preview.append(last);last.focus();
  let prevented=0;doc.listeners.keydown({key:"Tab",preventDefault(){prevented++;}});
  assert.equal(doc.activeElement,refresh);assert.equal(prevented,1);
  doc.listeners.keydown({key:"Tab",shiftKey:true,preventDefault(){prevented++;}});assert.equal(doc.activeElement,last);assert.equal(prevented,2);
  media.matches=false;media.changed();resize.focus();assert.equal(doc.activeElement,resize);
  resize.listeners.keydown({key:"ArrowLeft",preventDefault(){}});assert.equal(resize.attrs["aria-valuenow"],"404");
  assert.equal(resize.tabIndex,0);
  media.matches=true;media.changed();last.focus();doc.listeners.keydown({key:"Tab",preventDefault(){}});assert.equal(doc.activeElement,refresh);
  view.close();
});
