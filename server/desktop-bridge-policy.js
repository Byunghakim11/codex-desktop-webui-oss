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
    const result=next.threadId?{threadId:next.threadId}:{};
    const page=next.initialTurnsPage;
    if(result.threadId&&page&&typeof page==="object"&&!Array.isArray(page)&&Object.keys(page).every(key=>key==="limit")&&Number.isInteger(page.limit)&&page.limit>=1&&page.limit<=6)result.initialTurnsPage={limit:page.limit};
    return result;
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
