import test from "node:test";
import assert from "node:assert/strict";
import { COMPANION_DEFAULTS, createCompanionApps } from "../public/companion-apps.js";

function fixture(saved = null) {
  const doc={activeElement:null,listeners:{},createElement(tag){return new Element(tag);},addEventListener(type,handler){(this.listeners[type]??=[]).push(handler);},fire(type,event={}){const value={preventDefault(){this.defaultPrevented=true;},...event};for(const handler of this.listeners[type]||[])handler(value);return value;}};
  class Element {
    constructor(tag){this.tag=tag;this.children=[];this.attrs={};this.listeners={};this.value="";this.navigations=0;}
    append(...nodes){this.children.push(...nodes);}
    setAttribute(key,value){this.attrs[key]=String(value);} removeAttribute(key){delete this.attrs[key];}
    addEventListener(type,handler){(this.listeners[type]??=[]).push(handler);}
    fire(type,event={}){const value={target:this,preventDefault(){this.defaultPrevented=true;},...event};for(const handler of this.listeners[type]||[])handler(value);return value;}
    click(){const event=this.fire("click");if(this.href&&!event.defaultPrevented)this.navigations++;}
    focus(){doc.activeElement=this;}
    contains(target){return this===target||this.children.some(child=>child.contains?.(target));}
    closest(){return null;}
    all(tag){return this.children.flatMap(child=>[...(child.tag===tag?[child]:[]),...child.all(tag)]);}
    get href(){return this.attrs.href;}set href(value){this.attrs.href=value;}
  }
  const container=doc.createElement("section"),values=new Map(saved===null?[]:[["codex-companion-urls",JSON.stringify(saved)]]);
  const previous=Object.getOwnPropertyDescriptor(globalThis,"localStorage");
  Object.defineProperty(globalThis,"localStorage",{configurable:true,value:{getItem:key=>values.get(key)||null,setItem:(key,value)=>values.set(key,value)}});
  return {doc,container,values,start:()=>createCompanionApps({container,document:doc,t:key=>key}),restore(){if(previous)Object.defineProperty(globalThis,"localStorage",previous);else delete globalThis.localStorage;}};
}

test("public companion defaults are empty and unconfigured shortcuts never navigate",()=>{
  assert.deepEqual(COMPANION_DEFAULTS,{mirror:"",hermes:""});
  const f=fixture();try{const apps=f.start(),links=f.container.all("a"),inputs=f.container.all("input");
    assert.deepEqual(apps.urls,COMPANION_DEFAULTS);assert.equal(inputs.length,2);assert.equal(links.length,2);
    for(const [index,link]of links.entries()){
      assert.equal(link.href,undefined);assert.equal(link.attrs["aria-disabled"],"true");link.click();assert.equal(link.navigations,0);assert.equal(f.doc.activeElement,inputs[index]);
      f.doc.fire("keydown",{altKey:true,key:String(index+2),target:f.container});assert.equal(f.doc.activeElement,inputs[index]);assert.equal(link.navigations,0);
    }
  }finally{f.restore();}
});
test("both companion URLs can be configured and cleared with local-only allowlisted preferences",()=>{
  const f=fixture();try{const apps=f.start(),inputs=f.container.all("input"),links=f.container.all("a"),form=f.container.all("form")[0];
    const urls=["https://example.com/mirror","https://example.com/hermes"];
    inputs.forEach((input,index)=>{input.value=urls[index];});form.fire("submit");
    assert.deepEqual(Object.values(apps.urls),urls);assert.deepEqual(Object.values(JSON.parse(f.values.get("codex-companion-urls"))),urls);
    links.forEach((link,index)=>{assert.equal(link.href,urls[index]);assert.equal(link.attrs["aria-disabled"],undefined);});
    inputs.forEach(input=>{input.value="";});form.fire("submit");
    assert.deepEqual(apps.urls,COMPANION_DEFAULTS);assert.deepEqual(JSON.parse(f.values.get("codex-companion-urls")),COMPANION_DEFAULTS);
    links.forEach(link=>{assert.equal(link.href,undefined);assert.equal(link.attrs["aria-disabled"],"true");});
  }finally{f.restore();}
});
test("invalid fields cannot partially save or re-enable unsafe stored URLs",()=>{
  const f=fixture({mirror:"https://example.com/?token=synthetic",hermes:"https://example.com/old",extra:"unused"});
  try{const apps=f.start(),inputs=f.container.all("input"),form=f.container.all("form")[0];
    assert.deepEqual(apps.urls,{mirror:"",hermes:"https://example.com/old"});
    inputs[0].value="https://example.com/new";inputs[1].value="https://user:pass@example.com";form.fire("submit");
    assert.equal(apps.urls.mirror,"");assert.equal(apps.urls.hermes,"https://example.com/old");assert.equal(inputs[1].attrs["aria-invalid"],"true");
  }finally{f.restore();}
});
