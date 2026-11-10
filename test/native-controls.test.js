import test from "node:test";
import assert from "node:assert/strict";

import { buildGoalSetParams, createNativeControls } from "../public/native-controls.js";
import { nativeGoalMessages } from "../public/native-controls-messages.js";

const VERSION = "b".repeat(64);
const GOAL = { objective: "Ship the goal", status: "active", tokenBudget: 5000, usage: { tokensUsed: 120, timeUsedSeconds: 30 } };

function fakeDocument() {
  return {
    createElement(tag) {
      const listeners = new Map();
      const node = {
        tagName: String(tag).toUpperCase(), className: "", textContent: "", value: "", checked: false,
        disabled: false, attributes: new Map(), children: [], parent: null, closed: false,
        addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn); },
        removeEventListener(type, fn) { listeners.set(type, (listeners.get(type) || []).filter((f) => f !== fn)); },
        dispatch(type) {
          const results = (listeners.get(type) || []).map((fn) => fn({ type, target: node }));
          return Promise.all(results);
        },
        append(...nodes) { for (const child of nodes) { child.parent = node; node.children.push(child); } },
        setAttribute(name, value) { node.attributes.set(name, String(value)); },
        getAttribute(name) { return node.attributes.has(name) ? node.attributes.get(name) : null; },
        remove() { node.removed = true; if (node.parent) node.parent.children = node.parent.children.filter((c) => c !== node); },
        close() { node.closed = true; }
      };
      return node;
    }
  };
}

function fakeHost() {
  return {
    children: [], modal: null,
    append(node) { node.parent = this; this.children.push(node); },
    removeChild(node) { this.children = this.children.filter((c) => c !== node); node.parent = null; },
    showModal(node) { this.modal = node; },
    close() { this.modal = null; }
  };
}

function fakeTransport(overrides = {}) {
  const calls = { goal: [], prepare: [], execute: [] };
  return {
    calls,
    async getGoal(payload) {
      calls.goal.push(payload);
      return overrides.getGoal ? overrides.getGoal(payload) : { threadId: payload.threadId, goal: { ...GOAL }, version: VERSION };
    },
    async prepareConfirmation(payload) {
      calls.prepare.push(payload);
      return overrides.prepare ? overrides.prepare(payload) : {
        confirmationId: "conf-1", action: payload.action, threadId: payload.threadId,
        expiresAt: new Date(Date.now() + 60000).toISOString()
      };
    },
    async execute(payload) {
      calls.execute.push(payload);
      return overrides.execute ? overrides.execute(payload) : { threadId: payload.threadId, goal: { ...GOAL }, version: VERSION };
    }
  };
}

function setup(options = {}) {
  const document = fakeDocument();
  const host = fakeHost();
  const transport = options.transport || fakeTransport();
  const feedback = [];
  const state = { threadId: options.threadId ?? "thread-1", connected: options.connected ?? true };
  const controls = createNativeControls({
    document, host, transport,
    getContext: () => ({ ...state }),
    t: options.t || ((key) => key),
    onFeedback: (entry) => feedback.push(entry),
    registerMessages: options.registerMessages === false ? undefined : () => {}
  });
  return { controls, host, transport, feedback, state };
}

const all = (node, out = []) => {
  for (const child of node.children || []) { out.push(child); all(child, out); }
  return out;
};
const byClass = (root, cls) => all(root).find((n) => String(n.className).split(/\s+/).includes(cls));
const byGoal = (root, name) => all(root).find((n) => n.getAttribute("data-goal") === name);

test("newer edits survive an awaited save and double submit emits one mutation",async()=>{
  let resolve;const pending=new Promise(done=>resolve=done);
  const ctx=setup({transport:fakeTransport({execute:()=>pending})});
  await ctx.controls.openGoal();const dialog=ctx.host.modal;
  const field=byClass(dialog,"goal-objective");field.value="first edit";field.dispatch("input");
  const first=byGoal(dialog,"save").dispatch("click");
  await byGoal(dialog,"save").dispatch("click");
  assert.equal(ctx.transport.calls.execute.length,1);
  field.value="newer edit";field.selectionStart=3;field.selectionEnd=5;field.dispatch("input");
  resolve({threadId:"thread-1",goal:{...GOAL,objective:"first edit"},version:VERSION});await first;
  assert.equal(field.value,"newer edit");assert.equal(ctx.controls.hasUnsavedDraft(),true);
  assert.equal(field.selectionStart,3);assert.equal(field.selectionEnd,5);
});

test("forced context changes park drafts by thread without leaking them to another thread",async()=>{
  const ctx=setup();await ctx.controls.openGoal();
  let field=byClass(ctx.host.modal,"goal-objective");field.value="private thread one draft";field.dispatch("input");
  ctx.state.threadId="thread-2";ctx.controls.contextChanged();await ctx.controls.openGoal();
  field=byClass(ctx.host.modal,"goal-objective");assert.equal(field.value,GOAL.objective);assert.equal(ctx.controls.hasUnsavedDraft(),false);
  ctx.state.threadId="thread-1";ctx.controls.contextChanged();await ctx.controls.openGoal();
  assert.equal(byClass(ctx.host.modal,"goal-objective").value,"private thread one draft");assert.equal(ctx.controls.hasUnsavedDraft(),true);
  await byGoal(ctx.host.modal,"discard").dispatch("click");assert.equal(ctx.controls.hasUnsavedDraft(),false);
});

test("complete and clear cannot be invoked without an existing native goal",async()=>{
  const ctx=setup({transport:fakeTransport({getGoal:()=>({threadId:"thread-1",goal:null,version:"none"})})});await ctx.controls.openGoal();
  const dialog=ctx.host.modal;assert.equal(byGoal(dialog,"clear").disabled,true);assert.equal(byGoal(dialog,"complete").disabled,true);
  await byGoal(dialog,"clear").dispatch("click");assert.equal(ctx.transport.calls.prepare.length,0);
});

test("goal.set params omit, preserve, or explicitly remove the native budget", () => {
  assert.deepEqual(buildGoalSetParams({ objective: "  ship it  ", budgetText: "  ", removeBudget: false }), { objective: "  ship it  " });
  assert.deepEqual(buildGoalSetParams({ budgetText: "", removeBudget: false, expectedVersion: VERSION }), { expectedVersion: VERSION });
  assert.deepEqual(buildGoalSetParams({ budgetText: "900", removeBudget: false }), { tokenBudget: 900 });
  assert.deepEqual(buildGoalSetParams({ removeBudget: true }), { tokenBudget: null });
  assert.deepEqual(buildGoalSetParams({ removeBudget: true, budgetText: "900" }), { tokenBudget: null });
});

test("goal.set params reject unsafe budgets and bad objectives", () => {
  for (const budgetText of ["0", "-5", "1.5", "1e5", "abc", "9007199254740993"]) {
    assert.throws(() => buildGoalSetParams({ budgetText }), (error) => error.code === "nativeGoal.error.budget", budgetText);
  }
  assert.throws(() => buildGoalSetParams({ objective: "   " }), /nativeGoal.error.objective/);
  assert.throws(() => buildGoalSetParams({ objective: "x".repeat(4001) }), /nativeGoal.error.objective/);
  assert.equal(buildGoalSetParams({ objective: "x".repeat(4000) }).objective.length, 4000);
});

test("opening and refreshing never mutate and pause sends only expectedVersion", async () => {
  const ctx = setup();
  await ctx.controls.openGoal();
  const dialog = ctx.host.modal;
  assert.ok(dialog.className.split(/\s+/).includes("wf-dialog"));
  assert.equal(dialog.children[0].tagName, "H2");
  assert.ok(byClass(dialog, "primary-action"));
  assert.equal(ctx.transport.calls.execute.length, 0);
  await ctx.controls.refresh();
  assert.equal(ctx.transport.calls.execute.length, 0);
  await byGoal(dialog, "toggle").dispatch("click");
  const payload = ctx.transport.calls.execute[0];
  assert.deepEqual(Object.keys(payload).sort(), ["action", "params", "requestId", "threadId"]);
  assert.equal(payload.action, "goal.pause");
  assert.deepEqual(payload.params, { expectedVersion: VERSION });
  assert.equal(payload.threadId, "thread-1");
  assert.match(payload.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test("clear needs a reviewed confirmation before a second explicit click", async () => {
  const ctx = setup();
  await ctx.controls.openGoal();
  const dialog = ctx.host.modal;
  const clear = byGoal(dialog, "clear");
  await clear.dispatch("click");
  assert.equal(ctx.transport.calls.execute.length, 0);
  assert.equal(ctx.transport.calls.prepare.length, 1);
  const prepared = ctx.transport.calls.prepare[0];
  assert.equal(prepared.action, "goal.clear");
  assert.deepEqual(prepared.params, {});
  assert.equal(prepared.requestId, undefined);
  assert.match(byClass(dialog, "wf-dialog-confirm").textContent, /thread-1/);
  await clear.dispatch("click");
  assert.equal(ctx.transport.calls.execute.length, 1);
  assert.equal(ctx.transport.calls.execute[0].confirmationId, "conf-1");
});

test("complete confirmation carries the same payload as the execution", async () => {
  const ctx = setup();
  await ctx.controls.openGoal();
  const complete = byGoal(ctx.host.modal, "complete");
  await complete.dispatch("click");
  assert.equal(ctx.transport.calls.execute.length, 0);
  const prepared = ctx.transport.calls.prepare[0];
  assert.equal(prepared.params.status, "complete");
  assert.equal(prepared.params.expectedVersion, VERSION);
  await complete.dispatch("click");
  const { requestId, confirmationId, ...rest } = ctx.transport.calls.execute[0];
  assert.deepEqual(rest, prepared);
  assert.equal(confirmationId, "conf-1");
  assert.ok(requestId);
});

test("a confirmation prepared for another thread is rejected as stale", async () => {
  let resolvePrepare;
  const transport = fakeTransport({ prepare: () => new Promise((resolve) => { resolvePrepare = resolve; }) });
  const ctx = setup({ transport });
  await ctx.controls.openGoal();
  const click = byGoal(ctx.host.modal, "clear").dispatch("click");
  ctx.state.threadId = "thread-2";
  resolvePrepare({ confirmationId: "conf-9", action: "goal.clear", threadId: "thread-1", expiresAt: new Date(Date.now() + 60000).toISOString() });
  await click;
  assert.equal(ctx.transport.calls.execute.length, 0);
  assert.equal(ctx.feedback.at(-1).code, "nativeGoal.error.staleContext");
});

test("late native results for another thread or after dispose are ignored", async () => {
  let resolveGoal;
  const transport = fakeTransport({ getGoal: () => new Promise((resolve) => { resolveGoal = resolve; }) });
  const ctx = setup({ transport });
  const opening = ctx.controls.openGoal();
  ctx.state.threadId = "thread-2";
  resolveGoal({ threadId: "thread-1", goal: { ...GOAL, objective: "stale" }, version: VERSION });
  await opening;
  assert.equal(byClass(ctx.host.modal, "goal-objective").value, "");
  assert.equal(ctx.transport.calls.execute.length, 0);

  const other = setup();
  const open = other.controls.openGoal();
  other.controls.dispose();
  await open;
  assert.equal(other.host.children.length, 0);
  assert.equal(other.transport.calls.execute.length, 0);
});

test("locale refresh relabels without reloading or dropping the draft", async () => {
  const ctx = setup();
  await ctx.controls.openGoal();
  const dialog = ctx.host.modal;
  const objective = byClass(dialog, "goal-objective");
  const budget = byClass(dialog, "goal-budget");
  objective.value = "typed draft";
  objective.dispatch("input");
  budget.value = "1234";
  budget.dispatch("input");
  assert.equal(ctx.controls.hasUnsavedDraft(), true);
  const loads = ctx.transport.calls.goal.length;
  await ctx.controls.refresh();
  assert.equal(ctx.transport.calls.goal.length, loads, "editing must not reload native state");
  assert.equal(objective.value, "typed draft");
  assert.equal(budget.value, "1234");
  assert.equal(byGoal(dialog, "save").textContent, nativeGoalMessages.en["nativeGoal.save"]);
  assert.equal(byClass(dialog, "wf-dialog-usage").textContent, "Native usage: 120 tokens, 30s");
  await byGoal(dialog, "save").dispatch("click");
  assert.deepEqual(ctx.transport.calls.execute[0].params, { objective: "typed draft", tokenBudget: 1234, expectedVersion: VERSION });
  assert.equal(ctx.controls.hasUnsavedDraft(), false);
});

test("dispose removes owned DOM without native actions and keeps the draft flag", async () => {
  const ctx = setup();
  await ctx.controls.openGoal();
  const dialog = ctx.host.modal;
  const objective = byClass(dialog, "goal-objective");
  objective.value = "unsaved";
  objective.dispatch("input");
  ctx.controls.dispose();
  assert.equal(ctx.host.children.length, 0);
  assert.equal(ctx.host.modal, null);
  assert.equal(ctx.controls.hasUnsavedDraft(), true);
  await byGoal(dialog, "save").dispatch("click");
  await ctx.controls.refresh();
  assert.equal(ctx.transport.calls.execute.length, 0);
});

test("contextChanged closes the dialog and errors keep safe codes without stacks", async () => {
  const transport = fakeTransport({
    execute: async () => {
      throw Object.assign(new Error("boom"), { code: "nativeGoal.error.failed", stack: "at secret.js:1" });
    }
  });
  const ctx = setup({ transport });
  await ctx.controls.openGoal();
  const dialog = ctx.host.modal;
  await byGoal(dialog, "save").dispatch("click");
  const entry = ctx.feedback.at(-1);
  assert.equal(entry.kind, "error");
  assert.equal(entry.code, "nativeGoal.error.failed");
  assert.equal(typeof entry.label, "string");
  assert.equal(JSON.stringify(entry).includes("secret.js"), false);
  ctx.controls.contextChanged();
  assert.equal(ctx.host.modal, null);
  assert.equal(ctx.host.children.length, 0);
  await byGoal(dialog, "save").dispatch("click");
  assert.equal(ctx.transport.calls.execute.length, 1);
});

test("missing native functions or a lost connection show unavailable controls", async () => {
  const ctx = setup({ connected: false });
  await ctx.controls.openGoal();
  const dialog = ctx.host.modal;
  assert.equal(byClass(dialog, "wf-dialog-status").textContent, nativeGoalMessages.en["nativeGoal.offline"]);
  assert.equal(byClass(dialog, "goal-objective").value, "");
  assert.equal(byGoal(dialog, "save").disabled, true);
  await byGoal(dialog, "save").dispatch("click");
  assert.equal(ctx.transport.calls.execute.length, 0);

  const bare = setup({ transport: { getGoal: async () => ({}) } });
  await bare.controls.openGoal();
  assert.equal(byClass(bare.host.modal, "wf-dialog-status").textContent, nativeGoalMessages.en["nativeGoal.unavailable"]);
  assert.equal(bare.controls.hasUnsavedDraft(), false);
});
