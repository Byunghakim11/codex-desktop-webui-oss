import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildLoopCreateParams, createNativeLoopControls } from "../public/native-loop-controls.js";
import { nativeLoopMessages } from "../public/native-loop-messages.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

function defaultLoops() {
  return [
    { id: "hb-1", name: "Daily check", status: "ACTIVE", kind: "heartbeat", intervalMinutes: 30, targetThreadId: "thread-1", source: "thread-1" },
    { id: "hb-2", name: "Other target", status: "PAUSED", kind: "heartbeat", intervalMinutes: 60, targetThreadId: "thread-2", source: "thread-1" },
    { id: "hb-3", name: "Cron row", status: "ACTIVE", kind: "cron", intervalMinutes: 15, targetThreadId: "thread-1", source: "thread-1" },
    { id: "hb-4", name: "Other source", status: "ACTIVE", kind: "heartbeat", intervalMinutes: 45, targetThreadId: "thread-1", source: "thread-2" }
  ];
}

function defaultResult(payload, loops) {
  if (payload.action === "heartbeat.list") {
    return { ok: true, threadId: payload.threadId, heartbeats: loops, complete: false };
  }
  if (payload.action === "heartbeat.view") {
    const heartbeat = loops.find((entry) => entry.id === payload.params.id);
    return {
      threadId: payload.threadId,
      heartbeat: heartbeat ? { ...heartbeat, prompt: "Check native things" } : null
    };
  }
  return { ok: true, threadId: payload.threadId };
}

function fakeTransport(options = {}) {
  const calls = { execute: [], prepare: [] };
  const loops = options.loops || defaultLoops();
  return {
    calls,
    loops,
    async execute(payload) {
      calls.execute.push(payload);
      if (options.execute) return options.execute(payload, calls);
      return defaultResult(payload, loops);
    },
    async prepareConfirmation(payload) {
      calls.prepare.push(payload);
      if (options.prepare) return options.prepare(payload);
      return {
        confirmationId: "conf-1", action: payload.action, threadId: payload.threadId,
        expiresAt: new Date(Date.now() + 60000).toISOString()
      };
    }
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function setup(options = {}) {
  const document = fakeDocument();
  const host = fakeHost();
  const transport = options.transport || fakeTransport();
  const feedback = [];
  const state = { threadId: options.threadId ?? "thread-1", connected: options.connected ?? true };
  const controls = createNativeLoopControls({
    document, host, transport,
    getContext: () => ({ ...state }),
    t: options.t,
    onFeedback: (entry) => feedback.push(entry),
    registerMessages: options.registerMessages
  });
  return { controls, host, transport, feedback, state };
}

const all = (node, out = []) => {
  for (const child of node.children || []) { out.push(child); all(child, out); }
  return out;
};
const byClass = (root, cls) => all(root).find((n) => String(n.className).split(/\s+/).includes(cls));
const byAction = (root, action, id) => all(root).find((n) =>
  typeof n.getAttribute === "function" &&
  n.getAttribute("data-loop-action") === action &&
  (id === undefined || n.getAttribute("data-loop-id") === id)
);
const rows = (root) => all(root).filter((n) => String(n.className).split(/\s+/).includes("native-loop-row"));

async function fillValidForm(dialog, overrides = {}) {
  const name = byClass(dialog, "native-loop-name");
  const prompt = byClass(dialog, "native-loop-prompt");
  const interval = byClass(dialog, "native-loop-interval");
  const status = byClass(dialog, "native-loop-status");
  name.value = overrides.name ?? "Daily loop";
  prompt.value = overrides.prompt ?? "Check the pipeline";
  interval.value = overrides.interval ?? "30";
  status.value = overrides.status ?? "ACTIVE";
  name.dispatch("input");
  prompt.dispatch("input");
  interval.dispatch("input");
  status.dispatch("change");
}

test("messages stay bilingual, parity-complete, and register only once", async () => {
  const enKeys = Object.keys(nativeLoopMessages.en).sort();
  const koKeys = Object.keys(nativeLoopMessages.ko).sort();
  assert.deepEqual(koKeys, enKeys);
  for (const key of enKeys) assert.ok(key.startsWith("nativeLoop."), key);
  assert.equal(
    nativeLoopMessages.en["nativeLoop.listLimited"],
    "Only known loops are listed; native schedules may need refresh"
  );

  const registrations = [];
  const first = setup({ registerMessages: (value) => registrations.push(value) });
  assert.equal(registrations.length, 1);
  assert.deepEqual(registrations[0], nativeLoopMessages);
  const second = setup({ registerMessages: (value) => registrations.push(value) });
  assert.equal(registrations.length, 1, "messages must register once per module");

  await first.controls.openLoops();
  assert.equal(byClass(first.host.modal, "native-loop-name") !== undefined, true);
  assert.equal(all(first.host.modal).find((n) => String(n.className).includes("wf-dialog-title")).textContent, "Loops");
  second.controls.dispose();
  first.controls.dispose();
});

test("buildLoopCreateParams enforces native bounds and whitelists fields only", () => {
  const base = { name: "Daily loop", prompt: "Check the pipeline", intervalMinutes: 30, status: "ACTIVE" };
  assert.deepEqual(buildLoopCreateParams(base), {
    name: "Daily loop", prompt: "Check the pipeline", intervalMinutes: 30, status: "ACTIVE"
  });
  assert.equal(buildLoopCreateParams({ ...base, intervalMinutes: "1440" }).intervalMinutes, 1440);
  assert.equal(buildLoopCreateParams({ ...base, intervalMinutes: 1 }).intervalMinutes, 1);
  assert.equal(buildLoopCreateParams({ ...base, notificationPolicy: null }).notificationPolicy, null);
  assert.equal(
    buildLoopCreateParams({ ...base, notificationPolicy: "failed_runs_only" }).notificationPolicy,
    "failed_runs_only"
  );
  const params = buildLoopCreateParams(base);
  assert.deepEqual(Object.keys(params).sort(), ["intervalMinutes", "name", "prompt", "status"]);
  assert.equal(JSON.stringify(params).toUpperCase().includes("RRULE"), false);

  assert.equal(buildLoopCreateParams({ ...base, name: "x".repeat(200) }).name.length, 200);
  assert.throws(() => buildLoopCreateParams({ ...base, name: "x".repeat(201) }), (e) => e.code === "nativeLoop.error.name");
  assert.throws(() => buildLoopCreateParams({ ...base, name: "   " }), (e) => e.code === "nativeLoop.error.name");
  assert.equal(buildLoopCreateParams({ ...base, prompt: "x".repeat(8000) }).prompt.length, 8000);
  assert.throws(() => buildLoopCreateParams({ ...base, prompt: "x".repeat(8001) }), (e) => e.code === "nativeLoop.error.prompt");
  assert.throws(() => buildLoopCreateParams({ ...base, prompt: "" }), (e) => e.code === "nativeLoop.error.prompt");
  for (const intervalMinutes of ["0", "1441", "1.5", "abc", "-1", "1e3", 0, 1441, 1.5, NaN]) {
    assert.throws(() => buildLoopCreateParams({ ...base, intervalMinutes }), (e) => e.code === "nativeLoop.error.interval");
  }
  for (const status of ["active", "PAUSED ", "", undefined]) {
    assert.throws(() => buildLoopCreateParams({ ...base, status }), (e) => e.code === "nativeLoop.error.status");
  }
  assert.throws(
    () => buildLoopCreateParams({ ...base, notificationPolicy: "always" }),
    (e) => e.code === "nativeLoop.error.notificationPolicy"
  );
});

test("opening lists readonly rows, filters foreign rows, and shows the incomplete note", async () => {
  const ctx = setup();
  await ctx.controls.openLoops();
  const dialog = ctx.host.modal;
  assert.ok(dialog.className.split(/\s+/).includes("wf-dialog"));
  assert.ok(dialog.className.split(/\s+/).includes("native-loop-dialog"));
  assert.equal(ctx.transport.calls.execute.length, 1);
  const listCall = ctx.transport.calls.execute[0];
  assert.equal(listCall.action, "heartbeat.list");
  assert.deepEqual(listCall.params, {});
  assert.equal(listCall.requestId, undefined);
  assert.equal(ctx.transport.calls.prepare.length, 0);

  const rendered = rows(dialog);
  assert.equal(rendered.length, 1);
  assert.equal(byClass(rendered[0], "native-loop-row-name").textContent, "Daily check");
  assert.equal(byClass(rendered[0], "native-loop-row-interval").textContent, "30 minutes");
  assert.ok(byClass(rendered[0], "native-loop-row-status").textContent.length > 0);
  assert.equal(
    byClass(dialog, "native-loop-incomplete").textContent,
    nativeLoopMessages.en["nativeLoop.listLimited"]
  );

  const before = ctx.transport.calls.execute.length;
  await byAction(dialog, "view", "hb-1").dispatch("click");
  const viewCall = ctx.transport.calls.execute.at(-1);
  assert.equal(ctx.transport.calls.execute.length, before + 1);
  assert.equal(viewCall.action, "heartbeat.view");
  assert.deepEqual(viewCall.params, { id: "hb-1" });
  assert.equal(byClass(dialog, "native-loop-detail-prompt").textContent, "Check native things");
  assert.equal(ctx.transport.calls.execute.some((call) => call.action === "heartbeat.create"), false);
});

test("create bounds block transport calls and a valid form sends exact native params", async () => {
  const ctx = setup();
  await ctx.controls.openLoops();
  const dialog = ctx.host.modal;
  const create = byAction(dialog, "create");
  const baseline = ctx.transport.calls.execute.length;

  const name = byClass(dialog, "native-loop-name");
  const prompt = byClass(dialog, "native-loop-prompt");
  const interval = byClass(dialog, "native-loop-interval");
  const status = byClass(dialog, "native-loop-status");

  name.value = "x".repeat(201); prompt.value = "p"; interval.value = "30";
  name.dispatch("input"); prompt.dispatch("input"); interval.dispatch("input");
  await create.dispatch("click");
  assert.equal(ctx.transport.calls.execute.length, baseline);
  assert.equal(ctx.feedback.at(-1).code, "nativeLoop.error.name");

  name.value = "ok"; prompt.value = "x".repeat(8001);
  name.dispatch("input"); prompt.dispatch("input");
  await create.dispatch("click");
  assert.equal(ctx.transport.calls.execute.length, baseline);
  assert.equal(ctx.feedback.at(-1).code, "nativeLoop.error.prompt");

  prompt.value = "Prompt text";
  interval.value = "0"; name.dispatch("input"); prompt.dispatch("input"); interval.dispatch("input");
  await create.dispatch("click");
  assert.equal(ctx.transport.calls.execute.length, baseline);
  assert.equal(ctx.feedback.at(-1).code, "nativeLoop.error.interval");

  interval.value = "1441"; interval.dispatch("input");
  await create.dispatch("click");
  assert.equal(ctx.transport.calls.execute.length, baseline);
  assert.equal(ctx.feedback.at(-1).code, "nativeLoop.error.interval");

  interval.value = "1440"; status.value = "PAUSED";
  interval.dispatch("input"); status.dispatch("change");
  await create.dispatch("click");

  const createCall = ctx.transport.calls.execute.find((call) => call.action === "heartbeat.create");
  assert.ok(createCall);
  assert.deepEqual(createCall.params, {
    name: "ok", prompt: "Prompt text", intervalMinutes: 1440, status: "PAUSED"
  });
  assert.equal(createCall.threadId, "thread-1");
  assert.match(createCall.requestId, UUID_PATTERN);
  assert.deepEqual(Object.keys(createCall).sort(), ["action", "params", "requestId", "threadId"]);
  assert.equal(JSON.stringify(createCall).toUpperCase().includes("RRULE"), false);
});

test("create locks before awaiting, ignores double clicks, and retains one requestId after an unknown outcome", async () => {
  let pendingCreate = null;
  let createCalls = 0;
  const transport = fakeTransport({
    execute(payload) {
      if (payload.action === "heartbeat.create") {
        createCalls += 1;
        pendingCreate = deferred();
        return pendingCreate.promise;
      }
      return defaultResult(payload, transport.loops);
    }
  });
  const ctx = setup({ transport });
  await ctx.controls.openLoops();
  const dialog = ctx.host.modal;
  const create = byAction(dialog, "create");
  await fillValidForm(dialog);

  const first = create.dispatch("click");
  await Promise.resolve();
  await create.dispatch("click");
  assert.equal(createCalls, 1, "busy lock must block the second click");
  const firstId = ctx.transport.calls.execute.find((call) => call.action === "heartbeat.create").requestId;
  assert.match(firstId, UUID_PATTERN);

  pendingCreate.reject(Object.assign(new Error("network down at /home/secret.js"), { stack: "at /home/secret.js:1" }));
  await first;
  assert.equal(ctx.feedback.at(-1).code, "nativeLoop.unknownOutcome");
  assert.equal(ctx.feedback.at(-1).kind, "unknown");
  assert.equal(JSON.stringify(ctx.feedback.at(-1)).includes("secret.js"), false);
  assert.equal(create.disabled, true, "create must block until an authoritative read reconciles");
  assert.equal(ctx.controls.hasUnsavedDraft(), true);

  await create.dispatch("click");
  assert.equal(createCalls, 1, "no automatic retry while the outcome is unknown");
  assert.equal(byClass(dialog, "native-loop-name").value, "Daily loop");

  await byAction(dialog, "refresh").dispatch("click");
  assert.equal(ctx.transport.calls.execute.at(-1).action, "heartbeat.list");
  assert.equal(create.disabled, true, "an incomplete list cannot reconcile this intent");

  const second = byAction(dialog, "check-delivery").dispatch("click");
  await Promise.resolve();
  assert.equal(createCalls, 2);
  const ids = ctx.transport.calls.execute
    .filter((call) => call.action === "heartbeat.create")
    .map((call) => call.requestId);
  assert.match(ids[1], UUID_PATTERN);
  assert.equal(ids[0], ids[1], "receipt check must preserve the immutable request id");
  pendingCreate.resolve({ ok: true, threadId: "thread-1", heartbeat: { id: "hb-reconciled", kind: "heartbeat", targetThreadId: "thread-1", status: "ACTIVE", name: "Daily loop", intervalMinutes: 30 } });
  await second;
  assert.equal(ctx.controls.hasUnsavedDraft(), true, "receipt check preserves the user's text for review");
  assert.equal(byClass(dialog, "native-loop-name").value, "Daily loop");
});

test("newer typing survives an awaited create and keeps the form", async () => {
  const pending = deferred();
  const transport = fakeTransport({
    execute(payload) {
      if (payload.action === "heartbeat.create") return pending.promise;
      return defaultResult(payload, transport.loops);
    }
  });
  const ctx = setup({ transport });
  await ctx.controls.openLoops();
  const dialog = ctx.host.modal;
  const create = byAction(dialog, "create");
  await fillValidForm(dialog, { name: "first name" });

  const click = create.dispatch("click");
  await Promise.resolve();
  const name = byClass(dialog, "native-loop-name");
  name.value = "newer name";
  name.dispatch("input");
  pending.resolve({ ok: true, threadId: "thread-1", heartbeat: { id: "hb-new", kind: "heartbeat", targetThreadId: "thread-1", status: "ACTIVE", name: "first name", intervalMinutes: 30 } });
  await click;
  assert.equal(name.value, "newer name");
  assert.equal(ctx.controls.hasUnsavedDraft(), true);
  assert.equal(create.disabled, false, "a finished intent must not keep blocking");
});

test("delete needs a prepared receipt and a second exact native payload", async () => {
  const ctx = setup();
  await ctx.controls.openLoops();
  const dialog = ctx.host.modal;
  const remove = byAction(dialog, "delete", "hb-1");

  await remove.dispatch("click");
  assert.equal(ctx.transport.calls.prepare.length, 1);
  assert.deepEqual(ctx.transport.calls.prepare[0], {
    action: "heartbeat.delete", threadId: "thread-1", params: { id: "hb-1" }
  });
  assert.equal(ctx.transport.calls.execute.some((call) => call.action === "heartbeat.delete"), false);
  const review = byClass(dialog, "wf-dialog-confirm").textContent;
  for (const part of ["Daily check", "hb-1", "30 minutes"]) assert.ok(review.includes(part), part);

  await remove.dispatch("click");
  const execute = ctx.transport.calls.execute.find((call) => call.action === "heartbeat.delete");
  assert.deepEqual(execute.params, { id: "hb-1" });
  assert.equal(execute.threadId, "thread-1");
  assert.equal(execute.confirmationId, "conf-1");
  assert.match(execute.requestId, UUID_PATTERN);
  assert.deepEqual(Object.keys(execute).sort(), ["action", "confirmationId", "params", "requestId", "threadId"]);
  assert.equal(JSON.stringify(execute).toUpperCase().includes("RRULE"), false);
});

test("a prepared receipt is dropped when the thread changes and never executes", async () => {
  const receipt = deferred();
  const transport = fakeTransport({ prepare: () => receipt.promise });
  const ctx = setup({ transport });
  await ctx.controls.openLoops();
  const click = byAction(ctx.host.modal, "delete", "hb-1").dispatch("click");
  await Promise.resolve();
  ctx.state.threadId = "thread-2";
  receipt.resolve({
    confirmationId: "conf-9", action: "heartbeat.delete", threadId: "thread-1",
    expiresAt: new Date(Date.now() + 60000).toISOString()
  });
  await click;
  assert.equal(ctx.transport.calls.execute.some((call) => call.action === "heartbeat.delete"), false);
  assert.equal(ctx.feedback.at(-1).code, "nativeLoop.error.staleContext");
});

test("late list and create results for another thread are ignored", async () => {
  const listResult = deferred();
  const transport = fakeTransport({
    execute(payload) {
      if (payload.action === "heartbeat.list") return listResult.promise;
      return defaultResult(payload, transport.loops);
    }
  });
  const ctx = setup({ transport });
  const opening = ctx.controls.openLoops();
  await Promise.resolve();
  ctx.state.threadId = "thread-2";
  listResult.resolve({ ok: true, threadId: "thread-1", heartbeats: defaultLoops(), complete: false });
  await opening;
  assert.equal(rows(ctx.host.modal).length, 0, "stale rows must not render into another thread");

  const createResult = deferred();
  const createTransport = fakeTransport({
    execute(payload) {
      if (payload.action === "heartbeat.create") return createResult.promise;
      return defaultResult(payload, transport.loops);
    }
  });
  const other = setup({ transport: createTransport });
  await other.controls.openLoops();
  await fillValidForm(other.host.modal);
  const click = byAction(other.host.modal, "create").dispatch("click");
  await Promise.resolve();
  ctx.state.threadId = "thread-1";
  ctx.state.threadId = "thread-2";
  other.state.threadId = "thread-2";
  createResult.resolve({ ok: true, threadId: "thread-1" });
  await click;
  assert.equal(byClass(other.host.modal, "native-loop-name").value, "Daily loop");
  assert.equal(other.controls.hasUnsavedDraft(), true);
});

test("locale refresh relabels without reloading or dropping the draft or selection", async () => {
  let locale = "en";
  const t = (key) => nativeLoopMessages[locale][key];
  const ctx = setup({ t });
  await ctx.controls.openLoops();
  const dialog = ctx.host.modal;
  const name = byClass(dialog, "native-loop-name");
  const prompt = byClass(dialog, "native-loop-prompt");
  name.value = "typed name";
  prompt.value = "typed prompt";
  name.dispatch("input");
  prompt.selectionStart = 2;
  prompt.selectionEnd = 5;
  prompt.dispatch("input");
  const loads = ctx.transport.calls.execute.length;
  assert.equal(ctx.controls.hasUnsavedDraft(), true);

  locale = "ko";
  ctx.controls.refreshLabels();
  assert.equal(ctx.transport.calls.execute.length, loads, "label refresh must not reload native state");
  assert.equal(name.value, "typed name");
  assert.equal(prompt.value, "typed prompt");
  assert.equal(prompt.selectionStart, 2);
  assert.equal(prompt.selectionEnd, 5);
  assert.equal(byAction(dialog, "create").textContent, nativeLoopMessages.ko["nativeLoop.create"]);
  assert.ok(byClass(dialog, "native-loop-incomplete").textContent.includes("새로고침"));
  assert.equal(ctx.host.modal, dialog);
});

test("forced thread switches park dirty forms in a bounded RAM store", async () => {
  const ctx = setup();
  await ctx.controls.openLoops();
  const name = byClass(ctx.host.modal, "native-loop-name");
  const prompt = byClass(ctx.host.modal, "native-loop-prompt");
  name.value = "thread one draft";
  name.dispatch("input");
  prompt.value = "only for thread one";
  prompt.dispatch("input");
  ctx.controls.contextChanged();
  assert.equal(ctx.host.children.length, 0);

  ctx.state.threadId = "thread-2";
  await ctx.controls.openLoops();
  assert.equal(byClass(ctx.host.modal, "native-loop-name").value, "");
  assert.equal(ctx.controls.hasUnsavedDraft(), false);

  ctx.state.threadId = "thread-1";
  ctx.controls.contextChanged();
  await ctx.controls.openLoops();
  assert.equal(byClass(ctx.host.modal, "native-loop-name").value, "thread one draft");
  assert.equal(byClass(ctx.host.modal, "native-loop-prompt").value, "only for thread one");
  assert.equal(ctx.controls.hasUnsavedDraft(), true);

  await byAction(ctx.host.modal, "discard").dispatch("click");
  assert.equal(byClass(ctx.host.modal, "native-loop-name").value, "");
  assert.equal(ctx.controls.hasUnsavedDraft(), false);
});

test("dispose removes owned DOM, keeps the dirty flag, and never mutates natively", async () => {
  const ctx = setup();
  await ctx.controls.openLoops();
  const dialog = ctx.host.modal;
  const name = byClass(dialog, "native-loop-name");
  name.value = "unsaved";
  name.dispatch("input");
  const mutationsBefore = ctx.transport.calls.execute.filter((call) => call.action !== "heartbeat.list").length;
  ctx.controls.dispose();
  assert.equal(ctx.host.children.length, 0);
  assert.equal(ctx.host.modal, null);
  assert.equal(ctx.controls.hasUnsavedDraft(), true);
  await byAction(dialog, "create").dispatch("click");
  await byAction(dialog, "delete", "hb-1").dispatch("click");
  ctx.controls.refreshLabels();
  ctx.controls.contextChanged();
  assert.equal(
    ctx.transport.calls.execute.filter((call) => call.action !== "heartbeat.list").length,
    mutationsBefore
  );
});

test("transport errors expose only a safe label code", async () => {
  const transport = fakeTransport({
    execute(payload) {
      if (payload.action === "heartbeat.pause") {
        throw Object.assign(new Error("boom at /home/secret.js"), { stack: "at /home/secret.js:1" });
      }
      return defaultResult(payload, transport.loops);
    }
  });
  const ctx = setup({ transport });
  await ctx.controls.openLoops();
  await byAction(ctx.host.modal, "pause", "hb-1").dispatch("click");
  const entry = ctx.feedback.at(-1);
  assert.equal(entry.kind, "error");
  assert.equal(entry.code, "nativeLoop.error.failed");
  assert.equal(typeof entry.label, "string");
  assert.deepEqual(Object.keys(entry).sort(), ["code", "kind", "label"]);
  assert.equal(JSON.stringify(entry).includes("secret.js"), false);
});

test("the module contains no local scheduling or client recurrence construction", () => {
  const source = readFileSync(new URL("../public/native-loop-controls.js", import.meta.url), "utf8");
  assert.equal(/setInterval|setTimeout|requestAnimationFrame/.test(source), false);
  assert.equal(/RRULE/i.test(source), false);
});
