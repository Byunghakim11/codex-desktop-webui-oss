import { nativeGoalMessages } from "./native-controls-messages.js";

const OBJECTIVE_MAX = 4000;
const HEX64 = /^[0-9a-f]{64}$/;

export class GoalValidationError extends Error {
  constructor(code) {
    super(code);
    this.name = "GoalValidationError";
    this.code = code;
  }
}

// Pure validation shared by the UI and tests. An empty budget keeps the native
// budget (tokenBudget omitted); removeBudget sends an explicit null.
export function buildGoalSetParams({ objective, budgetText, removeBudget, expectedVersion } = {}) {
  const params = {};
  if (objective !== undefined) {
    if (typeof objective !== "string") throw new GoalValidationError("nativeGoal.error.objective");
    const trimmed = objective.trim();
    if (trimmed === "" || objective.length > OBJECTIVE_MAX) throw new GoalValidationError("nativeGoal.error.objective");
    // Preserve an unchanged native objective byte-for-byte. Trimming it during
    // a budget-only edit would otherwise reset the native goal's usage.
    params.objective = objective;
  }
  if (removeBudget === true) {
    params.tokenBudget = null;
  } else if (budgetText !== undefined && budgetText !== null && String(budgetText).trim() !== "") {
    const text = String(budgetText).trim();
    if (!/^\d+$/.test(text)) throw new GoalValidationError("nativeGoal.error.budget");
    const value = Number(text);
    if (!Number.isSafeInteger(value) || value <= 0) throw new GoalValidationError("nativeGoal.error.budget");
    params.tokenBudget = value;
  }
  if (expectedVersion !== undefined) {
    if (typeof expectedVersion !== "string" || !HEX64.test(expectedVersion)) {
      throw new GoalValidationError("nativeGoal.error.version");
    }
    params.expectedVersion = expectedVersion;
  }
  return params;
}

export function createNativeControls({ document, host, transport, getContext, t, onFeedback, registerMessages } = {}) {
  if (typeof registerMessages === "function") {
    try {
      registerMessages(nativeGoalMessages);
    } catch {
      // Message registration belongs to the host; never break the controls.
    }
  }

  const messages = nativeGoalMessages.en;
  const elements = { buttons: {} };
  let disposed = false;
  let generation = 0;
  let snapshot = null;
  let dirty = false;
  let editsRevision = 0;
  let mutationBusy = false;
  let formThreadId = null;
  let pending = null;
  let root = null;
  let attached = false;
  // Per-thread unsaved drafts, RAM only (never localStorage) and bounded so a
  // long session cannot grow without limit.
  const drafts = new Map();
  const DRAFT_LIMIT = 8;

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

  function fail(error, fallback = "nativeGoal.error.failed") {
    const code =
      typeof error?.code === "string" && error.code.startsWith("nativeGoal.") ? error.code : fallback;
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
    return typeof transport?.getGoal === "function" && typeof transport?.execute === "function";
  }

  function normalizeSnapshot(result, threadId) {
    if (!result || typeof result !== "object") return null;
    if (result.threadId !== undefined && result.threadId !== threadId) return null;
    const version = typeof result.version === "string" && HEX64.test(result.version) ? result.version : "none";
    const goal = result.goal && typeof result.goal === "object"
      ? {
          objective: typeof result.goal.objective === "string" ? result.goal.objective : "",
          status: typeof result.goal.status === "string" ? result.goal.status : "unknown",
          tokenBudget:
            Number.isSafeInteger(result.goal.tokenBudget) && result.goal.tokenBudget > 0
              ? result.goal.tokenBudget
              : null,
          usage: {
            tokensUsed: Number.isFinite(result.goal.usage?.tokensUsed) ? result.goal.usage.tokensUsed : null,
            timeUsedSeconds: Number.isFinite(result.goal.usage?.timeUsedSeconds)
              ? result.goal.usage.timeUsedSeconds
              : null
          }
        }
      : null;
    return { threadId, goal, version: goal ? version : "none" };
  }

  function normalizeReceipt(receipt, base) {
    if (!receipt || typeof receipt !== "object") return null;
    const confirmationId =
      typeof receipt.confirmationId === "string" && receipt.confirmationId !== "" ? receipt.confirmationId : null;
    if (!confirmationId) return null;
    if (receipt.action !== undefined && receipt.action !== base.action) return null;
    if (receipt.threadId !== undefined && receipt.threadId !== base.threadId) return null;
    return {
      confirmationId,
      action: base.action,
      threadId: base.threadId,
      expiresAt: typeof receipt.expiresAt === "string" ? receipt.expiresAt : null
    };
  }

  function sameBase(a, b) {
    return (
      JSON.stringify({ action: a.action, threadId: a.threadId, params: a.params }) ===
      JSON.stringify({ action: b.action, threadId: b.threadId, params: b.params })
    );
  }

  function newRequestId() {
    try {
      const id = globalThis.crypto?.randomUUID?.();
      if (typeof id === "string" && id !== "") return id;
    } catch {
      // Fall through to a local identifier.
    }
    return `req-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function node(tag, className, text) {
    const created = document.createElement(tag);
    if (className) created.className = className;
    if (text !== undefined) created.textContent = text;
    return created;
  }

  function usageText(usage) {
    if (!usage || (usage.tokensUsed == null && usage.timeUsedSeconds == null)) return label("nativeGoal.usageEmpty");
    return label("nativeGoal.usage", { tokens: usage.tokensUsed ?? 0, seconds: usage.timeUsedSeconds ?? 0 });
  }

  function reviewFor(base) {
    const goal = snapshot?.goal ?? null;
    const params = base.params;
    const budget =
      params.tokenBudget === null
        ? label("nativeGoal.budgetNone")
        : params.tokenBudget !== undefined
          ? String(params.tokenBudget)
          : goal?.tokenBudget != null
            ? String(goal.tokenBudget)
            : label("nativeGoal.budgetNone");
    return label("nativeGoal.confirmReview", {
      thread: base.threadId,
      objective: params.objective ?? goal?.objective ?? label("nativeGoal.objectiveNone"),
      budget
    });
  }

  function rememberDraft(threadId) {
    if (!threadId || !dirty || !elements.objective) return;
    const number = (name) => (typeof elements.objective[name] === "number" ? elements.objective[name] : null);
    // Re-insert so the map keeps least-recently-saved entries at the front.
    drafts.delete(threadId);
    drafts.set(threadId, {
      objective: elements.objective.value,
      budget: elements.budget.value,
      removeBudget: elements.removeBudget.checked === true,
      selectionStart: number("selectionStart"),
      selectionEnd: number("selectionEnd"),
      selectionDirection:
        typeof elements.objective.selectionDirection === "string" ? elements.objective.selectionDirection : null
    });
    while (drafts.size > DRAFT_LIMIT) {
      const oldest = drafts.keys().next();
      if (oldest.done) break;
      drafts.delete(oldest.value);
    }
  }

  function applyDraft(threadId) {
    const draft = threadId ? drafts.get(threadId) : null;
    if (!draft || !elements.objective) {
      dirty = false;
      formThreadId = null;
      return;
    }
    elements.objective.value = draft.objective;
    elements.budget.value = draft.budget;
    elements.removeBudget.checked = draft.removeBudget === true;
    dirty = true;
    formThreadId = threadId;
    if (draft.selectionStart != null) {
      try {
        if (typeof elements.objective.setSelectionRange === "function") {
          elements.objective.setSelectionRange(
            draft.selectionStart,
            draft.selectionEnd ?? draft.selectionStart,
            draft.selectionDirection ?? "none"
          );
        }
      } catch {
        // Selection restore is advisory; the buffer above is what matters.
      }
      elements.objective.selectionStart = draft.selectionStart;
      elements.objective.selectionEnd = draft.selectionEnd ?? draft.selectionStart;
      if (draft.selectionDirection != null) elements.objective.selectionDirection = draft.selectionDirection;
    }
  }

  function render() {
    if (!root || disposed) return;
    const ctx = context();
    const goal = snapshot?.goal ?? null;
    elements.heading.textContent = label("nativeGoal.title");
    elements.objectiveLabel.textContent = label("nativeGoal.objective");
    elements.budgetLabel.textContent = label("nativeGoal.budget");
    elements.removeLabel.textContent = label("nativeGoal.removeBudget");
    elements.objective.setAttribute("placeholder", label("nativeGoal.objectivePlaceholder"));
    elements.budget.setAttribute("placeholder", label("nativeGoal.budgetHint"));
    elements.buttons.save.textContent = label("nativeGoal.save");
    elements.buttons.toggle.textContent = label(goal?.status === "paused" ? "nativeGoal.resume" : "nativeGoal.pause");
    elements.buttons.complete.textContent = label("nativeGoal.complete");
    elements.buttons.clear.textContent = label("nativeGoal.clear");
    elements.buttons.refresh.textContent = label("nativeGoal.refresh");
    elements.buttons.discard.textContent = label("nativeGoal.discard");
    elements.buttons.close.textContent = label("nativeGoal.close");
    if (!ctx.connected) elements.status.textContent = label("nativeGoal.offline");
    else if (!transportReady() || !ctx.threadId) elements.status.textContent = label("nativeGoal.unavailable");
    else if (!goal) elements.status.textContent = label("nativeGoal.noGoal");
    else elements.status.textContent = label("nativeGoal.status", { status: goal.status });
    elements.usage.textContent = goal ? usageText(goal.usage) : label("nativeGoal.usageEmpty");
    if (!dirty) {
      elements.objective.value = goal?.objective ?? "";
      elements.budget.value = goal?.tokenBudget == null ? "" : String(goal.tokenBudget);
      elements.removeBudget.checked = false;
    }
    const canMutate = ctx.connected && transportReady() && !!ctx.threadId && !mutationBusy;
    elements.buttons.save.disabled = !canMutate;
    // Complete and Clear only make sense against an existing native goal.
    elements.buttons.complete.disabled = !canMutate || !goal;
    elements.buttons.clear.disabled = !canMutate || !goal;
    elements.buttons.toggle.disabled = !canMutate || !goal;
    elements.buttons.refresh.disabled = mutationBusy || !transportReady() || !ctx.threadId;
    elements.buttons.discard.disabled = mutationBusy || !dirty;
    elements.confirm.textContent = pending ? pending.review : "";
  }

  function build() {
    if (root) return root;
    root = node("dialog", "wf-dialog");
    root.setAttribute("aria-label", label("nativeGoal.title"));
    elements.heading = node("h2", "wf-dialog-title", label("nativeGoal.title"));
    elements.status = node("p", "wf-dialog-status");
    elements.usage = node("p", "wf-dialog-usage");
    const objectiveField = node("label", "field");
    elements.objectiveLabel = node("span", "field-label", label("nativeGoal.objective"));
    elements.objective = node("textarea", "field-input goal-objective");
    elements.objective.value = "";
    objectiveField.append(elements.objectiveLabel, elements.objective);
    const budgetField = node("label", "field");
    elements.budgetLabel = node("span", "field-label", label("nativeGoal.budget"));
    elements.budget = node("input", "field-input goal-budget");
    elements.budget.setAttribute("type", "number");
    elements.budget.setAttribute("min", "1");
    elements.budget.setAttribute("step", "1");
    elements.budget.value = "";
    budgetField.append(elements.budgetLabel, elements.budget);
    const removeField = node("label", "field field-checkbox");
    elements.removeBudget = node("input", "field-checkbox-input goal-remove-budget");
    elements.removeBudget.setAttribute("type", "checkbox");
    elements.removeBudget.checked = false;
    elements.removeLabel = node("span", "field-label", label("nativeGoal.removeBudget"));
    removeField.append(elements.removeBudget, elements.removeLabel);
    elements.confirm = node("p", "wf-dialog-confirm");
    const actions = node("div", "wf-dialog-actions");
    const buttons = [
      ["save", "nativeGoal.save", onSave],
      ["toggle", "nativeGoal.pause", onToggle],
      ["complete", "nativeGoal.complete", onComplete],
      ["clear", "nativeGoal.clear", onClear],
      ["refresh", "nativeGoal.refresh", onRefresh],
      ["discard", "nativeGoal.discard", onDiscard],
      ["close", "nativeGoal.close", onClose]
    ];
    for (const [name, key, handler] of buttons) {
      const button = node("button", name === "save" ? "primary-action" : "wf-dialog-action", label(key));
      button.setAttribute("type", "button");
      button.setAttribute("data-goal", name);
      button.addEventListener("click", handler);
      elements.buttons[name] = button;
      actions.append(button);
    }
    root.append(
      elements.heading,
      elements.status,
      elements.usage,
      objectiveField,
      budgetField,
      removeField,
      elements.confirm,
      actions
    );
    const markDirty = () => {
      dirty = true;
      // Revision bumps let an in-flight mutation detect newer typing.
      editsRevision += 1;
      formThreadId = context().threadId;
      render();
    };
    elements.objective.addEventListener("input", markDirty);
    elements.budget.addEventListener("input", markDirty);
    elements.removeBudget.addEventListener("change", markDirty);
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
      // Ignore close failures; the element is ours.
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

  async function load() {
    if (disposed) return;
    const ctx = context();
    if (!transportReady() || !ctx.connected || !ctx.threadId) {
      snapshot = null;
      render();
      return;
    }
    const gen = ++generation;
    const threadId = ctx.threadId;
    try {
      const result = await transport.getGoal({ threadId });
      if (disposed || gen !== generation) return;
      if (context().threadId !== threadId) return;
      const normalized = normalizeSnapshot(result, threadId);
      if (!normalized) return;
      snapshot = normalized;
      render();
    } catch (error) {
      if (disposed || gen !== generation) return;
      snapshot = null;
      render();
      fail(error, "nativeGoal.error.load");
    }
  }

  function isConfirmationAction(action, params) {
    return action === "goal.clear" || (action === "goal.set" && params.status === "complete");
  }

  async function mutate(action, params) {
    // A closed/invalidated dialog owns no live controls, so detached clicks
    // must never reach the native transport.
    if (disposed || !root) return;
    // Take the busy lock before the first transport await so overlapping
    // clicks cannot double execute or re-prepare a confirmation.
    if (mutationBusy) return;
    const ctx = context();
    if (!ctx.connected) {
      feedback("error", "nativeGoal.error.offline");
      return;
    }
    if (!ctx.threadId || typeof transport?.execute !== "function") {
      feedback("error", "nativeGoal.error.unavailable");
      return;
    }
    if (isConfirmationAction(action, params) && !snapshot?.goal) {
      feedback("error", "nativeGoal.error.noGoal");
      return;
    }
    mutationBusy = true;
    render();
    try {
      await runMutation(action, params);
    } finally {
      // Unlock on every branch: success, stale context, failure or dispose.
      mutationBusy = false;
      render();
    }
  }

  async function runMutation(action, params) {
    if (disposed || !root) return;
    const base = { action, threadId: context().threadId, params };
    const needsConfirmation = isConfirmationAction(action, params);
    // Anything typed after this point is newer than the native result.
    const revisionAtStart = editsRevision;
    const gen = generation;
    let confirmationId;
    if (needsConfirmation) {
      const existing = pending && sameBase(pending.payload, base) ? pending : null;
      if (existing) {
        if (existing.receipt.expiresAt && Date.parse(existing.receipt.expiresAt) <= Date.now()) {
          pending = null;
          render();
          feedback("error", "nativeGoal.error.confirmationExpired");
          return;
        }
        if (context().threadId !== base.threadId) {
          pending = null;
          render();
          feedback("error", "nativeGoal.error.staleContext");
          return;
        }
        confirmationId = existing.receipt.confirmationId;
      } else {
        if (typeof transport?.prepareConfirmation !== "function") {
          feedback("error", "nativeGoal.error.unavailable");
          return;
        }
        pending = null;
        render();
        try {
          const receipt = normalizeReceipt(await transport.prepareConfirmation(base), base);
          if (disposed || gen !== generation) return;
          if (!receipt) {
            feedback("error", "nativeGoal.error.confirmation");
            return;
          }
          if (context().threadId !== base.threadId) {
            feedback("error", "nativeGoal.error.staleContext");
            return;
          }
          pending = { payload: base, receipt, review: reviewFor(base) };
          render();
          feedback("confirm", "nativeGoal.confirmReviewPending");
          return;
        } catch (error) {
          fail(error, "nativeGoal.error.confirmation");
          return;
        }
      }
    }
    const request = { ...base, requestId: newRequestId() };
    if (confirmationId) request.confirmationId = confirmationId;
    try {
      const result = await transport.execute(request);
      if (disposed || gen !== generation) return;
      if (context().threadId !== base.threadId) return;
      pending = null;
      const applied = normalizeSnapshot(result, base.threadId);
      // The success snapshot always refreshes the native version and usage.
      if (applied) snapshot = applied;
      // Only the revision that launched the mutation may have its dirty flag
      // cleared and its buffer repopulated; newer typing keeps buffer, caret
      // and the dirty flag intact (render skips inputs while dirty).
      if (editsRevision === revisionAtStart) {
        dirty = false;
        formThreadId = null;
        drafts.delete(base.threadId);
      } else {
        dirty = true;
        formThreadId = base.threadId;
      }
      render();
      const done =
        action === "goal.clear"
          ? "nativeGoal.cleared"
          : action === "goal.pause"
            ? "nativeGoal.paused"
            : action === "goal.resume"
              ? "nativeGoal.resumed"
              : "nativeGoal.saved";
      feedback("success", done);
      await load();
    } catch (error) {
      if (disposed || gen !== generation) return;
      pending = null;
      render();
      fail(error);
    }
  }

  function currentVersion() {
    return snapshot?.version && snapshot.version !== "none" ? snapshot.version : undefined;
  }

  function readSetParams() {
    return buildGoalSetParams({
      objective: elements.objective.value,
      budgetText: elements.budget.value,
      removeBudget: elements.removeBudget.checked === true,
      expectedVersion: currentVersion()
    });
  }

  async function onSave() {
    let params;
    try {
      params = readSetParams();
    } catch (error) {
      fail(error);
      return;
    }
    if (Object.keys(params).length === 0) {
      feedback("error", "nativeGoal.error.nothing");
      return;
    }
    return mutate("goal.set", params);
  }

  async function onComplete() {
    let params;
    try {
      params = readSetParams();
    } catch (error) {
      fail(error);
      return;
    }
    params.status = "complete";
    return mutate("goal.set", params);
  }

  async function onToggle() {
    const version = currentVersion();
    if (!version || !snapshot?.goal) {
      feedback("error", "nativeGoal.error.noGoal");
      return;
    }
    return mutate(snapshot.goal.status === "paused" ? "goal.resume" : "goal.pause", { expectedVersion: version });
  }

  async function onClear() {
    return mutate("goal.clear", {});
  }

  async function onRefresh() {
    return refresh();
  }

  async function onClose() {
    closeDialog(false);
  }

  function onDiscard() {
    drafts.delete(formThreadId || context().threadId);
    dirty=false;pending=null;render();closeDialog(false);
  }

  async function openGoal() {
    if (disposed) return;
    build();
    const threadId = context().threadId;
    if (!(dirty && formThreadId === threadId)) {
      // Never transfer one thread's buffer to another: park it under its own
      // id, then restore only the draft that matches the opened thread.
      if (dirty) rememberDraft(formThreadId);
      applyDraft(threadId);
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
    return load();
  }

  async function refresh() {
    if (disposed) return;
    // A refresh must not race an awaited mutation.
    if (mutationBusy) return;
    render();
    if (dirty) return;
    return load();
  }

  function contextChanged() {
    rememberDraft(formThreadId);
    generation += 1;
    editsRevision += 1;
    dirty=false;formThreadId=null;
    snapshot = null;
    pending = null;
    closeDialog(true);
  }

  function dispose() {
    disposed = true;
    generation += 1;
    snapshot = null;
    pending = null;
    closeDialog(true);
    root = null;
  }

  return {
    openGoal,
    refresh,
    refreshLabels: render,
    contextChanged,
    dispose,
    hasUnsavedDraft: () => dirty
  };
}
