// Manual/browser QA only. Own isolated fake engine, temporary data and port.
// No real Codex credentials, chats, commands, files, or permission grants.
import readline from "node:readline";
import fs from "node:fs";
import { startInteractiveFixture } from "./interactive-fixture.js";

const fixture = await startInteractiveFixture();
const statePath = ".superpowers/sdd/2026-11-09-core-interaction-parity/browser-fixture.json";
fs.mkdirSync(".superpowers/sdd/2026-11-09-core-interaction-parity", { recursive: true });
fs.writeFileSync(statePath, JSON.stringify({ baseUrl: fixture.baseUrl, token: fixture.token, port: fixture.port, synthetic: true }, null, 2));
console.log(JSON.stringify({ ready: true, port: fixture.port, statePath, synthetic: true }));
let nextId = 1000;
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", async command => {
  try {
    if (command.trim() === "quit") { rl.close(); await fixture.close(); return; }
    const id = nextId++;
    const kind = command.trim();
    const common = { itemId: `item-${id}`, turnId: "turn-fixture" };
    if (kind === "question") {
      await fixture.trigger({ id, method: "item/tool/requestUserInput", params: { ...common, isBlocking: false, questions: [{ id: "choice", header: "Fixture choice", question: "Synthetic question: choose or enter an answer", isOther: true, options: [{ label: "Option A", description: "Synthetic option" }] }] } });
    } else if (kind === "secret") {
      await fixture.trigger({ id, method: "item/tool/requestUserInput", params: { ...common, isBlocking: true, questions: [{ id: "secret", header: "Fixture secret", question: "Synthetic secret input (test value only)", isSecret: true }] } });
    } else if (kind === "permissions") {
      await fixture.trigger({ id, method: "item/permissions/requestApproval", params: { ...common, cwd: fixture.rootDir, reason: "Synthetic test only — grants affect only the fake engine", permissions: { network: { enabled: true }, fileSystem: { read: [fixture.rootDir] } } } });
    } else if (kind === "form") {
      await fixture.trigger({ id, method: "mcpServer/elicitation/request", params: { ...common, serverName: "synthetic-fixture", mode: "form", message: "Synthetic MCP form", requestedSchema: { type: "object", properties: { name: { type: "string", title: "Fixture name", minLength: 2 }, ready: { type: "boolean", title: "Fixture ready" } }, required: ["name", "ready"], additionalProperties: false } } });
    } else if (kind === "approval") {
      await fixture.trigger({ id, method: "item/commandExecution/requestApproval", params: { ...common, command: "echo SYNTHETIC_ONLY", cwd: fixture.rootDir, reason: "No command is executed by this fake engine", availableDecisions: ["accept", "decline", "cancel"] } });
    } else if (kind === "network") {
      await fixture.trigger({ id, method: "item/commandExecution/requestApproval", params: { ...common, command: null, networkApprovalContext: { host: "example.test", protocol: "https" }, reason: "Synthetic network prompt — no connection is made" } });
    } else if (kind === "file") {
      await fixture.notify("item/fileChange/patchUpdated", { threadId: "thread-fixture", ...common, changes: [{ path: "C:/synthetic-fixture/demo.txt", kind: { type: "update", move_path: "C:/synthetic-fixture/renamed.txt" }, diff: "@@ -1 +1 @@\n-old synthetic text\n+new synthetic text" }] });
      await fixture.trigger({ id, method: "item/fileChange/requestApproval", params: common });
    } else if (kind === "fallback") {
      await fixture.trigger({ id, method: "mcpServer/elicitation/request", params: { ...common, serverName: "synthetic-fixture", mode: "openai/userVerification", challenge: "DO_NOT_RENDER_THIS_CHALLENGE" } });
    } else { console.log(JSON.stringify({ error: "Unknown fixture command" })); return; }
    console.log(JSON.stringify({ issued: kind, id }));
    const response = await fixture.nextResponse(id, 180000);
    const summary = { answered: kind, id, decision: response.result.decision || response.result.action || null, answerCount: Object.keys(response.result.answers || {}).length, permissionKeys: Object.keys(response.result.permissions || {}) };
    fs.appendFileSync(".superpowers/sdd/2026-11-09-core-interaction-parity/browser-results.jsonl", JSON.stringify(summary) + "\n");
    console.log(JSON.stringify(summary));
  } catch (error) { console.log(JSON.stringify({ error: error.message })); }
});
process.once("SIGINT", async () => { await fixture.close(); process.exit(0); });
