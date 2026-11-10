import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startInteractiveFixture } from "../test-support/interactive-fixture.js";

test("actual file routes require authentication and native scope, and preserve shared engine",{skip:process.platform!=="win32",timeout:45000},async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"cw-route-"));t.after(()=>fs.rm(root,{recursive:true,force:true}));await fs.writeFile(path.join(root,"hello.txt"),"SYNTHETIC ROUTE");
  const fixture=await startInteractiveFixture({projectDir:root});t.after(()=>fixture.close());
  const url=new URL("/api/project-files/tree",fixture.baseUrl);url.searchParams.set("threadId","thread-fixture");
  assert.equal((await fetch(url)).status,401);url.searchParams.set("token",fixture.outsideToken);assert.equal((await fetch(url)).status,403);
  url.searchParams.set("token",fixture.token);const tree=await(await fetch(url)).json();assert.equal(tree.entries[0].name,"hello.txt");
  url.pathname="/api/project-files/preview";url.searchParams.set("path","hello.txt");assert.equal((await fetch(url)).status,400);
  url.searchParams.set("rootRevision",tree.context.rootRevision);assert.equal((await(await fetch(url)).json()).text,"SYNTHETIC ROUTE");
  const browser=await fixture.connect();t.after(()=>browser.close());assert.equal(browser.hello.desktopBridgeConnected,true);
  assert.equal((await browser.rpc("thread/read",{threadId:"thread-fixture",includeTurns:false})).thread.cwd,root);
});
