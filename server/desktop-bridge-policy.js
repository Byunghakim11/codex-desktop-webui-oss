const runtimeOverrideKeys = new Set([
  "model",
  "effort",
  "reasoningEffort",
  "approvalPolicy",
  "approval_policy",
  "sandbox",
  "sandboxPolicy",
  "sandbox_policy"
]);

const rawSandboxKeys = new Set(["sandbox", "sandboxPolicy", "sandbox_policy"]);

export function sanitizeDesktopBridgeParams(method, params = {}) {
  const next = { ...(params || {}) };
  if (method === "thread/resume") {
    return next.threadId ? { threadId: next.threadId } : {};
  }
  if (method === "turn/start") {
    for (const key of runtimeOverrideKeys) delete next[key];
    return next;
  }
  if (method === "thread/start" || method === "thread/settings/update") {
    for (const key of rawSandboxKeys) delete next[key];
  }
  return next;
}
