// Manual browser QA; fake engine, temporary project/data and an ephemeral port only.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { startInteractiveFixture } from "./interactive-fixture.js";
import { syntheticPdf } from "./synthetic-pdf.js";
const root = await fs.mkdtemp(path.join(os.tmpdir(), "cw-workflow-"));
await fs.writeFile(path.join(root, "README.md"), "# Synthetic workflow project\r\nBody-only phrase 한국어 [a+b]?\r\n\r\nSecond body-only phrase 한국어 [a+b]?\r\n<script>INERT_ONLY</script>\r\n");
await fs.writeFile(path.join(root, "preview.pdf"), syntheticPdf());
const fixture = await startInteractiveFixture({ projectDir: root, workflowFixture: true });
const statePath = path.join(fixture.dataDir, "workflow-browser-state.json");
await fs.writeFile(statePath, JSON.stringify({ baseUrl: fixture.baseUrl, token: fixture.token, root, dataDir: fixture.dataDir, synthetic: true }, null, 2));
console.log(JSON.stringify({ ready: true, port: fixture.port, statePath, synthetic: true }));
let closed = false;
async function close() {
  if (closed) return; closed = true;
  await fixture.close();
  const resolved = path.resolve(root);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith("cw-workflow-")) throw new Error("Unsafe fixture cleanup");
  await fs.rm(resolved, { recursive: true, force: true });
}
const lines = readline.createInterface({ input: process.stdin });
let lastStream=null,streamSerial=0;
lines.on("line", async value => {
  if (value.trim() === "quit") { lines.close(); await close(); }
  else if (value.trim() === "append") await fixture.notify("item/completed", { threadId: "thread-fixture", turnId: "A-turn", item: { id: "A-appended", type: "agentMessage", phase: "final_answer", text: "Appended synthetic 한국어 message" } });
  else if (["stream-commentary","stream-async","stream-unknown","stream-final","stream-unclassified","stream-late-commentary"].includes(value.trim())) {
    const command=value.trim(),kind=command.slice(7),id=`A-live-${++streamSerial}`,turnId=`A-live-turn-${streamSerial}`;
    const metadata=kind==="async"?{delivery:"async",questions:[{title:"STREAM_NATIVE_QUESTION_SENTINEL",options:["Synthetic only"]}]}:{phase:kind==="final"?"final_answer":kind.includes("commentary")?"commentary":"unknown"};
    const text=`STREAM_${kind.toUpperCase().replaceAll("-","_")}_SENTINEL 한국어\n\n\`\`\`js\n  const synthetic = true;\n\`\`\``;
    lastStream={id,turnId,text,metadata};
    await fixture.notify("turn/started",{threadId:"thread-fixture",turn:{id:turnId,status:"inProgress"}});
    if(!["unclassified","late-commentary"].includes(kind))await fixture.notify("item/started",{threadId:"thread-fixture",turnId,item:{id,type:"agentMessage",text:"",...metadata}});
    await fixture.notify("item/agentMessage/delta",{threadId:"thread-fixture",turnId,itemId:id,delta:text});
    if(kind==="late-commentary")await fixture.notify("item/started",{threadId:"thread-fixture",turnId,item:{id,type:"agentMessage",text:"",...metadata}});
    console.log(JSON.stringify({issued:command,itemId:id,synthetic:true}));
  } else if(lastStream&&["stream-more","stream-finish","stream-classify-final","stream-terminal"].includes(value.trim())) {
    const command=value.trim(),{id,turnId}=lastStream;
    if(command==="stream-more"){const delta="\nCLICK_SNAPSHOT_LATER_DELTA";lastStream.text+=delta;await fixture.notify("item/agentMessage/delta",{threadId:"thread-fixture",turnId,itemId:id,delta});}
    else if(command==="stream-terminal")await fixture.notify("turn/completed",{threadId:"thread-fixture",turn:{id:turnId,status:"completed"}});
    else await fixture.notify("item/completed",{threadId:"thread-fixture",turnId,item:{id,type:"agentMessage",text:lastStream.text,...(command==="stream-classify-final"?{phase:"final_answer"}:lastStream.metadata)}});
    console.log(JSON.stringify({issued:command,itemId:id,synthetic:true}));
  }
});
process.once("SIGINT", async () => { await close(); process.exit(0); });
