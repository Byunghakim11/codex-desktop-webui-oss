// Isolated browser QA. Only synthetic project contents and a fake engine.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { startInteractiveFixture } from "./interactive-fixture.js";
import { syntheticPdf } from "./synthetic-pdf.js";
const root=await fs.mkdtemp(path.join(os.tmpdir(),"cw-panel-"));
await fs.mkdir(path.join(root,"src"));await fs.mkdir(path.join(root,"images"));
await fs.writeFile(path.join(root,"README.md"),"# Synthetic project\n\nRead-only file panel preview.\n한국어 파일 확인\n\n<script>alert('must remain text')</script>\n");
await fs.writeFile(path.join(root,"src","hello.js"),"export const message = 'Synthetic fixture only';\n");
await fs.writeFile(path.join(root,".env"),"SYNTHETIC_SECRET_DO_NOT_LIST");
await fs.writeFile(path.join(root,"drawing.svg"),"<svg xmlns='http://www.w3.org/2000/svg'><script>throw 1</script></svg>");
await fs.writeFile(path.join(root,"images","pixel.png"),Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aIZkAAAAASUVORK5CYII=","base64"));
await fs.writeFile(path.join(root,"preview.pdf"),syntheticPdf());
const fixture=await startInteractiveFixture({projectDir:root,nativeChanges:["README.md","preview.pdf"],threadListDelayMs:Number(process.env.PERF_MANIFEST_DELAY_MS)||0});
await fs.mkdir(".superpowers/sdd/2026-11-09-file-panel-implementation",{recursive:true});
await fs.writeFile(".superpowers/sdd/2026-11-09-file-panel-implementation/browser.json",JSON.stringify({baseUrl:fixture.baseUrl,token:fixture.token,root,synthetic:true},null,2));
console.log(JSON.stringify({ready:true,port:fixture.port,synthetic:true}));
let closed=false;async function close(){if(closed)return;closed=true;await fixture.close();if(path.dirname(root)!==os.tmpdir()||!path.basename(root).startsWith("cw-panel-"))throw new Error("Unsafe cleanup");await fs.rm(root,{recursive:true,force:true});}
const lines=readline.createInterface({input:process.stdin});lines.on("line",async value=>{if(value.trim()==="quit"){lines.close();await close();}});process.once("SIGINT",async()=>{await close();process.exit(0);});
