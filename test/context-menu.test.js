import test from "node:test";
import assert from "node:assert/strict";

import { clampMenuPosition, createContextMenu, normalizeMenuItems } from "../public/ui/context-menu.js";

function fakeElement(tag, doc) {
  const listeners = new Map();
  const el = {
    tagName: String(tag).toUpperCase(),
    ownerDocument: doc,
    className: "",
    textContent: "",
    hidden: false,
    disabled: false,
    title: "",
    type: "",
    style: {},
    attributes: new Map(),
    children: [],
    parentNode: null,
    isConnected: true,
    focusCount: 0,
    setAttribute(name, value) { this.attributes.set(name, String(value)); },
    getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; },
    append(...nodes) {
      for (const node of nodes) {
        if (typeof node === "string") {
          this.textContent += node;
          continue;
        }
        node.parentNode = this;
        this.children.push(node);
      }
    },
    replaceChildren(...nodes) {
      for (const child of this.children) child.parentNode = null;
      this.children = [];
      this.append(...nodes);
    },
    remove() {
      const parent = this.parentNode;
      if (parent) parent.children = parent.children.filter((child) => child !== this);
      this.parentNode = null;
      this.isConnected = false;
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      listeners.set(type, (listeners.get(type) || []).filter((candidate) => candidate !== fn));
    },
    dispatch(type, event = {}) {
      const payload = {
        type,
        preventDefault() { payload.defaultPrevented = true; },
        stopPropagation() { payload.propagationStopped = true; },
        ...event
      };
      payload.currentTarget = payload.currentTarget || this;
      payload.target = payload.target || this;
      if (!event.preventDefault) payload.preventDefault = () => { payload.defaultPrevented = true; };
      if (!event.stopPropagation) payload.stopPropagation = () => { payload.propagationStopped = true; };
      for (const fn of listeners.get(type) || []) fn(payload);
      return payload;
    },
    focus() {
      this.focusCount += 1;
      if (this.ownerDocument) this.ownerDocument.activeElement = this;
    },
    getBoundingClientRect() {
      return { left: 12, top: 40, right: 252, bottom: 46, width: 240, height: 240 };
    },
    contains(node) {
      if (node === this) return true;
      return this.children.some((child) => child.contains?.(node));
    }
  };
  return el;
}

function fakeDocument({ width = 1024, height = 768 } = {}) {
  const docListeners = new Map();
  const winListeners = new Map();
  const doc = {
    body: null,
    activeElement: null,
    createElement(tag) { return fakeElement(tag, doc); },
    addEventListener(type, fn) {
      if (!docListeners.has(type)) docListeners.set(type, []);
      docListeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      docListeners.set(type, (docListeners.get(type) || []).filter((candidate) => candidate !== fn));
    },
    dispatch(type, event = {}) {
      const payload = { type, preventDefault() {}, stopPropagation() {}, ...event };
      for (const fn of [...(docListeners.get(type) || [])]) fn(payload);
      return payload;
    },
    listenerCount(type) {
      return (docListeners.get(type) || []).length;
    }
  };
  doc.body = fakeElement("body", doc);
  doc.body.ownerDocument = doc;
  doc.defaultView = {
    innerWidth: width,
    innerHeight: height,
    addEventListener(type, fn) {
      if (!winListeners.has(type)) winListeners.set(type, []);
      winListeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      winListeners.set(type, (winListeners.get(type) || []).filter((candidate) => candidate !== fn));
    }
  };
  return doc;
}

function fakeEvent(overrides = {}) {
  return {
    shiftKey: false,
    clientX: 100,
    clientY: 120,
    prevented: 0,
    preventDefault() { this.prevented += 1; },
    stopPropagation() {},
    ...overrides
  };
}

function menuItems(overrides = {}) {
  const calls = [];
  return {
    calls,
    items: [
      { id: "copy", label: "Copy", run: () => calls.push("copy") },
      { type: "separator" },
      { id: "rename", label: "Rename", disabled: true, run: () => calls.push("rename") },
      { id: "favorite", label: "Favorite", run: () => calls.push("favorite") }
    ],
    ...overrides
  };
}

test("shift right click keeps the native browser menu and never prevents default", () => {
  const doc = fakeDocument();
  const menu = createContextMenu({ document: doc, t: (key) => key });
  const event = fakeEvent({ shiftKey: true });

  assert.equal(menu.show({ event, items: menuItems().items }), false);
  assert.equal(menu.isOpen(), false);
  assert.equal(event.prevented, 0);
  assert.equal(doc.body.children.length, 0);
  menu.dispose();
});

test("menu exposes role menu/menuitem with separators, disabled state and viewport clamping", () => {
  const doc = fakeDocument({ width: 220, height: 240 });
  const menu = createContextMenu({ document: doc, t: () => null });
  const { items, calls } = menuItems();

  assert.equal(menu.show({ event: fakeEvent({ clientX: 900, clientY: 900 }), items }), true);
  const portal = doc.body.children[0];
  assert.equal(portal.getAttribute("role"), "menu");
  assert.equal(portal.hidden, false);

  const buttons = portal.children.filter((child) => child.getAttribute("role") === "menuitem");
  const separators = portal.children.filter((child) => child.getAttribute("role") === "separator");
  assert.equal(buttons.length, 3);
  assert.equal(separators.length, 1);
  assert.equal(portal.children[0].getAttribute("role"), "menuitem");
  assert.equal(portal.children[portal.children.length - 1].getAttribute("role"), "menuitem");

  const rename = buttons.find((button) => button.textContent === "Rename");
  assert.equal(rename.disabled, true);
  assert.equal(rename.getAttribute("aria-disabled"), "true");

  const left = Number(portal.getAttribute("data-menu-left"));
  const top = Number(portal.getAttribute("data-menu-top"));
  assert.ok(left >= 8, `left ${left} within margin`);
  assert.ok(left < 220 - 8, `left ${left} clamped to small viewport`);
  assert.ok(top >= 8, `top ${top} within margin`);

  rename.dispatch("click");
  assert.deepEqual(calls, [], "disabled item never runs");

  menu.dispose();
  assert.equal(doc.body.children.length, 0);
});

test("keyboard navigation, activation, escape focus restore and tab close", () => {
  const doc = fakeDocument();
  const anchor = doc.createElement("button");
  doc.body.append(anchor);
  anchor.focus();
  const menu = createContextMenu({ document: doc, t: (key) => key });
  const { items, calls } = menuItems();

  assert.equal(menu.show({ anchor, items }), true);
  const portal = doc.body.children[doc.body.children.length - 1];
  const buttons = portal.children.filter((child) => child.getAttribute("role") === "menuitem");

  // First enabled item is focused on open (disabled items are skipped).
  assert.equal(doc.activeElement, buttons[0]);
  assert.equal(buttons[0].getAttribute("tabindex"), "0");

  doc.activeElement.dispatch("keydown", { key: "ArrowDown" });
  assert.equal(doc.activeElement, buttons[2], "disabled item skipped by ArrowDown");
  doc.activeElement.dispatch("keydown", { key: "ArrowUp" });
  assert.equal(doc.activeElement, buttons[0]);
  doc.activeElement.dispatch("keydown", { key: "End" });
  assert.equal(doc.activeElement, buttons[2]);
  doc.activeElement.dispatch("keydown", { key: "Home" });
  assert.equal(doc.activeElement, buttons[0]);

  doc.activeElement.dispatch("keydown", { key: "Enter" });
  assert.deepEqual(calls, ["copy"]);
  assert.equal(menu.isOpen(), false);
  assert.equal(doc.activeElement, anchor, "focus restored to the opener");

  assert.equal(menu.show({ anchor, items }), true);
  doc.activeElement.dispatch("keydown", { key: "Escape" });
  assert.equal(menu.isOpen(), false);
  assert.equal(doc.activeElement, anchor);

  assert.equal(menu.show({ anchor, items }), true);
  doc.activeElement.dispatch("keydown", { key: "Tab" });
  assert.equal(menu.isOpen(), false);
  menu.dispose();
});

test("outside pointerdown closes and contains() reports portal membership", () => {
  const doc = fakeDocument();
  const menu = createContextMenu({ document: doc, t: (key) => key });
  const { items } = menuItems();
  assert.equal(menu.show({ event: fakeEvent(), items }), true);
  const portal = doc.body.children[0];
  const firstButton = portal.children[0];

  assert.equal(menu.contains(firstButton), true);
  assert.equal(menu.contains(doc.createElement("span")), false);
  assert.equal(doc.listenerCount("pointerdown"), 1);

  doc.dispatch("pointerdown", { target: doc.createElement("div") });
  assert.equal(menu.isOpen(), false);
  assert.equal(doc.listenerCount("pointerdown"), 0);
  menu.dispose();
});

test("availability is re-checked immediately before an action runs", () => {
  const doc = fakeDocument();
  const menu = createContextMenu({ document: doc, t: (key) => key });
  const calls = [];
  let available = true;
  const items = [{ id: "fork", label: "Fork", disabled: () => !available, run: () => calls.push("fork") }];

  assert.equal(menu.show({ event: fakeEvent(), items }), true);
  available = false;
  const portal = doc.body.children[0];
  const button = portal.children[0];
  button.dispatch("click");
  assert.deepEqual(calls, [], "stale action is not executed");
  assert.equal(menu.isOpen(), true, "menu stays open when the action is no longer available");

  available = true;
  button.dispatch("click");
  assert.deepEqual(calls, ["fork"]);
  menu.dispose();
});

test("position clamping and normalization are bounded for short screens", () => {
  const clamped = clampMenuPosition({ x: 500, y: 400, width: 300, height: 500, viewportWidth: 320, viewportHeight: 420 });
  assert.ok(clamped.left >= 8);
  assert.ok(clamped.left + 300 <= 320 || clamped.maxWidth <= 304);
  assert.ok(clamped.top >= 8);
  assert.ok(clamped.maxHeight >= 8);
  assert.ok(clamped.maxHeight <= 420);

  const tiny = clampMenuPosition({ x: -50, y: -50, width: 10, height: 10, viewportWidth: 60, viewportHeight: 60 });
  assert.equal(tiny.left, 8);
  assert.equal(tiny.top, 8);

  assert.deepEqual(normalizeMenuItems([{ type: "separator" }]), []);
  const normalized = normalizeMenuItems([
    { type: "separator" },
    { id: "a", label: "A", run: () => {} },
    { type: "separator" },
    { type: "separator" },
    { id: "b", label: "B", run: () => {} },
    { type: "separator" }
  ]);
  assert.deepEqual(normalized.map((item) => item.type || item.id), ["a", "separator", "b"]);
});

test("dispose closes the menu and removes the body portal", () => {
  const doc = fakeDocument();
  const menu = createContextMenu({ document: doc, t: (key) => key });
  menu.show({ event: fakeEvent(), items: menuItems().items });
  assert.equal(doc.body.children.length, 1);
  menu.dispose();
  assert.equal(menu.isOpen(), false);
  assert.equal(doc.body.children.length, 0);
  assert.equal(menu.show({ event: fakeEvent(), items: menuItems().items }), false);
});
