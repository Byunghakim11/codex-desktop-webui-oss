import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeDesktopBridgeParams } from "../server/desktop-bridge-policy.js";

test("desktop bridge strips runtime setting overrides from existing-thread turns", () => {
  const result = sanitizeDesktopBridgeParams("turn/start", {
    threadId: "thread-1",
    input: [{ type: "text", text: "hello" }],
    model: "other-model",
    effort: "low",
    reasoningEffort: "xhigh",
    approvalPolicy: "never",
    sandbox: "danger-full-access"
  });
  assert.deepEqual(result, {
    threadId: "thread-1",
    input: [{ type: "text", text: "hello" }]
  });
});

test("desktop bridge resume carries only the target thread ID", () => {
  assert.deepEqual(
    sanitizeDesktopBridgeParams("thread/resume", {
      threadId: "thread-2",
      cwd: "D:\\wrong",
      model: "other-model",
      effort: "low",
      approvalPolicy: "never",
      sandbox: "read-only"
    }),
    { threadId: "thread-2" }
  );
});

test("new shared threads keep model effort and permission presets but drop raw sandbox", () => {
  assert.deepEqual(sanitizeDesktopBridgeParams("thread/start", {
    cwd: "E:\\AI\\project",
    model: "gpt-test",
    effort: "high",
    permissions: ":danger-full-access",
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: "danger-full-access",
    sandboxPolicy: { type: "dangerFullAccess" }
  }), {
    cwd: "E:\\AI\\project",
    model: "gpt-test",
    effort: "high",
    permissions: ":danger-full-access",
    approvalPolicy: "never",
    approvalsReviewer: "user"
  });
});

test("thread settings update keeps supported shared settings and drops raw sandbox", () => {
  assert.deepEqual(sanitizeDesktopBridgeParams("thread/settings/update", {
    threadId: "thread-2",
    model: "gpt-test",
    effort: "medium",
    permissions: ":workspace",
    approvalPolicy: "on-request",
    approvalsReviewer: "guardian_subagent",
    sandboxPolicy: { type: "workspaceWrite" }
  }), {
    threadId: "thread-2",
    model: "gpt-test",
    effort: "medium",
    permissions: ":workspace",
    approvalPolicy: "on-request",
    approvalsReviewer: "guardian_subagent"
  });
});

test("unrelated RPC parameters are not changed", () => {
  const params = { threadId: "thread-3", name: "New name" };
  assert.deepEqual(sanitizeDesktopBridgeParams("thread/name/set", params), params);
});
