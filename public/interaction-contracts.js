const APPROVALS = new Set(["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "execCommandApproval", "applyPatchApproval"]);
const HUMAN = new Set([...APPROVALS, "item/tool/requestUserInput", "item/permissions/requestApproval", "mcpServer/elicitation/request"]);
const unsafeKeys = new Set(["__proto__", "prototype", "constructor"]);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const record = value => value !== null && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const text = (value, max = 16384) => typeof value === "string" && value.length <= max;
const keysOnly = (value, keys) => record(value) && Object.keys(value).every(key => keys.includes(key) && !unsafeKeys.has(key));
const bounded = value => { try { return JSON.stringify(value).length <= 131072; } catch { return false; } };

export function interactionKey(id) {
  if (typeof id === "string" && id.length <= 256) return `string:${id}`;
  if (typeof id === "number" && Number.isSafeInteger(id)) return `number:${id}`;
  throw new Error("Invalid server request identifier");
}

export function isHumanInteractionMethod(method) { return HUMAN.has(String(method || "")); }

export function approvalChoices(request) {
  if (!APPROVALS.has(request?.method)) return [];
  const legacy = ["execCommandApproval", "applyPatchApproval"].includes(request.method);
  const choices = legacy
    ? [{ action: "allow", result: { decision: "approved" } }, { action: "deny", result: { decision: { denied: { rejection: "Declined from WebUI." } } } }, { action: "cancel", result: { decision: "abort" } }]
    : [{ action: "allow", result: { decision: "accept" } }, { action: "deny", result: { decision: "decline" } }, { action: "cancel", result: { decision: "cancel" } }];
  const available = request.params?.availableDecisions;
  return !legacy && Array.isArray(available) ? choices.filter(choice => available.includes(choice.result.decision)) : choices;
}

function validPermissions(profile) {
  if (!keysOnly(profile, ["network", "fileSystem"])) return false;
  const network = profile.network;
  if (network != null && (!keysOnly(network, ["enabled"]) || (network.enabled != null && typeof network.enabled !== "boolean"))) return false;
  const fs = profile.fileSystem;
  if (fs == null) return true;
  if (!keysOnly(fs, ["read", "write", "entries", "globScanMaxDepth"])) return false;
  for (const key of ["read", "write"]) {
    if (fs[key] != null && (!Array.isArray(fs[key]) || fs[key].length > 64 || !fs[key].every(path => text(path, 4096) && path.length > 0 && !path.includes("\0")))) return false;
  }
  if (fs.globScanMaxDepth != null && (!Number.isSafeInteger(fs.globScanMaxDepth) || fs.globScanMaxDepth < 1)) return false;
  if (fs.entries != null && (!Array.isArray(fs.entries) || fs.entries.length > 64 || !fs.entries.every(entry =>
    keysOnly(entry, ["access", "path"]) && ["read", "write"].includes(entry.access) && keysOnly(entry.path, ["type", "path"]) && entry.path.type === "path" && text(entry.path.path, 4096) && entry.path.path.length > 0 && !entry.path.path.includes("\0")
  ))) return false;
  return true;
}

function validQuestions(questions) {
  if (!Array.isArray(questions) || !questions.length || questions.length > 10) return false;
  const ids = new Set();
  return questions.every(question => {
    if (!record(question) || !text(question.id, 128) || !question.id || unsafeKeys.has(question.id) || ids.has(question.id) || !text(question.question)) return false;
    ids.add(question.id);
    if (question.header != null && !text(question.header, 500)) return false;
    if (question.isOther != null && typeof question.isOther !== "boolean") return false;
    if (question.isSecret != null && typeof question.isSecret !== "boolean") return false;
    if (question.options != null && (!Array.isArray(question.options) || question.options.length > 50 || !question.options.every(option => record(option) && text(option.label, 1000) && text(option.description || "", 4000)))) return false;
    return !(question.isSecret && question.options?.length);
  });
}

function supportedForm(schema) {
  if (!keysOnly(schema, ["$schema", "type", "title", "description", "properties", "required", "additionalProperties"]) || schema.type !== "object" || !record(schema.properties) || Object.keys(schema.properties).length > 32) return false;
  if (schema.additionalProperties != null && schema.additionalProperties !== false) return false;
  if (schema.required != null && (!Array.isArray(schema.required) || !schema.required.every(name => typeof name === "string" && own(schema.properties, name)))) return false;
  return Object.entries(schema.properties).every(([name, field]) => {
    if (!name || name.length > 128 || unsafeKeys.has(name) || !keysOnly(field, ["type", "title", "description", "enum", "minimum", "maximum", "minLength", "maxLength", "default"])) return false;
    if (!["string", "number", "integer", "boolean"].includes(field.type)) return false;
    if (field.title != null && !text(field.title, 500)) return false;
    if (field.description != null && !text(field.description, 4000)) return false;
    if (field.enum != null && (!Array.isArray(field.enum) || !field.enum.length || field.enum.length > 100 || !field.enum.every(value => primitiveMatches(value, field.type)))) return false;
    for (const key of ["minimum", "maximum"]) if (field[key] != null && (typeof field[key] !== "number" || !Number.isFinite(field[key]))) return false;
    for (const key of ["minLength", "maxLength"]) if (field[key] != null && (!Number.isSafeInteger(field[key]) || field[key] < 0 || field[key] > 16384)) return false;
    return true;
  });
}

function safeFlowUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || !text(value, 8192) || localHost(url.hostname)) return false;
    for (const [key, target] of url.searchParams) {
      if (/^(redirect_uri|redirect_url|callback|callback_url|return_to)$/i.test(key)) {
        const callback = new URL(target, url);
        if (callback.protocol !== "https:" || localHost(callback.hostname)) return false;
      }
    }
    return true;
  } catch { return false; }
}

const localHost = host => /^(localhost|127\..*|\[?::1\]?|0\.0\.0\.0)$/i.test(host) || host.endsWith(".localhost");

// A modern approval RPC contains only itemId. The broker attaches a complete,
// matching fileChange preview; absent/oversize previews never enable approval.
export function fileApprovalChanges(request) {
  let changes;
  if (request?.method === "item/fileChange/requestApproval") changes = request.displayContext?.fileChanges;
  else if (request?.method === "applyPatchApproval" && record(request.params?.fileChanges)) {
    changes = Object.entries(request.params.fileChanges).map(([path, change]) => ({ path, kind: change?.type, diff: change?.type === "update" ? change.unified_diff : change?.content, movePath: change?.move_path ?? null }));
  }
  if (!Array.isArray(changes) || !changes.length || changes.length > 64 || !bounded(changes)) return null;
  if (!changes.every(change => record(change) && text(change.path, 4096) && change.path.length > 0 && !change.path.includes("\0") && ["add", "delete", "update"].includes(change.kind) && text(change.diff, 120000) && (change.movePath == null || (text(change.movePath, 4096) && change.movePath.length > 0 && !change.movePath.includes("\0"))))) return null;
  return structuredClone(changes);
}

function commandContextSupported(params, legacy) {
  if (!legacy && params.kind != null && !["command", "humanCommand"].includes(params.kind)) return false;
  if (params.additionalPermissions != null && !validPermissions(params.additionalPermissions)) return false;
  const network = params.networkApprovalContext;
  if (network != null && (!keysOnly(network, ["host", "protocol"]) || !text(network.host, 4096) || !network.host || !["http", "https", "socks5Tcp", "socks5Udp"].includes(network.protocol))) return false;
  const command = params.command;
  return Boolean(network || (text(command) && command.trim()) || (legacy && Array.isArray(command) && command.length && command.every(part => text(part))));
}

export function classifyInteractionRequest(request) {
  const method = request?.method;
  if (!HUMAN.has(method)) return { support: "ignore", kind: "technical" };
  const desktop = reason => ({ support: "desktop", kind: "fallback", reason });
  try { interactionKey(request.id); } catch { return desktop("invalid-id"); }
  if (request.desktopOnly) return desktop(request.unavailableReason || "unsupported");
  if (!bounded(request)) return desktop("request-too-large");
  const params = request.params || {};
  if (!record(params) || !text(params.threadId || params.thread_id || params.conversationId, 256) || !(params.threadId || params.thread_id || params.conversationId)) return desktop("missing-thread-context");
  if (APPROVALS.has(method)) {
    if (["item/fileChange/requestApproval", "applyPatchApproval"].includes(method)) {
      if (params.grantRoot != null) return desktop("session-root-grant");
      if (!fileApprovalChanges(request)) return desktop("file-preview-unavailable");
    } else if (!commandContextSupported(params, method === "execCommandApproval")) return desktop("command-context-not-supported");
    return approvalChoices(request).length ? { support: "web", kind: "approval" } : desktop("decision-not-supported");
  }
  if (method === "item/tool/requestUserInput") return validQuestions(params.questions) ? { support: "web", kind: "question" } : desktop("question-not-supported");
  if (method === "item/permissions/requestApproval") return validPermissions(params.permissions) ? { support: "web", kind: "permissions" } : desktop("permission-profile-not-supported");
  if (!text(params.serverName, 256) || !params.serverName || !text(params.message)) return desktop("incomplete-mcp-request");
  if (["form", "openai/form", "openaiForm"].includes(params.mode)) return supportedForm(params.requestedSchema) ? { support: "web", kind: "form" } : desktop("form-schema-not-supported");
  if (params.mode === "url") return safeFlowUrl(params.url) && text(params.elicitationId, 256) && params.elicitationId.length > 0 ? { support: "web", kind: "url" } : desktop("url-flow-not-supported");
  return desktop("verification-requires-desktop");
}

export function publicInteractionRequest(request) {
  try { interactionKey(request?.id); } catch { return null; }
  const capability = classifyInteractionRequest(request);
  if (capability.support === "ignore") return null;
  if (capability.support === "web") return structuredClone(request);
  return { id: request.id, method: request.method, desktopOnly: true, unavailableReason: capability.reason, params: { threadId: request.params?.threadId || request.params?.thread_id || request.params?.conversationId || "", turnId: request.params?.turnId || "" } };
}

function invalid() {
  const error = new Error("The response does not match this pending request.");
  error.code = "INVALID_INTERACTION_RESPONSE";
  error.retryable = true;
  throw error;
}

function primitiveMatches(value, type) {
  if (type === "string") return text(value);
  if (type === "boolean") return typeof value === "boolean";
  return typeof value === "number" && Number.isFinite(value) && (type !== "integer" || Number.isSafeInteger(value));
}

function validateGrantedPermissions(requested, granted) {
  if (!validPermissions(granted)) invalid();
  if (granted.network?.enabled === true && requested.network?.enabled !== true) invalid();
  const fs = granted.fileSystem;
  if (!fs) return;
  const wanted = requested.fileSystem || {};
  for (const key of ["read", "write"]) {
    if (fs[key]?.some(path => !wanted[key]?.includes(path))) invalid();
  }
  if (fs.entries?.some(entry => !wanted.entries?.some(want => JSON.stringify(want) === JSON.stringify(entry)))) invalid();
  if (fs.globScanMaxDepth != null && fs.globScanMaxDepth !== wanted.globScanMaxDepth) invalid();
}

export function validateInteractionResponse(request, response) {
  const capability = classifyInteractionRequest(request);
  if (capability.support !== "web" || !record(response) || !bounded(response)) invalid();
  if (capability.kind === "approval") {
    if (!keysOnly(response, ["decision"])) invalid();
    const legacy = ["execCommandApproval", "applyPatchApproval"].includes(request.method);
    if (legacy && keysOnly(response.decision, ["denied"]) && keysOnly(response.decision.denied, ["rejection"]) && text(response.decision.denied.rejection)) return structuredClone(response);
    if (!approvalChoices(request).some(choice => choice.result.decision === response.decision)) invalid();
  } else if (capability.kind === "permissions") {
    if (!keysOnly(response, ["permissions", "scope", "strictAutoReview"]) || !own(response, "permissions") || (response.scope != null && response.scope !== "turn") || (response.strictAutoReview != null && response.strictAutoReview !== true)) invalid();
    validateGrantedPermissions(request.params.permissions, response.permissions);
  } else if (capability.kind === "question") {
    if (!keysOnly(response, ["answers"]) || !record(response.answers)) invalid();
    const questions = new Map(request.params.questions.map(question => [question.id, question]));
    for (const [id, answer] of Object.entries(response.answers)) {
      const question = questions.get(id);
      if (!question || !keysOnly(answer, ["answers"]) || !Array.isArray(answer.answers) || answer.answers.length > 1 || !answer.answers.every(value => text(value))) invalid();
      if (question.options?.length && !question.isOther && answer.answers.some(value => !question.options.some(option => option.label === value))) invalid();
    }
  } else {
    if (!keysOnly(response, ["action", "content"]) || !["accept", "decline", "cancel"].includes(response.action)) invalid();
    if (response.action !== "accept" || capability.kind === "url") {
      if (response.content != null) invalid();
      return { action: response.action, content: null };
    }
    const schema = request.params.requestedSchema;
    const content = response.content;
    if (!record(content) || Object.keys(content).some(name => !own(schema.properties, name) || unsafeKeys.has(name))) invalid();
    if ((schema.required || []).some(name => !own(content, name))) invalid();
    for (const [name, value] of Object.entries(content)) {
      const field = schema.properties[name];
      if (!primitiveMatches(value, field.type) || (field.enum && !field.enum.includes(value))) invalid();
      if (typeof value === "string" && (value.length < (field.minLength || 0) || value.length > (field.maxLength ?? 16384))) invalid();
      if (typeof value === "number" && ((field.minimum != null && value < field.minimum) || (field.maximum != null && value > field.maximum))) invalid();
    }
  }
  return structuredClone(response);
}
