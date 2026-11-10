import { approvalChoices, classifyInteractionRequest, interactionKey, validateInteractionResponse, fileApprovalChanges } from "./interaction-contracts.js";

export class InteractionViewState {
  constructor() { this.entries = new Map(); this.resolved = new Set(); this.connected = false; this.epoch = null; }

  ingest(request, status) {
    if (classifyInteractionRequest(request).support === "ignore") return;
    const key = interactionKey(request.id);
    if (this.resolved.has(key)) return;
    const previous = this.entries.get(key);
    const next = previous?.status === "uncertain" ? "uncertain" : status || previous?.status || (this.connected ? "pending" : "unverified");
    this.entries.set(key, { request, status: next });
  }

  resolve(id) {
    const key = interactionKey(id); this.entries.delete(key); this.resolved.add(key);
    if (this.resolved.size > 512) this.resolved.delete(this.resolved.values().next().value);
  }

  setConnected(value) {
    this.connected = Boolean(value);
    if (!value) for (const entry of this.entries.values()) entry.status = entry.status === "submitting" || entry.status === "uncertain" ? "uncertain" : "unverified";
  }

  reconcile(requests, { authoritative = false, epoch = null, states = [], connected = this.connected } = {}) {
    if (this.epoch !== null && epoch !== null && this.epoch !== epoch) { this.entries.clear(); this.resolved.clear(); }
    if (epoch !== null) this.epoch = epoch;
    this.connected = Boolean(connected);
    const stateMap = new Map(states.map(state => [interactionKey(state.id), state.status]));
    const keys = new Set(requests.map(request => interactionKey(request.id)));
    if (authoritative) for (const entry of [...this.entries.values()]) if (!keys.has(interactionKey(entry.request.id))) this.resolve(entry.request.id);
    for (const request of requests) this.ingest(request, stateMap.get(interactionKey(request.id)) || (authoritative && connected ? "pending" : undefined));
  }

  begin(id, result) {
    const entry = this.entries.get(interactionKey(id));
    if (!entry || !this.connected || entry.status !== "pending") throw new Error("Request is not available for a response");
    const validated = validateInteractionResponse(entry.request, result);
    entry.status = "submitting";
    return validated;
  }

  fail(id, error) {
    const entry = this.entries.get(interactionKey(id)); if (!entry) return;
    if (error.code === "REQUEST_RESOLVED") return this.resolve(id);
    entry.status = error.code === "INVALID_INTERACTION_RESPONSE" ? "pending" : "uncertain";
  }
}

const defaults = {
  title: "Codex needs your response", permissions: "Requested permissions", question: "Question", form: "Tool needs information", url: "Complete the secure step",
  pending: "Waiting for your response", submitting: "Sending response…", uncertain: "Delivery uncertain — check the Codex app. Do not submit again.", unverified: "Reconnect or check the Codex app to verify this request.",
  desktop: "Continue in the Codex app", desktopDetail: "This request cannot be answered safely here. It remains available in the Codex app.",
  allow: "Allow once", deny: "Decline", cancel: "Cancel", cancelTurn: "Decline and stop turn", submit: "Submit answer", skip: "Skip", other: "Other / type an answer", choose: "Choose…",
  turnOnly: "This grant is for this turn only. Persistent rules and special filesystem grants must be handled in the Codex app.",
  openUrl: "Open secure page", flowConfirmed: "I completed the requested step", yes: "Yes", no: "No", invalid: "Check the input fields and try again.", thread: "Conversation"
};

export function createInteractionController({ container, sendResponse, t = () => "", document: doc = container.ownerDocument }) {
  const state = new InteractionViewState();
  const cards = new Map();
  let threadId = "";
  let nextControl = 1;
  const label = key => { const value = t(`interaction.${key}`); return value && value !== `interaction.${key}` ? value : defaults[key] || key; };
  const element = (tag, className, text) => { const node = doc.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = String(text); return node; };
  const threadFor = request => String(request.params?.threadId || request.params?.thread_id || request.params?.conversationId || "");
  const clearSecrets = card => { for (const input of card.querySelectorAll('input[type="password"]')) input.value = ""; };
  container.setAttribute("aria-live", "polite");

  async function submit(request, result, view) {
    let validated;
    try { validated = state.begin(request.id, result); }
    catch { view.error.textContent = label("invalid"); return; }
    render();
    try { await sendResponse(request.id, validated); state.resolve(request.id); }
    catch (error) { state.fail(request.id, error); if (error.code === "INVALID_INTERACTION_RESPONSE") view.error.textContent = label("invalid"); }
    finally { clearSecrets(view.card); render(); }
  }

  function button(view, text, result, className = "") {
    const node = element("button", `approval-button ${className}`, text); node.type = "button";
    node.addEventListener("click", () => { void submit(view.request, typeof result === "function" ? result() : result, view); });
    view.actions.append(node); return node;
  }

  function fieldRow(form, name, text) {
    const row = element("label", "question-field"); row.append(element("span", "", text));
    const id = `interaction-field-${nextControl++}`; row.htmlFor = id;
    form.append(row); return { row, id, name };
  }

  function renderQuestions(view) {
    const form = element("form", "question-form"); const controls = [];
    for (const question of view.request.params.questions) {
      const field = fieldRow(form, question.id, question.question);
      if (question.options?.length) {
        const select = element("select", "field"); select.id = field.id; select.required = true; select.setAttribute("aria-label", question.question);
        const empty = element("option", "", label("choose")); empty.value = ""; empty.disabled = true; empty.selected = true; select.append(empty);
        question.options.forEach((option, index) => { const node = element("option", "", option.label); node.value = String(index); node.title = option.description || ""; select.append(node); });
        const custom = element("input", "field"); custom.type = "text"; custom.maxLength = 16384; custom.hidden = true; custom.disabled = true; custom.setAttribute("aria-label", label("other"));
        if (question.isOther) { const option = element("option", "", label("other")); option.value = "other"; select.append(option); }
        select.addEventListener("change", () => { const active = select.value === "other"; custom.hidden = !active; custom.disabled = !active; custom.required = active; });
        field.row.append(select, custom);
        controls.push({ question, read: () => select.value === "other" ? custom.value : question.options[Number(select.value)]?.label || "" });
      } else {
        const input = element("input", "field"); input.type = question.isSecret ? "password" : "text"; input.id = field.id; input.maxLength = 16384; input.autocomplete = "off"; field.row.append(input);
        controls.push({ question, read: () => input.value });
      }
    }
    const actions = element("div", "approval-actions"); const send = element("button", "approval-button accept", label("submit")); send.type = "submit"; actions.append(send); form.append(actions);
    const skip = element("button", "approval-button decline", label("skip")); skip.type = "button"; skip.addEventListener("click", () => { void submit(view.request, { answers: {} }, view); }); actions.append(skip);
    form.addEventListener("submit", event => {
      event.preventDefault(); if (!form.reportValidity()) return;
      const answers = Object.fromEntries(controls.map(({ question, read }) => { const value = read(); return [question.id, { answers: value ? [value] : [] }]; }));
      void submit(view.request, { answers }, view);
    });
    view.card.append(form);
  }

  function renderForm(view) {
    const form = element("form", "question-form"); const controls = [];
    const schema = view.request.params.requestedSchema;
    for (const [name, definition] of Object.entries(schema.properties)) {
      const field = fieldRow(form, name, definition.title || name);
      const required = (schema.required || []).includes(name);
      let input, read;
      const values = definition.enum || (definition.type === "boolean" ? [true, false] : null);
      if (values) {
        input = element("select", "field"); const placeholder = element("option", "", label("choose")); placeholder.value = ""; input.append(placeholder);
        values.forEach((value, index) => { const option = element("option", "", typeof value === "boolean" ? label(value ? "yes" : "no") : value); option.value = String(index); input.append(option); });
        read = () => input.value === "" ? undefined : values[Number(input.value)];
      } else {
        input = element("input", "field"); input.type = ["integer", "number"].includes(definition.type) ? "number" : "text";
        if (input.type === "number") { input.step = definition.type === "integer" ? "1" : "any"; if (definition.minimum != null) input.min = String(definition.minimum); if (definition.maximum != null) input.max = String(definition.maximum); }
        else { input.maxLength = definition.maxLength ?? 16384; if (definition.minLength != null) input.minLength = definition.minLength; }
        read = () => input.value === "" ? undefined : input.type === "number" ? Number(input.value) : input.value;
      }
      input.id = field.id; input.required = required; input.autocomplete = "off"; input.setAttribute("aria-label", definition.title || name); field.row.append(input);
      if (definition.description) field.row.append(element("small", "", definition.description));
      controls.push({ name, read });
    }
    const actions = element("div", "approval-actions"); const send = element("button", "approval-button accept", label("submit")); send.type = "submit"; actions.append(send); form.append(actions); view.card.append(form);
    form.addEventListener("submit", event => { event.preventDefault(); if (!form.reportValidity()) return; const content = Object.fromEntries(controls.map(c => [c.name, c.read()]).filter(([, value]) => value !== undefined)); void submit(view.request, { action: "accept", content }, view); });
    view.actions = actions;
    button(view, label("deny"), { action: "decline", content: null }, "decline");
    button(view, label("cancel"), { action: "cancel", content: null }, "decline");
  }

  function createCard(request) {
    const kind = classifyInteractionRequest(request);
    const card = element("div", "approval-card interaction-card"); card.dataset.requestKey = interactionKey(request.id);
    const view = { card, request, status: element("p", "interaction-status"), error: element("p", "interaction-error"), actions: element("div", "approval-actions"), fingerprint: JSON.stringify(request), flow: null };
    const heading = kind.support === "desktop" ? label("desktop") : label(kind.kind === "approval" ? "title" : kind.kind);
    card.append(element("strong", "", heading));
    card.append(element("small", "interaction-context", `${label("thread")}: ${threadFor(request) || "—"}`));
    view.status.setAttribute("role", "status"); card.append(view.status);
    if (kind.support === "desktop") card.append(element("p", "", label("desktopDetail")));
    else if (kind.kind === "approval") {
      const p = request.params || {}; const command = Array.isArray(p.command) ? p.command.map(part => JSON.stringify(part)).join(" ") : p.command || "";
      card.append(element("pre", "interaction-summary", [p.kind, p.cwd, command, p.reason].filter(Boolean).join("\n") || request.method));
      for (const key of ["additionalPermissions", "networkApprovalContext"]) if (p[key]) card.append(element("pre", "interaction-summary", `${key}\n${JSON.stringify(p[key], null, 2)}`));
      for (const change of fileApprovalChanges(request) || []) {
        card.append(element("strong", "interaction-context", `${change.kind}: ${change.path}${change.movePath ? ` → ${change.movePath}` : ""}`), element("pre", "interaction-summary", change.diff));
      }
      for (const choice of approvalChoices(request)) button(view, label(choice.action === "cancel" ? "cancelTurn" : choice.action), choice.result, choice.action === "allow" ? "accept" : "decline");
      card.append(view.actions);
    } else if (kind.kind === "permissions") {
      card.append(element("p", "", request.params.reason || ""), element("pre", "interaction-summary", JSON.stringify(request.params.permissions, null, 2)), element("p", "", label("turnOnly")));
      button(view, label("allow"), { permissions: structuredClone(request.params.permissions), scope: "turn" }, "accept");
      button(view, label("deny"), { permissions: {}, scope: "turn" }, "decline"); card.append(view.actions);
    } else if (kind.kind === "question") renderQuestions(view);
    else if (kind.kind === "form") { card.append(element("p", "", request.params.message || "")); renderForm(view); }
    else if (kind.kind === "url") {
      card.append(element("p", "", request.params.message || ""));
      const link = element("a", "approval-button", label("openUrl")); link.href = request.params.url; link.target = "_blank"; link.rel = "noopener noreferrer"; card.append(link);
      const row = element("label", "question-field"); view.flow = element("input", ""); view.flow.type = "checkbox"; row.append(view.flow, doc.createTextNode(label("flowConfirmed"))); card.append(row);
      const accept = button(view, label("submit"), { action: "accept", content: null }, "accept"); accept.dataset.flowAccept = "1"; view.flow.addEventListener("change", render);
      button(view, label("deny"), { action: "decline", content: null }, "decline"); button(view, label("cancel"), { action: "cancel", content: null }, "decline"); card.append(view.actions);
    }
    card.append(view.error); return view;
  }

  function render() {
    const visible = new Set();
    for (const [key, entry] of state.entries) {
      const requestThread = threadFor(entry.request);
      if (requestThread && requestThread !== threadId) continue;
      visible.add(key); let view = cards.get(key);
      if (view && view.fingerprint !== JSON.stringify(entry.request)) { clearSecrets(view.card); view.card.remove(); cards.delete(key); view = null; }
      if (!view) { view = createCard(entry.request); cards.set(key, view); container.append(view.card); }
      const capability = classifyInteractionRequest(entry.request);
      const active = state.connected && entry.status === "pending" && capability.support === "web";
      view.status.textContent = capability.support === "desktop" ? label("desktop") : label(entry.status);
      view.card.dataset.interactionState = entry.status;
      for (const node of view.card.querySelectorAll("input,select,button")) {
        node.disabled = !active || node.hidden || (node.dataset.flowAccept === "1" && !view.flow?.checked);
      }
      if (!active) clearSecrets(view.card);
    }
    for (const [key, view] of cards) if (!visible.has(key)) { clearSecrets(view.card); view.card.remove(); cards.delete(key); }
    container.classList.toggle("hidden", cards.size === 0);
  }

  return {
    state,
    receive(request) { state.ingest(request); render(); },
    resolve(id) { if (id != null) state.resolve(id); render(); },
    reconcile(requests, options) { state.reconcile(requests, options); render(); },
    updateState(id, status) { const entry = state.entries.get(interactionKey(id)); if (entry && ["pending", "submitting", "uncertain", "unverified"].includes(status)) { if (entry.status !== "uncertain" || status === "uncertain") entry.status = status; } render(); },
    setConnected(value) { state.setConnected(value); render(); },
    setContext(id) { threadId = String(id || ""); render(); },
    destroy() { for (const view of cards.values()) clearSecrets(view.card); cards.clear(); state.entries.clear(); container.replaceChildren(); }
  };
}
