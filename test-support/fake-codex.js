import readline from "node:readline";
import { workflowFixtureTurns } from "./workflow-fixture-data.js";

const args = process.argv.slice(2);
if (process.env.FAKE_CODEX_CAPTURE_ARGS === "1" || !args.includes("app-server")) {
  process.stdout.write(`${JSON.stringify({
    args,
    environment: {
      codexHome: process.env.CODEX_HOME || null,
      sqliteHome: process.env.CODEX_SQLITE_HOME || null
    }
  })}\n`);
  process.stderr.write("fake-codex-stderr\n");
  process.exitCode = 23;
} else {
  const queuedByThread = new Map();
  const pendingServerIds = new Set();
  const workflowFixture = process.env.FAKE_CODEX_WORKFLOW_FIXTURE === "1";
  const fixtureThread = id => ({ id, name: workflowFixture ? `Workflow ${id === "thread-workflow-b" ? "B" : "A"} — synthetic only` : "Synthetic browser test — no real permissions", preview: "Isolated fixture", cwd: process.env.FAKE_CODEX_PROJECT_DIR || process.cwd(), turns: [], status: { type: "idle" }, createdAt: 1, updatedAt: 1 });
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      reply(message.id, { server: "fake" });
      return;
    }
    if (message.method === "echo") {
      reply(message.id, { params: message.params });
      return;
    }
    if (message.method === "thread/read") {
      reply(message.id, { thread: process.env.FAKE_CODEX_P0_BROWSER === "1" ? fixtureThread(message.params.threadId) : { id: message.params.threadId, cwd: process.cwd(), turns: [] } });
      return;
    }
    if (message.method === "thread/list" && process.env.FAKE_CODEX_P0_BROWSER === "1") {
      const delay=Math.min(10000,Number(process.env.FAKE_CODEX_THREAD_LIST_DELAY_MS)||0);
      const result={data:[fixtureThread("thread-fixture"),...(workflowFixture?[fixtureThread("thread-workflow-b")]:[]),...(delay?[{...fixtureThread("manifest-only"),name:"Manifest arrived"}]:[])],nextCursor:null};
      if(delay)setTimeout(()=>reply(message.id,result),delay);else reply(message.id,result);return;
    }
    if (message.method === "thread/turns/list" && process.env.FAKE_CODEX_P0_BROWSER === "1") {
      if (workflowFixture) { reply(message.id, { data: workflowFixtureTurns(message.params.threadId), nextCursor: null }); return; }
      const changes=JSON.parse(process.env.FAKE_CODEX_CHANGE_PATHS||"[]");if(changes.length){reply(message.id,{data:[{id:"synthetic-turn",status:"completed",items:[{id:"synthetic-file",type:"fileChange",status:"completed",changes:changes.map(path=>({path,kind:{type:"update"},diff:"+synthetic fixture"}))}]}],nextCursor:null});return;}
      reply(message.id, { data: [], nextCursor: null }); return;
    }
    if (message.method === "account/read" && process.env.FAKE_CODEX_P0_BROWSER === "1") {
      reply(message.id, { account: { type: "chatgpt", email: "synthetic@example.invalid", planType: "pro" }, requiresOpenaiAuth: false }); return;
    }
    if (message.method === "account/rateLimits/read" && process.env.FAKE_CODEX_P0_BROWSER === "1") {
      reply(message.id, { rateLimits: {} }); return;
    }
    if (message.method === "model/list") {
      reply(message.id, {
        data: [{
          id: "gpt-test",
          model: "gpt-test",
          displayName: "GPT Test",
          supportedReasoningEfforts: [
            { reasoningEffort: "medium", description: "Balanced" },
            { reasoningEffort: "high", description: "Deep" }
          ],
          defaultReasoningEffort: "medium",
          isDefault: true
        }],
        nextCursor: null
      });
      return;
    }
    if (message.method === "permissionProfile/list") {
      reply(message.id, {
        data: [
          { id: ":read-only", allowed: true, description: null },
          { id: ":workspace", allowed: true, description: null },
          { id: ":danger-full-access", allowed: true, description: null }
        ],
        nextCursor: null
      });
      return;
    }
    if (message.method === "configRequirements/read") {
      reply(message.id, { requirements: null });
      return;
    }
    if (message.method === "thread/start") {
      const threadId = "thread-created-on-phone";
      reply(message.id, {
        thread: { id: threadId, cwd: message.params.cwd, turns: [] },
        model: message.params.model || "gpt-test",
        reasoningEffort: message.params.effort || "medium",
        approvalPolicy: message.params.approvalPolicy || "on-request",
        approvalsReviewer: message.params.approvalsReviewer || "user",
        activePermissionProfile: { id: message.params.permissions || ":workspace", extends: null },
        sandbox: { type: message.params.permissions === ":danger-full-access" ? "dangerFullAccess" : "workspaceWrite" },
        receivedParams: message.params
      });
      notify("thread/started", { thread: { id: threadId, cwd: message.params.cwd } });
      return;
    }
    if (message.method === "thread/settings/update") {
      reply(message.id, {});
      notify("thread/settings/updated", {
        threadId: message.params.threadId,
        threadSettings: {
          cwd: process.cwd(),
          model: message.params.model || "gpt-test",
          modelProvider: "openai",
          serviceTier: null,
          effort: message.params.effort || "medium",
          summary: null,
          approvalPolicy: message.params.approvalPolicy || "on-request",
          approvalsReviewer: message.params.approvalsReviewer || "user",
          activePermissionProfile: { id: message.params.permissions || ":workspace", extends: null },
          sandboxPolicy: { type: message.params.permissions === ":danger-full-access" ? "dangerFullAccess" : "workspaceWrite" },
          collaborationMode: { mode: "default", settings: {} },
          multiAgentMode: "explicitRequestOnly",
          personality: null
        }
      });
      return;
    }
    if (message.method === "turn/start") {
      reply(message.id, {
        turn: { id: `turn-${message.params.threadId}` },
        receivedParams: message.params
      });
      notify("turn/started", { threadId: message.params.threadId });
      return;
    }
    if (message.method === "turn/steer") {
      reply(message.id, {
        turnId: message.params.expectedTurnId,
        receivedParams: message.params
      });
      notify("item/completed", {
        threadId: message.params.threadId,
        turnId: message.params.expectedTurnId,
        completedAtMs: Date.now(),
        item: {
          type: "userMessage",
          id: `user-${message.params.clientUserMessageId}`,
          clientId: message.params.clientUserMessageId || null,
          content: message.params.input
        }
      });
      return;
    }
    if (message.method === "turn/interrupt") {
      reply(message.id, { receivedParams: message.params });
      notify("turn/completed", {
        threadId: message.params.threadId,
        turn: { id: message.params.turnId, status: "interrupted" }
      });
      return;
    }
    if (message.method === "thread/queue/add") {
      const queuedSubmission = {
        id: `queued-${message.params.clientUserMessageId}`,
        input: message.params.input,
        clientUserMessageId: message.params.clientUserMessageId
      };
      const queue = queuedByThread.get(message.params.threadId) || [];
      queue.push(queuedSubmission);
      queuedByThread.set(message.params.threadId, queue);
      reply(message.id, { queuedSubmission });
      notify("thread/queue/changed", { threadId: message.params.threadId });
      return;
    }
    if (message.method === "thread/queue/list") {
      reply(message.id, {
        data: (queuedByThread.get(message.params.threadId) || []).slice(0, message.params.limit || 20),
        nextCursor: null
      });
      return;
    }
    if (message.method === "thread/queue/start") {
      const queue = queuedByThread.get(message.params.threadId) || [];
      const index = queue.findIndex((entry) => entry.id === message.params.queuedSubmissionId);
      const [queuedSubmission] = index >= 0 ? queue.splice(index, 1) : [queue.shift()];
      const turn = { id: `turn-queued-${queuedSubmission?.id || "missing"}` };
      reply(message.id, { turn });
      notify("thread/queue/changed", { threadId: message.params.threadId });
      notify("turn/started", { threadId: message.params.threadId, turn });
      return;
    }
    if (message.method === "thread/resume") {
      reply(message.id, {
        thread: process.env.FAKE_CODEX_P0_BROWSER === "1" ? fixtureThread(message.params.threadId) : { id: message.params.threadId, cwd: process.cwd(), turns: [] },
        model: "gpt-test",
        reasoningEffort: "medium",
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        activePermissionProfile: { id: ":workspace", extends: null },
        sandbox: { type: "workspaceWrite" },
        receivedParams: message.params
      });
      return;
    }
    if (message.method === "trigger/server-request") {
      reply(message.id, {});
      const id = message.params.requestId ?? 900;
      const method = message.params.method || "item/tool/requestUserInput";
      pendingServerIds.add(id);
      process.stdout.write(`${JSON.stringify({
        id,
        method,
        params: {
          threadId: message.params.threadId,
          ...(method === "item/tool/requestUserInput" ? { questions: [{ id: "reply", header: "Reply", question: "Fixture reply" }] } : {}),
          ...(method === "item/commandExecution/requestApproval" ? { command: "echo SYNTHETIC_ONLY" } : {}),
          ...(message.params.params || {})
        }
      })}\n`);
      return;
    }
    if (message.method === "trigger/notification") {
      notify(message.params.method, message.params.params);
      reply(message.id, {});
      return;
    }
    if (message.method === "trigger/resolve-server-request") {
      pendingServerIds.delete(message.params.requestId);
      notify("serverRequest/resolved", { requestId: message.params.requestId });
      reply(message.id, {});
      return;
    }
    if (pendingServerIds.has(message.id) && message.method === undefined) {
      pendingServerIds.delete(message.id);
      notify("test/server-response", { id: message.id, result: message.result });
      return;
    }
    if (message.id !== undefined) reply(message.id, {});
  });
}

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ id, result })}\n`);
}

function notify(method, params) {
  process.stdout.write(`${JSON.stringify({ method, params })}\n`);
}
