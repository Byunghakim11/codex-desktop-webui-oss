import test from "node:test";
import assert from "node:assert/strict";
import { createCommandRegistry, createDiagnostics, navigationShortcut, createUiNavigation } from "../public/ui-navigation.js";

test("command execution rechecks availability and exposes fixed metadata only", () => {
  const registry = createCommandRegistry(); let enabled = true, count = 0;
  registry.register({ id: "files.find", label: "파일 찾기", shortcut: "", disabledReason: "파일을 먼저 여세요", enabled: () => enabled, run: () => count++ });
  assert.equal(registry.execute("files.find"), true); enabled = false;
  assert.equal(registry.execute("files.find"), false); assert.equal(count, 1);
  assert.deepEqual(registry.list(), [{ id: "files.find", label: "파일 찾기", shortcut: "", enabled: false, disabledReason: "파일을 먼저 여세요" }]);
  assert.equal(registry.execute("missing"), false);
  assert.throws(() => registry.register({ id: "files.find", label: "duplicate", run() {} }));
});
test("static navigation feature rollback removes commands and shortcuts without observations", () => {
  const doc = new Document(), host = new Node("div", doc), registry = createCommandRegistry();
  const nav = createUiNavigation({ document: doc, host, registry, features: { F09: false, F10: false, F14: false, F15: false } });
  assert.deepEqual(registry.list(), []); assert.equal(host.children[0].children.length, 0);
  nav.openPalette(); nav.openHelp(); nav.openDiagnostics(); nav.cycleReading();
  assert.equal(doc.body.children.find(x=>x.tagName==="DIALOG").open, undefined);
  assert.equal(nav.recordMetric({ kind: "sync-success", atMs: 1 }), false);
  assert.equal(nav.getDiagnosticsSnapshot().eventCount, 0); nav.dispose();
});
test("global shortcuts respect editors, IME, repeat and OS combinations", () => {
  assert.equal(navigationShortcut({ key: "k", ctrlKey: true }), "workflow.palette");
  assert.equal(navigationShortcut({ key: "K", metaKey: true }), "workflow.palette");
  assert.equal(navigationShortcut({ key: "?", shiftKey: true }), "workflow.help");
  for (const extra of [{ editing: true }, { isComposing: true }, { keyCode: 229 }, { repeat: true }, { altKey: true }, { shiftKey: true }]) assert.equal(navigationShortcut({ key: "k", ctrlKey: true, ...extra }), null);
  assert.equal(navigationShortcut({ key: "?", ctrlKey: true }), null);
  assert.equal(navigationShortcut({ key: "2", altKey: true }), null);
});
test("diagnostics aggregate exact numeric events without retaining payloads", () => {
  let time = 30; const metrics = createDiagnostics({ now: () => time });
  assert.equal(metrics.recordMetric({ kind: "sync-success", atMs: 10, durationMs: 3, itemCount: 2 }), true);
  assert.equal(metrics.recordMetric({ kind: "load-complete", atMs: 20, durationMs: 5, itemCount: 4 }), true);
  assert.equal(metrics.recordMetric({ kind: "sync-failure", atMs: 25, durationMs: 1, itemCount: 0 }), true);
  const snapshot = metrics.getDiagnosticsSnapshot();
  assert.equal(snapshot.schemaVersion, 1); assert.equal(snapshot.successCount, 2);
  assert.equal(snapshot.failureCount, 1); assert.equal(snapshot.itemCount, 6);
  assert.equal(snapshot.lastSuccessAtMs, 20); assert.equal(snapshot.sinceSuccessMs, 10);
  assert.equal(snapshot.loadDurationMs, 5);
  assert.ok(Object.values(snapshot).every(value => value === null || typeof value === "number"));
  for (const event of [
    { kind: "unknown", atMs: 1 }, { kind: "sync-success", atMs: Infinity },
    { kind: "sync-success", atMs: 1, error: "private" }, { kind: "sync-success", atMs: 1, itemCount: -1 },
    { kind: "sync-success", atMs: 1, durationMs: NaN }, { kind: "sync-success", atMs: 1, itemCount: "1" },
  ]) assert.equal(metrics.recordMetric(event), false);
  assert.deepEqual(metrics.getDiagnosticsSnapshot(), snapshot);
  metrics.resetDiagnostics();
  assert.equal(metrics.getDiagnosticsSnapshot().successCount, 0);
  assert.equal(metrics.getDiagnosticsSnapshot().lastSuccessAtMs, null);
});

// Native focus trapping/layout is covered by root browser QA; this boundary exercises our listeners.
class Node extends EventTarget {
  constructor(tag, doc) { super(); this.tagName = tag.toUpperCase(); this.ownerDocument = doc; this.children = []; this.dataset = {}; this.attrs = {}; this.variables = {}; this.classes = new Set(); this.style = { setProperty: (key, value) => { this.variables[key] = value; }, removeProperty: key => { delete this.variables[key]; } }; this.classList = { add: key => this.classes.add(key), remove: key => this.classes.delete(key) }; this.isConnected = true; }
  append(...items) { this.children.push(...items); for (const item of items) item.parentNode = this; }
  replaceChildren(...items) { this.children = []; this.append(...items); }
  setAttribute(key, value) { this.attrs[key] = String(value); }
  removeAttribute(key) { delete this.attrs[key]; }
  focus() { this.ownerDocument.activeElement = this; }
  showModal() { this.open = true; this.focus(); }
  close() { this.open = false; this.dispatchEvent(new Event("close")); }
  remove() { this.isConnected = false; if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(x => x !== this); }
  contains(node) { return node === this || this.children.some(child => child.contains?.(node)); }
  closest() { return null; }
}
class Document extends EventTarget {
  constructor() { super(); this.body = new Node("body", this); this.head = new Node("head", this); this.activeElement = this.body; }
  createElement(tag) { return new Node(tag, this); }
  querySelectorAll(selector) { return selector === 'dialog[open]' ? this.body.children.filter(node => node.tagName === 'DIALOG' && node.open) : []; }
}
const find = (node, action) => node.dataset?.wfAction === action ? node : node.children?.map(child => find(child, action)).find(Boolean);
test("touch controls open native dialogs, restore focus and dispose keyboard ownership", () => {
  const doc = new Document(), host = new Node("div", doc); doc.body.append(host);
  const registry = createCommandRegistry(), nav = createUiNavigation({ document: doc, host, registry, t: key => key });
  const entry = find(host, "help"); entry.focus(); entry.dispatchEvent(new Event("click"));
  const dialog = doc.body.children.find(x => x.tagName === "DIALOG");
  assert.equal(dialog.open, true);
  find(dialog, "close").dispatchEvent(new Event("click"));
  assert.equal(dialog.open, false); assert.equal(doc.activeElement, entry);
  const shortcut = () => { const event = new Event("keydown", { cancelable: true }); Object.assign(event, { key: "k", ctrlKey: true }); doc.dispatchEvent(event); return event; };
  assert.equal(shortcut().defaultPrevented, true);
  nav.dispose();
  assert.equal(shortcut().defaultPrevented, false);
  assert.equal(host.children.length, 0); assert.equal(registry.list().length, 0);
});
test("palette arrows skip disabled commands and Enter rechecks current availability", () => {
  const doc = new Document(), host = new Node("div", doc), registry = createCommandRegistry();
  let available = true, ran = 0;
  registry.register({ id: "file.find", label: "Find file", enabled: () => available, disabledReason: "Open a file", run: () => ran++ });
  registry.register({ id: "file.disabled", label: "Disabled", enabled: () => false, run: () => ran++ });
  const nav = createUiNavigation({ document: doc, host, registry }); nav.openPalette();
  const dialog = doc.body.children.find(x => x.tagName === "DIALOG"), input = dialog.children.find(x => x.tagName === "INPUT");
  input.value = "file"; input.dispatchEvent(new Event("input"));
  const press = key => { const event = new Event("keydown", { cancelable: true }); Object.assign(event, { key }); input.dispatchEvent(event); };
  press("ArrowDown"); press("Enter"); assert.equal(ran, 1);
  nav.openPalette();
  const current = dialog.children.find(x => x.tagName === "INPUT"); current.value = "file"; current.dispatchEvent(new Event("input")); available = false;
  const enter = new Event("keydown", { cancelable: true }); Object.assign(enter, { key: "Enter" }); current.dispatchEvent(enter);
  assert.equal(ran, 1); assert.equal(dialog.open, true); nav.dispose();
});
test("reading presets apply only to provided body and restore through anchor callback", () => {
  const doc = new Document(), host = new Node("div", doc), target = new Node("section", doc), registry = createCommandRegistry();
  const presets = [];
  const nav = createUiNavigation({ document: doc, host, registry, getReadingTarget: () => target, onReadingChange({ preset, apply }) { presets.push(preset); apply(); } });
  assert.equal(nav.cycleReading(), "comfortable");
  assert.equal(target.variables["--wf-reading-font"], "17px");
  assert.equal(host.variables["--wf-reading-font"], undefined);
  assert.equal(nav.cycleReading(), "focused");
  assert.equal(target.variables["--wf-reading-width"], "62ch");
  assert.equal(nav.cycleReading(), "default");
  assert.deepEqual(target.variables, {});
  assert.deepEqual(presets, ["comfortable", "focused", "default"]);
  nav.cycleReading(); nav.dispose(); assert.deepEqual(target.variables, {});
});
test("disposed navigation does not accept late observations", () => {
  const doc = new Document(), host = new Node("div", doc), registry = createCommandRegistry();
  const nav = createUiNavigation({ document: doc, host, registry }); nav.dispose();
  assert.equal(nav.recordMetric({ kind: "sync-success", atMs: 2 }), false);
  assert.equal(nav.getDiagnosticsSnapshot().eventCount, 0);
});
test("queued close from palette does not clear reopened diagnostics or its original opener", () => {
  const doc = new Document(), host = new Node("div", doc), registry = createCommandRegistry();
  const nav = createUiNavigation({ document: doc, host, registry });
  const entry = find(host, "palette"); entry.focus(); entry.dispatchEvent(new Event("click"));
  const dialog = doc.body.children.find(node => node.tagName === "DIALOG");
  const closes = []; dialog.close = () => { dialog.open = false; closes.push(() => dialog.dispatchEvent(new Event("close"))); };
  const diagnostics = dialog.children.flatMap(child => child.children || []).find(node => node.dataset.commandId === "workflow.diagnostics");
  diagnostics.dispatchEvent(new Event("click"));
  assert.equal(dialog.open, true);
  closes.shift()();
  nav.recordMetric({ kind: "sync-success", atMs: 10 });
  const output = dialog.children.find(node => node.tagName === "PRE");
  assert.equal(JSON.parse(output.textContent).eventCount, 1);
  find(dialog, "diagnostics-reset").dispatchEvent(new Event("click"));
  assert.equal(JSON.parse(output.textContent).eventCount, 0);
  find(dialog, "close").dispatchEvent(new Event("click")); closes.shift()();
  assert.equal(doc.activeElement, entry); nav.dispose();
});
test("Escape leaves an underlying dialog open and only native cancel closes its owner", () => {
  const doc = new Document(), host = new Node("div", doc), registry = createCommandRegistry();
  const earlier = new Node("dialog", doc); doc.body.append(earlier);
  const nav = createUiNavigation({ document: doc, host, registry }); nav.openHelp();
  const navigation = doc.body.children.find(node => node !== earlier && node.tagName === "DIALOG");
  earlier.showModal();
  assert.deepEqual(doc.querySelectorAll('dialog[open]'), [earlier, navigation]);
  const escape = new Event("keydown", { cancelable: true }); Object.assign(escape, { key: "Escape" }); doc.dispatchEvent(escape);
  assert.equal(escape.defaultPrevented, false);
  assert.equal(navigation.open, true); assert.equal(earlier.open, true);
  // The browser sends cancel only to the actual top-layer dialog, independent of DOM order.
  const topCancel = new Event("cancel", { cancelable: true }); earlier.dispatchEvent(topCancel);
  if (!topCancel.defaultPrevented) earlier.close();
  assert.equal(navigation.open, true); assert.equal(earlier.open, false);
  const ownEscape = new Event("keydown", { cancelable: true }); Object.assign(ownEscape, { key: "Escape" });
  Object.defineProperty(ownEscape, "target", { value: find(navigation, "close") }); doc.dispatchEvent(ownEscape);
  assert.equal(ownEscape.defaultPrevented, false); assert.equal(navigation.open, true);
  const ownCancel = new Event("cancel", { cancelable: true }); navigation.dispatchEvent(ownCancel);
  assert.equal(navigation.open, false); nav.dispose();
});
test("queued palette close does not steal focus from an external command destination", () => {
  const doc = new Document(), host = new Node("div", doc), registry = createCommandRegistry(), destination = new Node("input", doc);
  doc.body.append(destination);
  registry.register({ id: "conversation.search", label: "Search conversation", run: () => destination.focus() });
  const nav = createUiNavigation({ document: doc, host, registry });
  const entry = find(host, "palette"); entry.focus(); entry.dispatchEvent(new Event("click"));
  const dialog = doc.body.children.find(node => node.tagName === "DIALOG");
  const closes = []; dialog.close = () => { dialog.open = false; closes.push(() => dialog.dispatchEvent(new Event("close"))); };
  const command = dialog.children.flatMap(child => child.children || []).find(node => node.dataset.commandId === "conversation.search");
  command.dispatchEvent(new Event("click"));
  assert.ok(doc.activeElement === destination);
  closes.shift()();
  assert.ok(doc.activeElement === destination); nav.dispose();
});
