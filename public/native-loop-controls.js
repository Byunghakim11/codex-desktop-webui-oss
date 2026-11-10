import { nativeLoopMessages } from "./native-loop-messages.js";

const NAME_MAX = 200;
const PROMPT_MAX = 8000;
const INTERVAL_MIN = 1;
const INTERVAL_MAX = 1440;
const STATUS_VALUES = Object.freeze(["ACTIVE", "PAUSED"]);
const DRAFT_LIMIT = 8;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Defensive only: the server authenticates and owns final authority. This
// mirrors a thread-shaped source marker so another thread's row never renders.
const THREAD_LIKE_SOURCE = /^thread[-_:]/i;

let messagesRegisteredOnce = false;

export class LoopValidationError extends Error {
  constructor(code) {
    super(code);
    this.name = "LoopValidationError";
    this.code = code;
  }
}

function normalizeIntervalMinutes(value) {
  let number;
  if (typeof value === "number") {
    number = value;
  } else if (typeof value === "string") {
    const text = value.trim();
    if (!/^\d+$/.test(text)) throw new LoopValidationError("nativeLoop.error.interval");
    number = Number(text);
  } else {
    throw new LoopValidationError("nativeLoop.error.interval");
  }
  if (!Number.isSafeInteger(number) || number < INTERVAL_MIN || number > INTERVAL_MAX) {
    throw new LoopValidationError("nativeLoop.error.interval");
  }
  return number;
}

// Pure payload builder. It whitelists only the fields the native heartbeat
// actions accept; the server builds the recurrence schedule itself.
export function buildLoopCreateParams({ name, prompt, intervalMinutes, status, notificationPolicy } = {}) {
  if (typeof name !== "string") throw new LoopValidationError("nativeLoop.error.name");
  if (name.trim() === "" || name.length > NAME_MAX) throw new LoopValidationError("nativeLoop.error.name");
  if (typeof prompt !== "string") throw new LoopValidationError("nativeLoop.error.prompt");
  if (prompt.trim() === "" || prompt.length > PROMPT_MAX) throw new LoopValidationError("nativeLoop.error.prompt");
  const params = {
    name,
    prompt,
    intervalMinutes: normalizeIntervalMinutes(intervalMinutes)
  };
  if (!STATUS_VALUES.includes(status)) throw new LoopValidationError("nativeLoop.error.status");
  params.status = status;
  if (notificationPolicy !== undefined) {
    if (notificationPolicy !== null && notificationPolicy !== "failed_runs_only") {
      throw new LoopValidationError("nativeLoop.error.notificationPolicy");
    }
    params.notificationPolicy = notificationPolicy;
  }
  return params;
}

function fallbackRequestId() {
  const hex = "0123456789abcdef";
  const pick = () => hex[Math.floor(Math.random() * 16)];
  const block = (length) => Array.from({ length }, pick).join("");
  return `${block(8)}-${block(4)}-4${block(3)}-${"89ab"[Math.floor(Math.random() * 4)]}${block(3)}-${block(12)}`;
}

function newRequestId() {
  try {
    const id = globalThis.crypto?.randomUUID?.();
    if (typeof id === "string" && UUID_PATTERN.test(id)) return id;
  } catch {
    // Fall through to the local identifier below.
  }
  return fallbackRequestId();
}

export function createNativeLoopControls({
  document,
  host,
  t,
  registerMessages,
  getContext,
  transport,
  onFeedback
} = {}) {
  if (typeof registerMessages === "function" && !messagesRegisteredOnce) {
    messagesRegisteredOnce = true;
    try {
      registerMessages(nativeLoopMessages);
    } catch {
      // Registration belongs to the host; bundled English still labels the UI.
    }
  }

  const messages = nativeLoopMessages.en;
  const elements = { buttons: {}, statusOptions: {} };
  let disposed = false;
  let generation = 0;
  let listTicket = 0;
  let viewTicket = 0;
  let snapshot = null;
  let detail = null;
  let current = null;
  let currentThreadId = null;
  let inFlightForm = null;
  let pendingDelete = null;
  let mutationBusy = false;
  let root = null;
  let attached = false;
  // Unsaved forms live only in RAM and are bounded so forced thread switches
  // cannot leak indefinitely.
  const drafts = new Map();

  function label(key, params) {
    try {
      const value = typeof t === "function" ? (params ? t(key, params) : t(key)) : undefined;
      if (typeof value === "string" && value !== "" && value !== key) return value;
    } catch {
      // Fall back to the bundled English label.
    }
    const template = messages[key] ?? key;
    if (!params) return template;
    return template.replace(/\{(\w+)\}/g, (match, name) =>
      params[name] === undefined ? match : String(params[name])
    );
  }

  function feedback(kind, key, params) {
    try {
      onFeedback?.({ kind, code: key, label: label(key, params) });
    } catch {
      // Feedback is advisory; a broken listener must not break the UI.
    }
  }

  function fail(error, fallback = "nativeLoop.error.failed") {
    const code =
      typeof error?.code === "string" && error.code.startsWith("nativeLoop.") ? error.code : fallback;
    feedback("error", code);
  }

  function context() {
    let value = null;
    try {
      value = getContext?.();
    } catch {
      value = null;
    }
    return {
      threadId: typeof value?.threadId === "string" && value.threadId !== "" ? value.threadId : null,
      connected: value?.connected === true
    };
  }

  function transportReady() {
    return typeof transport?.execute === "function";
  }

  function node(tag, className, text) {
    const created = document.createElement(tag);
    if (className) created.className = className;
    if (text !== undefined) created.textContent = text;
    return created;
  }

  function clearChildren(parent) {
    if (!parent) return;
    try {
      if (typeof parent.replaceChildren === "function") {
        parent.replaceChildren();
        return;
      }
    } catch {
      // Fall through to the bounded fallbacks below.
    }
    try {
      if (Array.isArray(parent.children)) {
        parent.children.length = 0;
        return;
      }
    } catch {
      // Fall through to element removal.
    }
    try {
      while (parent.firstChild) parent.removeChild(parent.firstChild);
    } catch {
      // Detached fragments are host-owned.
    }
  }

  function statusText(status) {
    if (status === "ACTIVE") return label("nativeLoop.status.ACTIVE");
    if (status === "PAUSED") return label("nativeLoop.status.PAUSED");
    return label("nativeLoop.status.unknown");
  }

  function intervalText(minutes) {
    return typeof minutes === "number" ? label("nativeLoop.interval", { minutes }) : label("nativeLoop.intervalNone");
  }

  function foreignSource(source, threadId) {
    return typeof source === "string" && source !== threadId && THREAD_LIKE_SOURCE.test(source);
  }

  function normalizeHeartbeat(raw, threadId, expectedId) {
    if (!raw || typeof raw !== "object") return null;
    if (raw.kind !== "heartbeat") return null;
    if (typeof raw.id !== "string" || raw.id === "") return null;
    if (expectedId && raw.id !== expectedId) return null;
    if (raw.targetThreadId !== threadId) return null;
    if (foreignSource(raw.source, threadId)) return null;
    const interval =
      Number.isSafeInteger(raw.intervalMinutes) && raw.intervalMinutes >= INTERVAL_MIN && raw.intervalMinutes <= INTERVAL_MAX
        ? raw.intervalMinutes
        : null;
    return {
      id: raw.id,
      name: typeof raw.name === "string" ? raw.name : "",
      status: raw.status === "ACTIVE" || raw.status === "PAUSED" ? raw.status : null,
      kind: "heartbeat",
      intervalMinutes: interval,
      targetThreadId: threadId,
      source: typeof raw.source === "string" ? raw.source : null,
      prompt: typeof raw.prompt === "string" ? raw.prompt : ""
    };
  }

  function normalizeReceipt(receipt, base) {
    if (!receipt || typeof receipt !== "object") return null;
    if (typeof receipt.confirmationId !== "string" || receipt.confirmationId === "") return null;
    if (receipt.action !== undefined && receipt.action !== base.action) return null;
    if (receipt.threadId !== undefined && receipt.threadId !== base.threadId) return null;
    return {
      confirmationId: receipt.confirmationId,
      action: base.action,
      threadId: base.threadId,
      expiresAt: typeof receipt.expiresAt === "string" ? receipt.expiresAt : null
    };
  }

  function findLoop(id) {
    return snapshot?.list.find((entry) => entry.id === id) ?? null;
  }

  function emptyForm() {
    return {
      dirty: false,
      name: "",
      prompt: "",
      interval: "",
      status: "ACTIVE",
      requestId: null,
      pendingUnknown: false,
      pendingParams: null,
      revision: 0,
      nameSelection: null,
      promptSelection: null
    };
  }

  // Selection capture/restore for the two text buffers. Kept local so a body
  // without selection support (fake DOM) simply stores nothing.
  function captureSelection() {
    if (!current) return;
    const fields = [
      [elements.name, "nameSelection"],
      [elements.prompt, "promptSelection"]
    ];
    for (const [field, key] of fields) {
      if (!field) continue;
      if (typeof field.selectionStart !== "number") continue;
      current[key] = {
        start: field.selectionStart,
        end: typeof field.selectionEnd === "number" ? field.selectionEnd : field.selectionStart,
        direction: typeof field.selectionDirection === "string" ? field.selectionDirection : null
      };
    }
  }

  function restoreSelection() {
    if (!current) return;
    const fields = [
      [elements.name, "nameSelection"],
      [elements.prompt, "promptSelection"]
    ];
    for (const [field, key] of fields) {
      const saved = current[key];
      if (!field || !saved) continue;
      try {
        if (typeof field.setSelectionRange === "function") {
          field.setSelectionRange(saved.start, saved.end, saved.direction ?? "none");
        }
      } catch {
        // Selection restore is advisory; the buffer above is what matters.
      }
      try {
        field.selectionStart = saved.start;
        field.selectionEnd = saved.end;
        if (saved.direction != null) field.selectionDirection = saved.direction;
      } catch {
        // Ignore read-only selection implementations.
      }
    }
  }

  function applyFormToInputs() {
    if (!current) return;
    if (elements.name) elements.name.value = current.name;
    if (elements.prompt) elements.prompt.value = current.prompt;
    if (elements.interval) elements.interval.value = current.interval;
    if (elements.status) elements.status.value = current.status;
    restoreSelection();
  }

  function rememberDraft() {
    if (!current || !currentThreadId) return;
    if (!(current.dirty || current.pendingUnknown || current.requestId)) return;
    drafts.delete(currentThreadId);
    drafts.set(currentThreadId, { ...current });
    while (drafts.size > DRAFT_LIMIT) {
      const oldest = drafts.keys().next();
      if (oldest.done) break;
      drafts.delete(oldest.value);
    }
  }

  function restoreForm(threadId) {
    const draft = threadId ? drafts.get(threadId) : null;
    current = draft ? { ...draft } : emptyForm();
    currentThreadId = threadId ?? null;
    applyFormToInputs();
  }

  function reconcileUnknown(threadId) {
    if (!current || currentThreadId !== threadId) return;
    if (!current.pendingUnknown && !current.requestId) return;
    // The list is deliberately incomplete and cannot prove this intent failed.
    // Keep the original request id until its own durable receipt is reconciled.
  }

  function markDirty(syncField) {
    if (!current || disposed) return;
    if (typeof syncField === "function") syncField();
    current.dirty = true;
    current.revision += 1;
    captureSelection();
    render();
  }

  function rowEnabled(action, heartbeat, ready) {
    if (!ready) return false;
    if (action === "pause") return heartbeat.status === "ACTIVE";
    if (action === "resume") return heartbeat.status === "PAUSED";
    return true;
  }

  function actionButton(action, key, id, enabled, handler) {
    const button = node("button", "wf-dialog-action", label(key));
    button.setAttribute("type", "button");
    button.setAttribute("data-loop-action", action);
    if (id !== undefined) button.setAttribute("data-loop-id", id);
    button.disabled = !enabled;
    button.addEventListener("click", () => handler());
    return button;
  }

  function renderList() {
    if (!elements.list) return;
    clearChildren(elements.list);
    const ctx = context();
    const ready = ctx.connected && transportReady() && !!ctx.threadId && !mutationBusy;
    const rows = snapshot?.list ?? [];
    if (rows.length === 0) {
      elements.list.append(node("p", "native-loop-empty", label("nativeLoop.empty")));
      return;
    }
    for (const heartbeat of rows) {
      const row = node("div", "native-loop-row");
      row.setAttribute("data-loop-id", heartbeat.id);
      row.append(
        node("span", "native-loop-row-name", heartbeat.name),
        node("span", "native-loop-row-status", statusText(heartbeat.status)),
        node("span", "native-loop-row-interval", intervalText(heartbeat.intervalMinutes))
      );
      const actions = node("div", "native-loop-row-actions");
      actions.append(
        actionButton("view", "nativeLoop.view", heartbeat.id, rowEnabled("view", heartbeat, ready), () =>
          viewLoop(heartbeat.id)
        ),
        actionButton("pause", "nativeLoop.pause", heartbeat.id, rowEnabled("pause", heartbeat, ready), () =>
          toggleLoop(heartbeat.id, "heartbeat.pause", "nativeLoop.paused")
        ),
        actionButton("resume", "nativeLoop.resume", heartbeat.id, rowEnabled("resume", heartbeat, ready), () =>
          toggleLoop(heartbeat.id, "heartbeat.resume", "nativeLoop.resumed")
        ),
        actionButton("delete", "nativeLoop.delete", heartbeat.id, rowEnabled("delete", heartbeat, ready), () =>
          deleteLoop(heartbeat.id)
        )
      );
      row.append(actions);
      elements.list.append(row);
    }
  }

  function renderDetail() {
    if (!elements.detail) return;
    clearChildren(elements.detail);
    const heartbeat = detail?.heartbeat;
    if (!heartbeat) return;
    elements.detail.append(node("h3", "native-loop-detail-title", label("nativeLoop.detailTitle")));
    elements.detail.append(
      node("p", "native-loop-detail-id", label("nativeLoop.detailId", { id: heartbeat.id })),
      node("p", "native-loop-detail-name", label("nativeLoop.detailName", { name: heartbeat.name })),
      node("p", "native-loop-detail-status", label("nativeLoop.detailStatus", { status: statusText(heartbeat.status) })),
      node("p", "native-loop-detail-interval", label("nativeLoop.detailInterval", { interval: intervalText(heartbeat.intervalMinutes) })),
      node("p", "native-loop-detail-target", label("nativeLoop.detailTarget", { target: heartbeat.targetThreadId })),
      node("p", "native-loop-detail-source", label("nativeLoop.detailSource", { source: heartbeat.source ?? "" }))
    );
    elements.detail.append(node("p", "native-loop-detail-prompt-label", label("nativeLoop.detailPrompt")));
    elements.detail.append(node("p", "native-loop-detail-prompt", heartbeat.prompt));
  }

  function render() {
    if (!root || disposed) return;
    const ctx = context();
    const ready = ctx.connected && transportReady() && !!ctx.threadId && !mutationBusy;
    if (elements.title) elements.title.textContent = label("nativeLoop.title");
    root.setAttribute("aria-label", label("nativeLoop.title"));
    if (elements.listLimited) elements.listLimited.textContent = label("nativeLoop.listLimited");
    if (elements.statusLine) {
      if (!ctx.connected) elements.statusLine.textContent = label("nativeLoop.offline");
      else if (!transportReady() || !ctx.threadId) elements.statusLine.textContent = label("nativeLoop.unavailable");
      else if (!snapshot) elements.statusLine.textContent = label("nativeLoop.loading");
      else elements.statusLine.textContent = label("nativeLoop.count", { count: snapshot.list.length });
    }
    if (elements.nameLabel) elements.nameLabel.textContent = label("nativeLoop.name");
    if (elements.promptLabel) elements.promptLabel.textContent = label("nativeLoop.prompt");
    if (elements.intervalLabel) elements.intervalLabel.textContent = label("nativeLoop.intervalLabel");
    if (elements.statusLabel) elements.statusLabel.textContent = label("nativeLoop.statusLabel");
    if (elements.name) elements.name.setAttribute("placeholder", label("nativeLoop.namePlaceholder"));
    if (elements.prompt) elements.prompt.setAttribute("placeholder", label("nativeLoop.promptPlaceholder"));
    if (elements.interval) elements.interval.setAttribute("placeholder", label("nativeLoop.intervalPlaceholder"));
    if (elements.statusOptions.ACTIVE) elements.statusOptions.ACTIVE.textContent = label("nativeLoop.status.ACTIVE");
    if (elements.statusOptions.PAUSED) elements.statusOptions.PAUSED.textContent = label("nativeLoop.status.PAUSED");
    if (elements.buttons.create) elements.buttons.create.textContent = label("nativeLoop.create");
    if (elements.buttons.refresh) elements.buttons.refresh.textContent = label("nativeLoop.refresh");
    if (elements.buttons.check) elements.buttons.check.textContent = label("nativeLoop.checkDelivery");
    if (elements.buttons.discard) elements.buttons.discard.textContent = label("nativeLoop.discard");
    if (elements.buttons.close) elements.buttons.close.textContent = label("nativeLoop.close");
    if (elements.buttons.create) {
      const blocked = !current || current.pendingUnknown || !!current.requestId;
      elements.buttons.create.disabled = !ready || blocked;
    }
    if (elements.buttons.refresh) {
      elements.buttons.refresh.disabled = !ctx.connected || !transportReady() || !ctx.threadId || mutationBusy;
    }
    if (elements.buttons.discard) {
      const hasForm = !!current && (current.dirty || current.pendingUnknown || !!current.requestId);
      elements.buttons.discard.disabled = mutationBusy || !hasForm || current.pendingUnknown;
    }
    if (elements.buttons.check) elements.buttons.check.disabled = !ready || !current?.pendingUnknown || !current?.pendingParams;
    if (elements.confirm) elements.confirm.textContent = pendingDelete ? pendingDelete.review : "";
    renderList();
    renderDetail();
  }

  function build() {
    if (root) return root;
    root = node("dialog", "wf-dialog native-loop-dialog");
    root.setAttribute("aria-label", label("nativeLoop.title"));
    elements.title = node("h2", "wf-dialog-title", label("nativeLoop.title"));
    elements.statusLine = node("p", "wf-dialog-status");
    elements.listLimited = node("p", "native-loop-incomplete", label("nativeLoop.listLimited"));
    elements.list = node("div", "native-loop-list");
    elements.detail = node("div", "native-loop-detail");

    const nameField = node("label", "field");
    elements.nameLabel = node("span", "field-label", label("nativeLoop.name"));
    elements.name = node("input", "field-input native-loop-name");
    elements.name.setAttribute("type", "text");
    elements.name.setAttribute("maxlength", String(NAME_MAX));
    elements.name.value = "";
    nameField.append(elements.nameLabel, elements.name);

    const promptField = node("label", "field");
    elements.promptLabel = node("span", "field-label", label("nativeLoop.prompt"));
    elements.prompt = node("textarea", "field-input native-loop-prompt");
    elements.prompt.setAttribute("maxlength", String(PROMPT_MAX));
    elements.prompt.value = "";
    promptField.append(elements.promptLabel, elements.prompt);

    const intervalField = node("label", "field");
    elements.intervalLabel = node("span", "field-label", label("nativeLoop.intervalLabel"));
    elements.interval = node("input", "field-input native-loop-interval");
    elements.interval.setAttribute("type", "number");
    elements.interval.setAttribute("min", String(INTERVAL_MIN));
    elements.interval.setAttribute("max", String(INTERVAL_MAX));
    elements.interval.setAttribute("step", "1");
    elements.interval.value = "";
    intervalField.append(elements.intervalLabel, elements.interval);

    const statusField = node("label", "field");
    elements.statusLabel = node("span", "field-label", label("nativeLoop.statusLabel"));
    elements.status = node("select", "field-input native-loop-status");
    for (const status of STATUS_VALUES) {
      const option = node("option", "native-loop-status-option");
      option.value = status;
      option.textContent = statusText(status);
      elements.statusOptions[status] = option;
      elements.status.append(option);
    }
    elements.status.value = "ACTIVE";
    statusField.append(elements.statusLabel, elements.status);

    elements.form = node("div", "native-loop-form");
    elements.form.append(nameField, promptField, intervalField, statusField);

    elements.confirm = node("p", "wf-dialog-confirm");
    const actions = node("div", "wf-dialog-actions");
    elements.buttons.create = node("button", "primary-action", label("nativeLoop.create"));
    elements.buttons.create.setAttribute("type", "button");
    elements.buttons.create.setAttribute("data-loop-action", "create");
    elements.buttons.create.addEventListener("click", () => createLoop());
    elements.buttons.refresh = node("button", "wf-dialog-action", label("nativeLoop.refresh"));
    elements.buttons.refresh.setAttribute("type", "button");
    elements.buttons.refresh.setAttribute("data-loop-action", "refresh");
    elements.buttons.refresh.addEventListener("click", () => loadList());
    elements.buttons.check = node("button", "wf-dialog-action", label("nativeLoop.checkDelivery"));
    elements.buttons.check.setAttribute("type", "button");
    elements.buttons.check.setAttribute("data-loop-action", "check-delivery");
    elements.buttons.check.addEventListener("click", () => checkDelivery());
    elements.buttons.discard = node("button", "wf-dialog-action", label("nativeLoop.discard"));
    elements.buttons.discard.setAttribute("type", "button");
    elements.buttons.discard.setAttribute("data-loop-action", "discard");
    elements.buttons.discard.addEventListener("click", () => discardForm());
    elements.buttons.close = node("button", "wf-dialog-action", label("nativeLoop.close"));
    elements.buttons.close.setAttribute("type", "button");
    elements.buttons.close.setAttribute("data-loop-action", "close");
    elements.buttons.close.addEventListener("click", () => closeDialog(false));
    actions.append(elements.buttons.create, elements.buttons.refresh, elements.buttons.check, elements.buttons.discard, elements.buttons.close);

    root.append(
      elements.title,
      elements.statusLine,
      elements.listLimited,
      elements.list,
      elements.detail,
      elements.form,
      elements.confirm,
      actions
    );

    elements.name.addEventListener("input", () => markDirty(() => { current.name = elements.name.value; }));
    elements.prompt.addEventListener("input", () => markDirty(() => { current.prompt = elements.prompt.value; }));
    elements.interval.addEventListener("input", () =>
      markDirty(() => { current.interval = elements.interval.value; })
    );
    elements.status.addEventListener("change", () =>
      markDirty(() => {
        if (STATUS_VALUES.includes(elements.status.value)) current.status = elements.status.value;
      })
    );
    return root;
  }

  function show() {
    if (!root) return;
    try {
      if (typeof host?.showModal === "function") host.showModal(root);
      else root.showModal?.();
    } catch {
      // Modal presentation is host-owned.
    }
  }

  function closeDialog(remove) {
    if (!root) return;
    try {
      root.close?.();
    } catch {
      // The element is ours; close failures are harmless.
    }
    try {
      if (typeof host?.close === "function") host.close();
      if (remove) {
        if (typeof host?.removeChild === "function") host.removeChild(root);
        else root.remove?.();
        root = null;
        attached = false;
      }
    } catch {
      // Removing owned DOM must never throw into the host.
    }
  }

  async function loadList() {
    if (disposed) return;
    const ctx = context();
    if (!transportReady() || !ctx.connected || !ctx.threadId) {
      snapshot = null;
      render();
      return;
    }
    const target = ctx.threadId;
    const gen = generation;
    const ticket = ++listTicket;
    try {
      const result = await transport.execute({ action: "heartbeat.list", threadId: target, params: {} });
      if (disposed || gen !== generation || ticket !== listTicket) return;
      if (context().threadId !== target) return;
      if (!result || typeof result !== "object" || result.ok !== true || !Array.isArray(result.heartbeats)) {
        feedback("error", "nativeLoop.error.load");
        return;
      }
      if (result.threadId !== undefined && result.threadId !== target) return;
      const list = [];
      for (const raw of result.heartbeats) {
        const heartbeat = normalizeHeartbeat(raw, target, null);
        if (heartbeat) list.push(heartbeat);
      }
      snapshot = { threadId: target, list, complete: result.complete === true };
      reconcileUnknown(target);
      render();
    } catch (error) {
      if (disposed || gen !== generation || ticket !== listTicket) return;
      fail(error, "nativeLoop.error.load");
    }
  }

  async function viewLoop(id) {
    if (disposed || !root || mutationBusy) return;
    const ctx = context();
    if (!ctx.connected) {
      feedback("error", "nativeLoop.error.offline");
      return;
    }
    if (!ctx.threadId || !transportReady()) {
      feedback("error", "nativeLoop.error.unavailable");
      return;
    }
    const target = ctx.threadId;
    const gen = generation;
    const ticket = ++viewTicket;
    try {
      const result = await transport.execute({ action: "heartbeat.view", threadId: target, params: { id } });
      if (disposed || gen !== generation || ticket !== viewTicket) return;
      if (context().threadId !== target) return;
      const heartbeat = normalizeHeartbeat(result?.heartbeat, target, id);
      if (!heartbeat) {
        feedback("error", "nativeLoop.error.view");
        return;
      }
      detail = { threadId: target, heartbeat };
      reconcileUnknown(target);
      render();
    } catch (error) {
      if (disposed || gen !== generation || ticket !== viewTicket) return;
      fail(error, "nativeLoop.error.view");
    }
  }

  function beginMutation() {
    if (disposed || !root || mutationBusy) return null;
    const ctx = context();
    if (!ctx.connected) {
      feedback("error", "nativeLoop.error.offline");
      return null;
    }
    if (!ctx.threadId || !transportReady()) {
      feedback("error", "nativeLoop.error.unavailable");
      return null;
    }
    mutationBusy = true;
    render();
    return ctx;
  }

  async function createLoop() {
    if (disposed || !root || mutationBusy) return;
    const form = current;
    if (!form) return;
    if (form.pendingUnknown || form.requestId) {
      feedback("error", "nativeLoop.error.reconcile");
      return;
    }
    let params;
    try {
      params = buildLoopCreateParams({
        name: form.name,
        prompt: form.prompt,
        intervalMinutes: form.interval,
        status: form.status
      });
    } catch (error) {
      fail(error, "nativeLoop.error.failed");
      return;
    }
    const ctx = beginMutation();
    if (!ctx) return;
    const target = ctx.threadId;
    const gen = generation;
    const revisionAtStart = form.revision;
    // One request id per create intent; retained if the outcome is unknown.
    const requestId = newRequestId();
    form.requestId = requestId;
    form.pendingParams = { ...params };
    inFlightForm = form;
    render();
    try {
      const result = await transport.execute({ action: "heartbeat.create", threadId: target, params, requestId });
      if (disposed || gen !== generation) return;
      if (context().threadId !== target) return;
      if (result?.ok !== true || !normalizeHeartbeat(result.heartbeat, target, null)) {
        markUnknown(form);
        return;
      }
      if (current === form && form.revision === revisionAtStart) {
        const cleared = emptyForm();
        Object.assign(form, cleared, { revision: form.revision + 1 });
        drafts.delete(target);
        if (currentThreadId === target) applyFormToInputs();
      } else {
        form.requestId = null;
        form.pendingUnknown = false;
      }
      feedback("success", "nativeLoop.created");
      await loadList();
    } catch {
      if (disposed || gen !== generation) return;
      if (context().threadId !== target) return;
      // The request may or may not have landed natively: keep the id, keep the
      // typed form, and require an authoritative read before another create.
      markUnknown(form);
    } finally {
      inFlightForm = null;
      mutationBusy = false;
      render();
    }
  }

  function markUnknown(form) {
    form.pendingUnknown = true;
    form.dirty = true;
    if (current === form && currentThreadId) rememberDraft();
    feedback("unknown", "nativeLoop.unknownOutcome");
    render();
  }

  async function checkDelivery() {
    const form = current;
    if (!form?.pendingUnknown || !form.pendingParams || !form.requestId) return;
    const ctx = beginMutation(); if (!ctx) return;
    const gen = generation, target = ctx.threadId;
    try {
      // Same immutable intent: the backend ledger replays a known receipt and
      // never dispatches an unknown native creation a second time.
      const result = await transport.execute({ action: "heartbeat.create", threadId: target, params: { ...form.pendingParams }, requestId: form.requestId });
      if (disposed || gen !== generation || context().threadId !== target) return;
      if (result?.ok !== true || !normalizeHeartbeat(result.heartbeat, target, null)) return;
      form.pendingUnknown = false; form.requestId = null; form.pendingParams = null;
      feedback("success", "nativeLoop.created");
      await loadList();
    } catch (error) { if (!disposed && gen === generation) fail(error, "nativeLoop.error.reconcile"); }
    finally { mutationBusy = false; render(); }
  }

  async function toggleLoop(id, action, doneKey) {
    const heartbeat = findLoop(id);
    if (!heartbeat) {
      feedback("error", "nativeLoop.error.notFound");
      return;
    }
    const ctx = beginMutation();
    if (!ctx) return;
    const target = ctx.threadId;
    const gen = generation;
    const requestId = newRequestId();
    try {
      const result = await transport.execute({ action, threadId: target, params: { id }, requestId });
      if (disposed || gen !== generation) return;
      if (context().threadId !== target) return;
      if (result && typeof result === "object" && result.ok === false) {
        feedback("error", "nativeLoop.error.failed");
        return;
      }
      feedback("success", doneKey);
      await loadList();
    } catch (error) {
      if (disposed || gen !== generation) return;
      if (context().threadId !== target) return;
      fail(error, "nativeLoop.error.failed");
    } finally {
      mutationBusy = false;
      render();
    }
  }

  function deleteReview(heartbeat) {
    return label("nativeLoop.confirmDelete", {
      name: heartbeat.name,
      id: heartbeat.id,
      interval: intervalText(heartbeat.intervalMinutes)
    });
  }

  async function deleteLoop(id) {
    const heartbeat = findLoop(id);
    if (!heartbeat) {
      feedback("error", "nativeLoop.error.notFound");
      return;
    }
    const ctx = beginMutation();
    if (!ctx) return;
    const target = ctx.threadId;
    const base = { action: "heartbeat.delete", threadId: target, params: { id } };
    const gen = generation;
    try {
      const samePending =
        pendingDelete &&
        pendingDelete.base.action === base.action &&
        pendingDelete.base.threadId === base.threadId &&
        pendingDelete.base.params.id === id;
      if (!samePending) {
        if (pendingDelete && pendingDelete.base.threadId !== target) {
          pendingDelete = null;
          render();
          feedback("error", "nativeLoop.error.staleContext");
          return;
        }
        if (typeof transport?.prepareConfirmation !== "function") {
          feedback("error", "nativeLoop.error.unavailable");
          return;
        }
        pendingDelete = null;
        render();
        let receipt;
        try {
          receipt = await transport.prepareConfirmation(base);
        } catch (error) {
          if (disposed || gen !== generation) return;
          fail(error, "nativeLoop.error.confirmation");
          return;
        }
        if (disposed || gen !== generation) return;
        if (context().threadId !== target) {
          feedback("error", "nativeLoop.error.staleContext");
          return;
        }
        const normalized = normalizeReceipt(receipt, base);
        if (!normalized) {
          feedback("error", "nativeLoop.error.confirmation");
          return;
        }
        pendingDelete = { base, receipt: normalized, review: deleteReview(heartbeat), heartbeatId: id };
        render();
        feedback("confirm", "nativeLoop.confirmPending");
        return;
      }
      const pending = pendingDelete;
      pendingDelete = null;
      render();
      if (context().threadId !== pending.base.threadId) {
        feedback("error", "nativeLoop.error.staleContext");
        return;
      }
      if (pending.receipt.expiresAt && Date.parse(pending.receipt.expiresAt) <= Date.now()) {
        feedback("error", "nativeLoop.error.confirmationExpired");
        return;
      }
      // The second explicit click still requires the loop to exist natively.
      if (!findLoop(id)) {
        feedback("error", "nativeLoop.error.notFound");
        return;
      }
      const requestId = newRequestId();
      const result = await transport.execute({
        action: pending.base.action,
        threadId: pending.base.threadId,
        params: { id: pending.base.params.id },
        requestId,
        confirmationId: pending.receipt.confirmationId
      });
      if (disposed || gen !== generation) return;
      if (context().threadId !== pending.base.threadId) return;
      if (result && typeof result === "object" && result.ok === false) {
        feedback("error", "nativeLoop.error.failed");
        return;
      }
      if (detail?.heartbeat.id === id) detail = null;
      feedback("success", "nativeLoop.deleted");
      await loadList();
    } catch (error) {
      if (disposed || gen !== generation) return;
      if (context().threadId !== target && context().threadId !== pendingDelete?.base?.threadId) return;
      pendingDelete = null;
      fail(error, "nativeLoop.error.failed");
    } finally {
      mutationBusy = false;
      render();
    }
  }

  function discardForm() {
    if (!current) return;
    const cleared = emptyForm();
    Object.assign(current, cleared, { revision: current.revision + 1 });
    if (currentThreadId) drafts.delete(currentThreadId);
    pendingDelete = null;
    applyFormToInputs();
    render();
  }

  async function openLoops() {
    if (disposed) return;
    build();
    const threadId = context().threadId;
    if (!current || currentThreadId !== threadId) {
      rememberDraft();
      restoreForm(threadId);
    } else {
      applyFormToInputs();
    }
    render();
    if (!attached) {
      attached = true;
      try {
        host?.append?.(root);
      } catch {
        // Mounting is host-owned; the modal call may attach instead.
      }
    }
    show();
    render();
    return loadList();
  }

  function contextChanged() {
    if (!disposed) {
      if (inFlightForm) {
        inFlightForm.pendingUnknown = true;
        inFlightForm.dirty = true;
      }
      rememberDraft();
    }
    generation += 1;
    current = null;
    currentThreadId = null;
    inFlightForm = null;
    snapshot = null;
    detail = null;
    pendingDelete = null;
    closeDialog(true);
  }

  function dispose() {
    disposed = true;
    generation += 1;
    snapshot = null;
    detail = null;
    pendingDelete = null;
    inFlightForm = null;
    closeDialog(true);
    root = null;
  }

  return {
    openLoops,
    contextChanged,
    refreshLabels: render,
    dispose,
    hasUnsavedDraft: () =>
      !!current && (current.dirty === true || current.pendingUnknown === true || !!current.requestId)
  };
}
