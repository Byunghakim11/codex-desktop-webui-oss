import test from "node:test";
import assert from "node:assert/strict";

import { createFileEditor, createOperationId, isWellFormedText, normalizeLf, utf8ByteLength } from "../public/file-editor.js";
import { fileWriteMessages } from "../public/file-write-messages.js";

const LABELS = fileWriteMessages.en;

function fakeDocument() {
  const view = {
    listeners: new Map(),
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      this.listeners.set(type, (this.listeners.get(type) || []).filter((f) => f !== fn));
    },
    count(type) {
      return (this.listeners.get(type) || []).length;
    }
  };
  const document = {
    defaultView: view,
    createElement(tag) {
      const listeners = new Map();
      const node = {
        tagName: String(tag).toUpperCase(), className: "", textContent: "", value: "", type: "",
        hidden: false, disabled: false, readOnly: false, closed: false, modal: false,
        attributes: new Map(), children: [], parent: null, selectionStart: 0, selectionEnd: 0,
        addEventListener(type, fn) {
          if (!listeners.has(type)) listeners.set(type, []);
          listeners.get(type).push(fn);
        },
        removeEventListener(type, fn) {
          listeners.set(type, (listeners.get(type) || []).filter((f) => f !== fn));
        },
        dispatch(type, event = {}) {
          const payload = { type, target: node, preventDefault() { payload.defaultPrevented = true; }, ...event };
          return Promise.all((listeners.get(type) || []).map((fn) => fn(payload)));
        },
        append(...nodes) {
          for (const child of nodes) { child.parent = node; node.children.push(child); }
        },
        setAttribute(name, value) { node.attributes.set(name, String(value)); },
        getAttribute(name) { return node.attributes.has(name) ? node.attributes.get(name) : null; },
        remove() {
          node.removed = true;
          if (node.parent) node.parent.children = node.parent.children.filter((c) => c !== node);
        },
        close() { node.closed = true; },
        showModal() { node.modal = true; }
      };
      return node;
    }
  };
  return { document, view };
}

function fakeContainer() {
  return {
    children: [],
    append(node) { node.parent = this; this.children.push(node); },
    removeChild(node) { this.children = this.children.filter((c) => c !== node); node.parent = null; }
  };
}

const all = (node, out = []) => {
  for (const child of node.children || []) { out.push(child); all(child, out); }
  return out;
};
const byClass = (root, cls) => all(root).find((n) => String(n.className).split(/\s+/).includes(cls));
const byAction = (root, action) => all(root).find((n) => n.getAttribute("data-file-write") === action);

function successDto(payload, version = "v2") {
  return {
    operationId: payload.operationId, status: "succeeded", kind: "save-text", path: payload.path,
    result: { version, size: utf8ByteLength(payload.text), bom: false, eol: "lf" }
  };
}

function fakeTransport(overrides = {}) {
  const calls = { save: [], status: [], editOpen: [], recovery: [] };
  const transport = {
    calls,
    async saveText(payload, signal) {
      calls.save.push({ payload, signal });
      if (overrides.saveText) return overrides.saveText(payload, signal);
      return successDto(payload);
    },
    async operationStatus(payload) {
      calls.status.push(payload);
      if (overrides.operationStatus) return overrides.operationStatus(payload);
      return successDto(payload);
    }
  };
  if (overrides.editOpen) {
    transport.editOpen = async (payload) => { calls.editOpen.push(payload); return overrides.editOpen(payload); };
  }
  if (overrides.recoveryDownload) {
    transport.recoveryDownload = async (payload) => { calls.recovery.push(payload); return overrides.recoveryDownload(payload); };
  }
  return transport;
}

function setup(options = {}) {
  const { document, view } = fakeDocument();
  const container = fakeContainer();
  const transport = options.transport || fakeTransport();
  const context = { threadId: "thread-1", rootRevision: "rev-1", connected: true, contextId: "ctx-1" };
  const feedback = [];
  const dirty = [];
  const registered = [];
  const editor = createFileEditor({
    document, container, transport,
    getContext: () => ({ ...context }),
    t: options.t || ((key) => key),
    onFeedback: (entry) => feedback.push(entry),
    onDirtyChange: (value) => dirty.push(value),
    registerMessages: options.registerMessages || ((bundle) => registered.push(bundle))
  });
  const root = container.children[0];
  return {
    editor, container, transport, context, feedback, dirty, registered, view, root,
    textarea: () => byClass(root, "file-editor-input"),
    status: () => byClass(root, "file-editor-status"),
    action: (name) => byAction(root, name),
    dialog: () => container.children.find((node) => node.tagName === "DIALOG"),
    feedback
  };
}

const openDto = (extra = {}) => ({
  threadId: "thread-1", rootRevision: "rev-1", contextId: "ctx-1", path: "notes.md",
  text: "hello", version: "v1", editable: true, bom: false, eol: "lf", size: 5, ...extra
});

const flush = async () => {
  for (let index = 0; index < 4; index += 1) await new Promise((resolve) => setImmediate(resolve));
};

test("renewing same-target authority preserves unsaved bytes, version and intent", async () => {
  const ctx=setup();ctx.editor.open(openDto());await type(ctx,"retain these unsaved bytes");
  const before=ctx.editor.getState();const contextId="f".repeat(32);
  assert.equal(ctx.editor.renewAuthority({contextId,path:"other.md",threadId:"thread-1",rootRevision:"rev-1"}),false);
  assert.equal(ctx.editor.renewAuthority({contextId,path:"notes.md",threadId:"other-thread",rootRevision:"rev-1"}),false);
  assert.equal(ctx.editor.renewAuthority({contextId,path:"notes.md",threadId:"thread-1",rootRevision:"rev-1"}),true);
  const after=ctx.editor.getState();assert.equal(after.contextId,contextId);assert.equal(after.text,before.text);assert.equal(after.version,before.version);assert.equal(after.operationId,before.operationId);
});

async function type(ctx, text) {
  ctx.textarea().value = text;
  await ctx.textarea().dispatch("input");
}

test("pure text helpers bound UTF-8, LF and operation ids", () => {
  assert.equal(utf8ByteLength("a"), 1);
  assert.equal(utf8ByteLength("é"), 2);
  assert.equal(utf8ByteLength("한"), 3);
  assert.equal(utf8ByteLength("😀"), 4);
  assert.equal(normalizeLf("a\r\nb\rc\nd"), "a\nb\nc\nd");
  assert.equal(isWellFormedText("ok 😀"), true);
  assert.equal(isWellFormedText("bad \ud800"), false);
  assert.equal(isWellFormedText("bad \udc00"), false);
  const id = createOperationId({ randomUUID: () => "ABCD1234-5678-9ABC-DEF0-1234567890AB" });
  assert.equal(id, "abcd123456789abcdef01234567890ab");
  assert.equal(createOperationId({}), null);
});

test("open accepts only UTF-8 editable text within 1 MiB with an exact version", () => {
  const ctx = setup();
  assert.equal(ctx.editor.open({ ...openDto(), version: "" }), false);
  assert.equal(ctx.editor.open({ ...openDto(), text: "bad \ud800" }), false);
  assert.equal(ctx.editor.open({ ...openDto({ text: "a\r\nb", version: "v-exact-1" }) }), true);
  assert.equal(ctx.textarea().tagName, "TEXTAREA");
  assert.ok(String(ctx.textarea().className).split(/\s+/).includes("file-editor-input"));
  assert.equal(ctx.textarea().value, "a\nb");
  assert.equal(ctx.editor.getState().version, "v-exact-1");
  assert.equal(ctx.editor.open(openDto({ text: "" })), true);
  assert.equal(ctx.editor.getState().text, "");
  assert.equal(ctx.editor.hasUnsavedChanges(), false);

  assert.equal(ctx.editor.open(openDto({ text: "x".repeat(1024 * 1024 + 1) })), false);
  assert.equal(ctx.editor.open(openDto({ text: "x".repeat(1024 * 1024) })), true);
  assert.equal(ctx.editor.open(openDto({ editable: false })), true);
  assert.equal(ctx.textarea().readOnly, true);
  assert.equal(ctx.action("save").disabled, true);
});

test("save sends the versioned payload once and adopts the returned version", async () => {
  const ctx = setup();
  ctx.editor.open(openDto({ text: "hello" }));
  await type(ctx, "hello world");
  assert.equal(ctx.editor.hasUnsavedChanges(), true);
  assert.equal(ctx.status().textContent, LABELS["fileWrite.status.dirty"]);
  await ctx.action("save").dispatch("click");
  await flush();
  assert.equal(ctx.transport.calls.save.length, 1);
  const { payload, signal } = ctx.transport.calls.save[0];
  assert.deepEqual(Object.keys(payload).sort(), ["contextId", "expectedVersion", "operationId", "path", "text"]);
  assert.match(payload.operationId, /^[0-9a-f]{32}$/);
  assert.equal(payload.expectedVersion, "v1");
  assert.equal(payload.contextId, "ctx-1");
  assert.equal(payload.path, "notes.md");
  assert.equal(payload.text, "hello world");
  assert.ok(signal !== undefined);
  const state = ctx.editor.getState();
  assert.equal(state.version, "v2");
  assert.equal(state.dirty, false);
  assert.equal(state.operationId, null);
  assert.equal(state.status, "saved");
  assert.equal(ctx.status().textContent, LABELS["fileWrite.status.saved"]);
  assert.equal(ctx.action("save").disabled, true);
  assert.equal(ctx.transport.calls.save.length, 1);
});

test("Ctrl/Cmd+S in the textarea saves while other keys stay untouched", async () => {
  const ctx = setup();
  ctx.editor.open(openDto({ text: "a" }));
  await type(ctx, "ab");
  const prevented = [];
  await ctx.textarea().dispatch("keydown", { key: "p", ctrlKey: true, preventDefault() { prevented.push("p"); } });
  assert.equal(ctx.transport.calls.save.length, 0);
  assert.deepEqual(prevented, []);
  await ctx.textarea().dispatch("keydown", { key: "s", ctrlKey: true, preventDefault() { prevented.push("s"); } });
  await flush();
  assert.equal(ctx.transport.calls.save.length, 1);
  assert.deepEqual(prevented, ["s"]);
  await type(ctx, "abc");
  await ctx.textarea().dispatch("keydown", { key: "S", metaKey: true, preventDefault() {} });
  await flush();
  assert.equal(ctx.transport.calls.save.length, 2);
  assert.equal(ctx.transport.calls.save[1].payload.expectedVersion, "v2");
});

test("a second save while the first is in flight is locked", async () => {
  let release;
  const transport = fakeTransport({ saveText: (payload) => new Promise((resolve) => { release = () => resolve(successDto(payload)); }) });
  const ctx = setup({ transport });
  ctx.editor.open(openDto({ text: "a" }));
  await type(ctx, "ab");
  await ctx.action("save").dispatch("click");
  assert.equal(ctx.action("save").disabled, true);
  await ctx.action("save").dispatch("click");
  assert.equal(ctx.transport.calls.save.length, 1);
  release();
  await flush();
  assert.equal(ctx.editor.getState().status, "saved");
});

test("a network failure becomes unknown and never auto-retries", async () => {
  const transport = fakeTransport({
    saveText: async () => { throw new Error("network down"); },
    operationStatus: (payload) => ({
      operationId: payload.operationId, status: "succeeded", kind: "save-text", path: payload.path,
      result: { version: "v9", size: 4, bom: false, eol: "lf" }
    })
  });
  const ctx = setup({ transport });
  ctx.editor.open(openDto({ text: "abc" }));
  await type(ctx, "abcd");
  await ctx.action("save").dispatch("click");
  await flush();
  const unknown = ctx.editor.getState();
  assert.equal(unknown.status, "unknown");
  assert.equal(unknown.dirty, true);
  assert.equal(unknown.version, "v1");
  assert.equal(unknown.text, "abcd");
  assert.match(unknown.operationId, /^[0-9a-f]{32}$/);
  assert.equal(ctx.action("save").disabled, true);
  assert.equal(ctx.action("check-status").hidden, false);
  await flush();
  assert.equal(ctx.transport.calls.save.length, 1, "no automatic replay");
  await ctx.action("check-status").dispatch("click");
  await flush();
  assert.deepEqual(Object.keys(ctx.transport.calls.status[0]).sort(), ["contextId", "kind", "operationId", "path"]);
  assert.equal(ctx.transport.calls.status[0].kind, "save-text");
  assert.equal(ctx.transport.calls.status[0].operationId, unknown.operationId);
  const settled = ctx.editor.getState();
  assert.equal(settled.status, "saved");
  assert.equal(settled.version, "v9");
  assert.equal(settled.operationId, null);
});

test("a definite failure keeps the buffer and allows a fresh operation id", async () => {
  let attempts = 0;
  const ids = [];
  const transport = fakeTransport({
    saveText: async (payload) => {
      attempts += 1;
      ids.push(payload.operationId);
      if (attempts === 1) return { operationId: payload.operationId, status: "failed", kind: "save-text", path: payload.path, result: { reason: "internal" } };
      return successDto(payload);
    }
  });
  const ctx = setup({ transport });
  ctx.editor.open(openDto({ text: "a" }));
  await type(ctx, "ab");
  await ctx.action("save").dispatch("click");
  await flush();
  assert.equal(ctx.editor.getState().status, "dirty");
  assert.equal(ctx.editor.getState().text, "ab");
  assert.equal(ctx.textarea().value, "ab");
  await ctx.action("save").dispatch("click");
  await flush();
  assert.equal(ctx.transport.calls.save.length, 2);
  assert.notEqual(ids[0], ids[1]);
  assert.equal(ctx.editor.getState().status, "saved");
});

test("a 409 conflict keeps buffer and version and requires a confirmed reload", async () => {
  const transport = fakeTransport({
    saveText: async (payload) => ({
      operationId: payload.operationId, status: "failed", kind: "save-text", path: payload.path,
      result: { reason: "FILE_CHANGED" }, recoveryId: "rec-1"
    })
  });
  const ctx = setup({ transport });
  ctx.editor.open(openDto({ text: "a" }));
  await type(ctx, "ab");
  await ctx.action("save").dispatch("click");
  await flush();
  const state = ctx.editor.getState();
  assert.equal(state.status, "conflict");
  assert.equal(state.version, "v1");
  assert.equal(state.text, "ab");
  assert.equal(state.dirty, true);
  assert.equal(ctx.action("save").disabled, true);
  assert.equal(ctx.action("reload").hidden, false);
  assert.equal(ctx.action("recovery"), undefined, "no fake recovery button without a transport method");
  await ctx.action("reload").dispatch("click");
  assert.equal(ctx.action("reload").textContent, LABELS["fileWrite.reloadConfirm"]);
  assert.equal(ctx.feedback.length, 0);
  await ctx.action("reload").dispatch("click");
  await flush();
  const entry = ctx.feedback.at(-1);
  assert.equal(entry.action, "reload-required");
  assert.equal(entry.path, "notes.md");
  assert.equal(ctx.editor.getState().text, "a");
  assert.equal(ctx.editor.getState().snapshot.text, "ab");
});

test("reload uses the optional editOpen transport instead of faking a read", async () => {
  const transport = fakeTransport({
    saveText: async (payload) => ({
      operationId: payload.operationId, status: "failed", kind: "save-text", path: payload.path, result: { reason: "conflict" }
    }),
    editOpen: () => openDto({ text: "fresh", version: "v5" })
  });
  const ctx = setup({ transport });
  ctx.editor.open(openDto({ text: "a" }));
  await type(ctx, "ab");
  await ctx.action("save").dispatch("click");
  await flush();
  await ctx.action("reload").dispatch("click");
  await ctx.action("reload").dispatch("click");
  await flush();
  assert.equal(ctx.transport.calls.editOpen.length, 1);
  assert.deepEqual(ctx.transport.calls.editOpen[0], {
    contextId: "ctx-1", path: "notes.md", threadId: "thread-1", rootRevision: "rev-1"
  });
  assert.equal(ctx.textarea().value, "fresh");
  assert.equal(ctx.editor.getState().version, "v5");
  assert.equal(ctx.editor.getState().snapshot, null);
  assert.equal(ctx.feedback.some((entry) => entry.action === "reload-required"), false);
});

test("an unconfirmed status stays unknown until an explicit authoritative query", async () => {
  const transport = fakeTransport({
    saveText: async (payload) => ({ operationId: payload.operationId, status: "queued", kind: "save-text", path: payload.path }),
    operationStatus: (payload) => ({ operationId: payload.operationId, status: "unknown", kind: "save-text", path: payload.path })
  });
  const ctx = setup({ transport });
  ctx.editor.open(openDto({ text: "a" }));
  await type(ctx, "ab");
  await ctx.action("save").dispatch("click");
  await flush();
  assert.equal(ctx.editor.getState().status, "unknown");
  await ctx.action("check-status").dispatch("click");
  await flush();
  assert.equal(ctx.editor.getState().status, "unknown");
  assert.match(ctx.editor.getState().operationId, /^[0-9a-f]{32}$/);
  assert.equal(ctx.transport.calls.save.length, 1);
});

test("a changed connection or root scope disables save and keeps the buffer", async () => {
  const ctx = setup();
  ctx.editor.open(openDto({ text: "a" }));
  await type(ctx, "ab");
  ctx.context.connected = false;
  ctx.editor.refreshLabels();
  assert.equal(ctx.status().textContent, LABELS["fileWrite.status.offline"]);
  assert.equal(ctx.action("save").disabled, true);
  assert.equal(ctx.textarea().value, "ab");
  await ctx.action("save").dispatch("click");
  assert.equal(ctx.transport.calls.save.length, 0);
  ctx.context.connected = true;
  ctx.context.rootRevision = "rev-2";
  ctx.editor.refreshLabels();
  assert.equal(ctx.action("save").disabled, true);
  assert.equal(ctx.editor.hasUnsavedChanges(), true);
  assert.equal(ctx.editor.getState().version, "v1");
});

test("open refuses to discard a dirty buffer", async () => {
  const ctx = setup();
  ctx.editor.open(openDto({ text: "a" }));
  await type(ctx, "ab");
  assert.equal(ctx.editor.open(openDto({ path: "other.md", text: "z", version: "v2" })), false);
  assert.equal(ctx.editor.getState().path, "notes.md");
  assert.equal(ctx.editor.getState().text, "ab");
  assert.equal(ctx.textarea().value, "ab");
});

test("beforeContextChange cancel keeps the buffer and ESC cancels the dialog", async () => {
  const ctx = setup();
  ctx.editor.open(openDto({ text: "a" }));
  await type(ctx, "ab");
  const pending = ctx.editor.beforeContextChange();
  const dialog = ctx.dialog();
  assert.ok(dialog);
  assert.equal(dialog.tagName, "DIALOG");
  assert.match(byClass(dialog, "file-editor-dialog-summary").textContent, /notes\.md/);
  await dialog.dispatch("cancel");
  assert.equal(await pending, false);
  assert.equal(ctx.editor.getState().text, "ab");
  assert.equal(ctx.textarea().value, "ab");
});

test("beforeContextChange saves only after a confirmed save", async () => {
  const ctx = setup();
  ctx.editor.open(openDto({ text: "a" }));
  await type(ctx, "ab");
  const pending = ctx.editor.beforeContextChange();
  const dialog = ctx.dialog();
  await byClass(dialog, "file-editor-dialog-save").dispatch("click");
  await flush();
  assert.equal(await pending, true);
  assert.equal(ctx.transport.calls.save[0].payload.expectedVersion, "v1");
  assert.equal(ctx.editor.getState().dirty, false);

  const conflictTransport = fakeTransport({
    saveText: async (payload) => ({
      operationId: payload.operationId, status: "failed", kind: "save-text", path: payload.path, result: { reason: "conflict" }
    })
  });
  const other = setup({ transport: conflictTransport });
  other.editor.open(openDto({ text: "a" }));
  await type(other, "ab");
  const blocked = other.editor.beforeContextChange();
  await byClass(other.dialog(), "file-editor-dialog-save").dispatch("click");
  await flush();
  assert.equal(await blocked, false);
  assert.equal(other.editor.getState().text, "ab");
});

test("beforeContextChange discard clears the buffer and keeps a local snapshot", async () => {
  const ctx = setup();
  ctx.editor.open(openDto({ text: "a" }));
  await type(ctx, "ab");
  const pending = ctx.editor.beforeContextChange();
  await byClass(ctx.dialog(), "file-editor-dialog-discard").dispatch("click");
  assert.equal(await pending, true);
  const state = ctx.editor.getState();
  assert.equal(ctx.textarea().value, "a");
  assert.equal(state.dirty, false);
  assert.equal(state.snapshot.text, "ab");
  assert.equal(state.snapshot.reason, "context-change");
});

test("slow Save cannot authorize discarding newer text typed while the request was pending",async()=>{
 let resolveSave;let sent;
 const ctx=setup({transport:fakeTransport({saveText:payload=>{sent=payload;return new Promise(resolve=>resolveSave=resolve);}})});
 ctx.editor.open(openDto());await type(ctx,"first edit");
 const decision=ctx.editor.beforeContextChange();await byClass(ctx.dialog(),"file-editor-dialog-save").dispatch("click");await flush();
 await type(ctx,"newer edit during save");resolveSave({status:"succeeded",kind:"save-text",operationId:sent.operationId,path:sent.path,result:{version:"v2",size:10}});
 assert.equal(await decision,false);assert.equal(ctx.editor.getState().dirty,true);assert.equal(ctx.editor.getState().text,"newer edit during save");
});

test("failed conflict Reload preserves the unsaved buffer and conflict status",async()=>{
 const ctx=setup({transport:fakeTransport({saveText:async payload=>({status:"failed",kind:"save-text",operationId:payload.operationId,path:payload.path,result:{reason:"FILE_CHANGED"}}),editOpen:async()=>{throw Error("unavailable");}})});
 ctx.editor.open(openDto());await type(ctx,"unsaved conflict");await ctx.action("save").dispatch("click");await flush();
 await ctx.action("reload").dispatch("click");await ctx.action("reload").dispatch("click");await flush();
 assert.equal(ctx.editor.getState().status,"conflict");assert.equal(ctx.editor.getState().text,"unsaved conflict");assert.equal(ctx.editor.getState().dirty,true);
});

test("typing while conflict Reload is pending prevents replacing the newer buffer",async()=>{
 let finishRead;const ctx=setup({transport:fakeTransport({saveText:async payload=>({status:"failed",kind:"save-text",operationId:payload.operationId,path:payload.path,result:{reason:"FILE_CHANGED"}}),editOpen:()=>new Promise(resolve=>finishRead=resolve)})});
 ctx.editor.open(openDto());await type(ctx,"old unsaved buffer");await ctx.action("save").dispatch("click");await flush();
 await ctx.action("reload").dispatch("click");const pending=ctx.action("reload").dispatch("click");await flush();
 await type(ctx,"newer text during Reload");finishRead(openDto({text:"fresh native version",version:"v4"}));await pending;await flush();
 assert.equal(ctx.editor.getState().text,"newer text during Reload");assert.equal(ctx.editor.getState().status,"conflict");assert.equal(ctx.editor.getState().version,"v1");
});

test("refreshLabels relabels without transport, buffer or selection changes", async () => {
  const ctx = setup();
  ctx.editor.open(openDto({ text: "line" }));
  await type(ctx, "draft");
  ctx.textarea().selectionStart = 2;
  ctx.textarea().selectionEnd = 4;
  ctx.editor.refreshLabels();
  assert.equal(ctx.textarea().value, "draft");
  assert.equal(ctx.textarea().selectionStart, 2);
  assert.equal(ctx.textarea().selectionEnd, 4);
  assert.equal(ctx.action("save").textContent, LABELS["fileWrite.save"]);
  assert.equal(ctx.status().textContent, LABELS["fileWrite.status.dirty"]);
  assert.equal(ctx.transport.calls.save.length, 0);
  assert.equal(ctx.transport.calls.status.length, 0);
});

test("recovery download exists only when the transport implements it", async () => {
  const transport = fakeTransport({
    saveText: async (payload) => ({
      operationId: payload.operationId, status: "failed", kind: "save-text", path: payload.path,
      result: { reason: "conflict" }, recoveryId: "rec-7"
    }),
    recoveryDownload: async () => true
  });
  const ctx = setup({ transport });
  ctx.editor.open(openDto({ text: "a" }));
  await type(ctx, "ab");
  await ctx.action("save").dispatch("click");
  await flush();
  const recovery = ctx.action("recovery");
  assert.ok(recovery);
  assert.equal(recovery.hidden, false);
  await recovery.dispatch("click");
  await flush();
  assert.deepEqual(ctx.transport.calls.recovery[0], {
    contextId: "ctx-1", path: "notes.md", operationId: ctx.editor.getState().operationId, recoveryId: "rec-7"
  });
});

test("beforeunload is guarded only while changes are unsaved", async () => {
  const ctx = setup();
  assert.equal(ctx.view.count("beforeunload"), 0);
  ctx.editor.open(openDto({ text: "a" }));
  await type(ctx, "ab");
  assert.equal(ctx.view.count("beforeunload"), 1);
  await ctx.action("revert").dispatch("click");
  await ctx.action("revert").dispatch("click");
  assert.equal(ctx.textarea().value, "a");
  assert.equal(ctx.view.count("beforeunload"), 0);
});

test("dispose removes owned DOM and ignores late save results but keeps the snapshot", async () => {
  let release;
  const transport = fakeTransport({ saveText: (payload) => new Promise((resolve) => { release = () => resolve(successDto(payload)); }) });
  const ctx = setup({ transport });
  ctx.editor.open(openDto({ text: "a" }));
  await type(ctx, "ab");
  await ctx.action("save").dispatch("click");
  ctx.editor.dispose();
  assert.equal(ctx.container.children.length, 0);
  assert.equal(ctx.view.count("beforeunload"), 0);
  release();
  await flush();
  const state = ctx.editor.getState();
  assert.equal(state.text, "ab");
  assert.equal(state.version, "v1");
  assert.equal(state.snapshot.text, "ab");
  assert.equal(state.snapshot.version, "v1");
  assert.equal(state.snapshot.reason, "dispose");
  assert.equal(ctx.editor.open(openDto()), false);
  assert.equal(ctx.transport.calls.save.length, 1);
});

test("bilingual fileWrite messages are registered once and share keys", () => {
  const ctx = setup();
  assert.equal(ctx.registered.length, 1);
  const bundle = ctx.registered[0];
  assert.deepEqual(Object.keys(bundle.en).sort(), Object.keys(bundle.ko).sort());
  for (const key of Object.keys(bundle.en)) assert.match(key, /^fileWrite\./);
  assert.equal(ctx.dirty.at(-1), undefined);
});
