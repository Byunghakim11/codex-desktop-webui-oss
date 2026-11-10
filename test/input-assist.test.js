import test from "node:test";
import assert from "node:assert/strict";

import {
  createInputAssist,
  filterSlashCommands,
  findAssistToken,
  quoteWorkspaceReference,
  replaceAssistToken,
  safeWorkspaceCandidate
} from "../public/input-assist.js";
import { composerAssistMessages } from "../public/input-assist-messages.js";

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const tick = () => new Promise(resolve => setImmediate(resolve));

function makeDocument() {
  const listeners = new Map();
  const document = {
    createElement(tag) {
      const nodeListeners = new Map();
      const node = {
        tagName: String(tag).toUpperCase(),
        className: "",
        textContent: "",
        id: "",
        hidden: false,
        attributes: new Map(),
        children: [],
        parent: null,
        parentNode: null,
        addEventListener(type, fn) {
          if (!nodeListeners.has(type)) nodeListeners.set(type, []);
          nodeListeners.get(type).push(fn);
        },
        removeEventListener(type, fn) {
          nodeListeners.set(type, (nodeListeners.get(type) || []).filter(item => item !== fn));
        },
        dispatch(type, event) {
          for (const fn of nodeListeners.get(type) || []) fn(event || { type, target: node });
        },
        setAttribute(name, value) {
          node.attributes.set(name, String(value));
          if (name === "id") node.id = String(value);
        },
        getAttribute(name) {
          return node.attributes.has(name) ? node.attributes.get(name) : null;
        },
        removeAttribute(name) {
          node.attributes.delete(name);
        },
        append(...children) {
          for (const child of children) {
            child.parent = node;
            child.parentNode = node;
            node.children.push(child);
          }
        },
        appendChild(child) {
          node.append(child);
          return child;
        },
        removeChild(child) {
          node.children = node.children.filter(item => item !== child);
          if (child.parent === node) child.parent = null;
          if (child.parentNode === node) child.parentNode = null;
          return child;
        },
        remove() {
          const parent = node.parentNode || node.parent;
          if (parent && typeof parent.removeChild === "function") parent.removeChild(node);
          node.parent = null;
          node.parentNode = null;
        }
      };
      return node;
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      listeners.set(type, (listeners.get(type) || []).filter(item => item !== fn));
    },
    emit(type, event) {
      for (const fn of listeners.get(type) || []) fn(event || { type });
    },
    listenerCount(type) {
      return (listeners.get(type) || []).length;
    }
  };
  return document;
}

function makeInput(initial = "") {
  const listeners = new Map();
  const input = {
    value: initial,
    selectionStart: initial.length,
    selectionEnd: initial.length,
    attributes: new Map(),
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      listeners.set(type, (listeners.get(type) || []).filter(item => item !== fn));
    },
    setAttribute(name, value) {
      input.attributes.set(name, String(value));
    },
    getAttribute(name) {
      return input.attributes.has(name) ? input.attributes.get(name) : null;
    },
    removeAttribute(name) {
      input.attributes.delete(name);
    },
    setSelectionRange(start, end = start) {
      input.selectionStart = start;
      input.selectionEnd = end;
    },
    dispatchEvent(event) {
      const type = typeof event === "string" ? event : event?.type;
      for (const fn of listeners.get(type) || []) fn(event);
      return true;
    },
    emit(type, event) {
      input.dispatchEvent(event || { type, target: input });
    },
    listenerTypes() {
      return [...listeners.keys()];
    },
    put(value, caret = value.length) {
      input.value = value;
      input.selectionStart = caret;
      input.selectionEnd = caret;
      input.emit("input");
    },
    press(key, overrides = {}) {
      const event = {
        type: "keydown",
        key,
        isComposing: false,
        defaultPrevented: false,
        immediateStopped: false,
        preventDefault() {
          event.defaultPrevented = true;
        },
        stopImmediatePropagation() {
          event.immediateStopped = true;
        },
        stopPropagation() {},
        ...overrides
      };
      input.emit("keydown", event);
      return event;
    }
  };
  return input;
}

function makeHost() {
  return {
    children: [],
    append(node) {
      node.parent = this;
      node.parentNode = this;
      this.children.push(node);
    },
    removeChild(node) {
      this.children = this.children.filter(item => item !== node);
      if (node.parent === this) node.parent = null;
      if (node.parentNode === this) node.parentNode = null;
      return node;
    }
  };
}

function makeT(locale) {
  return key => composerAssistMessages[locale.current]?.[key] ?? key;
}

function command(name, overrides = {}) {
  return {
    id: name,
    name,
    description: `${name} description`,
    enabled: true,
    run: async () => {},
    ...overrides
  };
}

function setup(options = {}) {
  const document = makeDocument();
  const input = makeInput(options.value ?? "");
  const host = makeHost();
  const state = {
    key: "context-1",
    threadId: options.threadId === undefined ? "thread-1" : options.threadId,
    connected: options.connected ?? true
  };
  const locale = { current: options.locale ?? "en" };
  const calls = { commands: 0, search: [], run: [], feedback: [], registered: [] };
  const commands = options.commands ?? [
    command("review", { run: async () => calls.run.push("review") }),
    command("new", { run: async () => calls.run.push("new") }),
    command("help", { run: async () => calls.run.push("help") })
  ];
  const searchFiles = options.searchFiles ?? (async ({ query }) => ({
    entries: [{ name: `${query}.js`, path: `src/${query}.js`, kind: "file" }]
  }));
  const assist = createInputAssist({
    document,
    input,
    host,
    t: makeT(locale),
    registerMessages: bundle => calls.registered.push(bundle),
    getContext: () => ({ ...state }),
    getCommands: () => {
      calls.commands += 1;
      return commands;
    },
    searchFiles: async payload => {
      calls.search.push(payload);
      return searchFiles(payload);
    },
    onFeedback: entry => calls.feedback.push(entry)
  });
  return { document, input, host, state, locale, calls, commands, assist };
}

function popupOf(host) {
  assert.equal(host.children.length, 1, "expected exactly one popup in host");
  return host.children[0];
}

test("findAssistToken finds only a leading slash command token", () => {
  const token = findAssistToken("/rev", 4);
  assert.equal(token.kind, "slash");
  assert.equal(token.start, 0);
  assert.equal(token.end, 4);
  assert.equal(token.query, "rev");
  assert.equal(token.raw, "/rev");

  assert.equal(findAssistToken("/review src/app.js", 7).query, "review");
  assert.equal(findAssistToken("/review src/app.js", 7).end, 7);
  assert.equal(findAssistToken("/review src/app.js", 8), null);
  assert.equal(findAssistToken("please /rev", 11), null);
  assert.equal(findAssistToken("and/or", 7), null);
  assert.equal(findAssistToken("/usr/bin/ls", 11), null);
  assert.equal(findAssistToken("/.env", 5), null);
  assert.equal(findAssistToken("", 0), null);
  assert.equal(findAssistToken("/", 0), null);
  assert.equal(findAssistToken("/", 1).query, "");
});

test("findAssistToken handles @ word boundaries, email and code fences", () => {
  const at = findAssistToken("see @src/app.js", 15);
  assert.equal(at.kind, "file");
  assert.equal(at.start, 4);
  assert.equal(at.query, "src/app.js");
  assert.equal(at.raw, "@src/app.js");

  const partial = findAssistToken("see @src/app.js", 8);
  assert.equal(partial.query, "src");
  assert.equal(partial.end, 15);

  assert.equal(findAssistToken("mail dev@example.com", 19), null);
  assert.equal(findAssistToken("addr@example.com", 16), null);
  assert.equal(findAssistToken("```\n@src/a\n```", 10), null);
  assert.equal(findAssistToken("```\ncode\n```\n@src/a", 20).kind, "file");
  assert.equal(findAssistToken("hello @", 7).query, "");
});

test("filterSlashCommands matches names case-insensitively and caps at 20", () => {
  const commands = [command("Review"), command("new"), command("REload")];
  assert.deepEqual(filterSlashCommands(commands, "re").map(item => item.name), ["Review", "REload"]);
  assert.deepEqual(filterSlashCommands(commands, "/re").map(item => item.name), ["Review", "REload"]);
  assert.deepEqual(filterSlashCommands(commands, "").length, 3);
  assert.deepEqual(filterSlashCommands(commands, "zzz"), []);
  assert.deepEqual(filterSlashCommands(null, "re"), []);
  const many = Array.from({ length: 25 }, (unused, index) => command(`cmd-${index}`));
  assert.equal(filterSlashCommands(many, "").length, 20);
});

test("safeWorkspaceCandidate accepts relative workspace entries only", () => {
  assert.deepEqual(safeWorkspaceCandidate({ name: "app.js", path: "src/app.js", kind: "file" }), {
    name: "app.js",
    path: "src/app.js",
    kind: "file"
  });
  assert.equal(safeWorkspaceCandidate({ path: "src/lib", kind: "directory" }).name, "lib");
  for (const path of [
    "/etc/passwd",
    "\\\\server\\share",
    "C:\\temp\\a.txt",
    "C:/temp/a.txt",
    "../secrets.txt",
    "src/../../a.txt",
    "src/./a.txt",
    "src//a.txt",
    ".env",
    ".git/config",
    ".ssh/id_rsa",
    ".codex/config",
    "src/.hidden/a.js",
    "src/a\u0000.js",
    "~/a.js"
  ]) {
    assert.equal(safeWorkspaceCandidate({ path, kind: "file" }), null, `expected rejection for ${JSON.stringify(path)}`);
  }
  assert.equal(safeWorkspaceCandidate({ path: "src/a.js", kind: "socket" }), null);
  assert.equal(safeWorkspaceCandidate(null), null);
});

test("quoteWorkspaceReference and replaceAssistToken keep surrounding text", () => {
  assert.equal(quoteWorkspaceReference("src/app.js"), "@src/app.js");
  assert.equal(quoteWorkspaceReference("src/my app.js"), '@"src/my app.js"');
  assert.equal(quoteWorkspaceReference(""), "");

  const token = findAssistToken("check @src/my", 12);
  const replaced = replaceAssistToken("check @src/my", token, '@"src/my app.js"');
  assert.equal(replaced.text, 'check @"src/my app.js"');
  assert.equal(replaced.caret, replaced.text.length);

  const mid = findAssistToken("a /rev b", 6);
  assert.equal(mid, null);
  const partial = replaceAssistToken("hello @cx world", findAssistToken("hello @cx world", 9), "@src/app.js");
  assert.equal(partial.text, "hello @src/app.js world");
  assert.equal(partial.caret, "hello @src/app.js".length);
});

test("slash popup opens at token zero with listbox and input aria wiring", async () => {
  const { input, host, assist, calls } = setup({ value: "/", commands: [command("review"), command("new")] });
  input.put("/");
  const popup = popupOf(host);
  assert.equal(popup.getAttribute("role"), "listbox");
  assert.equal(popup.getAttribute("aria-label"), "Slash commands");
  assert.equal(popup.children.length, 2);
  assert.equal(popup.children[0].textContent, "/review — review description");
  assert.equal(input.getAttribute("aria-expanded"), "true");
  assert.equal(input.getAttribute("aria-controls"), popup.getAttribute("id"));
  assert.equal(input.getAttribute("aria-autocomplete"), "list");
  assert.equal(input.getAttribute("aria-activedescendant"), popup.children[0].getAttribute("id"));
  assert.equal(calls.registered.length, 1);
  assist.dispose();
});

test("slash popup does not hijack prose, ordinary paths or non-first tokens", () => {
  const { input, host, assist } = setup();
  input.put("hello /rev");
  assert.equal(host.children.length, 0);
  input.put("and/or");
  assert.equal(host.children.length, 0);
  input.put("/usr/bin/ls");
  assert.equal(host.children.length, 0);
  input.put("@ not a command");
  assert.equal(host.children.length, 0);
  assist.dispose();
});

test("arrow keys wrap and Escape closes without clearing input", () => {
  const { input, host, assist } = setup();
  input.put("/");
  const popup = popupOf(host);
  input.press("ArrowDown");
  assert.equal(popup.children[1].getAttribute("aria-selected"), "true");
  assert.equal(input.getAttribute("aria-activedescendant"), popup.children[1].getAttribute("id"));
  input.press("ArrowDown");
  input.press("ArrowDown");
  assert.equal(popup.children[0].getAttribute("aria-selected"), "true");
  input.press("ArrowUp");
  assert.equal(popup.children[2].getAttribute("aria-selected"), "true");

  const escape = input.press("Escape");
  assert.equal(escape.defaultPrevented, true);
  assert.equal(input.value, "/");
  assert.equal(host.children.length, 0);
  assert.equal(input.getAttribute("aria-expanded"), null);
  assist.dispose();
});

test("Enter accepts one command, clears the exact slash token and stops propagation", async () => {
  const { input, host, assist, calls } = setup();
  input.put("/rev");
  const event = input.press("Enter");
  assert.equal(event.defaultPrevented, true);
  assert.equal(event.immediateStopped, true);
  assert.equal(host.children.length, 0);
  assert.equal(input.value, "");
  await tick();
  assert.deepEqual(calls.run, ["review"]);

  const second = input.press("Enter");
  assert.equal(second.defaultPrevented, false);
  await tick();
  assert.deepEqual(calls.run, ["review"]);
  assist.dispose();
});

test("Tab accepts the selected command once", async () => {
  const { input, assist, calls } = setup();
  input.put("/");
  input.press("ArrowDown");
  const event = input.press("Tab");
  assert.equal(event.defaultPrevented, true);
  assert.equal(event.immediateStopped, true);
  await tick();
  assert.deepEqual(calls.run, ["new"]);
  assist.dispose();
});

test("double click runs the action once and preserves input caret", async () => {
  const { input, host, assist, calls } = setup();
  input.put("/rev");
  const option = popupOf(host).children[0];
  option.dispatch("mousedown", { type: "mousedown", preventDefault() {} });
  option.dispatch("click", { type: "click" });
  option.dispatch("click", { type: "click" });
  await tick();
  assert.deepEqual(calls.run, ["review"]);
  assist.dispose();
});

test("disabled commands are rechecked before running", async () => {
  let enabled = true;
  const { input, assist, calls } = setup({
    commands: [command("review", { run: async () => calls.run.push("review"), enabled: () => enabled })]
  });
  input.put("/rev");
  enabled = false;
  input.press("Enter");
  await tick();
  assert.deepEqual(calls.run, []);
  assert.equal(calls.feedback.length, 1);
  assert.equal(calls.feedback[0].code, "composerAssist.error.disabled");
  assert.equal(input.value, "/rev");
  assist.dispose();
});

test("context is rechecked before running a slash command", async () => {
  const { input, assist, calls, state } = setup();
  input.put("/rev");
  state.threadId = "thread-2";
  input.press("Enter");
  await tick();
  assert.deepEqual(calls.run, []);
  assert.equal(calls.feedback[0].code, "composerAssist.error.contextChanged");
  assert.equal(input.value, "/rev");
  assist.dispose();
});

test("async command results never overwrite text typed after acceptance", async () => {
  let finish;
  const { input, assist } = setup({
    commands: [command("review", { run: () => new Promise(resolve => { finish = resolve; }) })]
  });
  input.put("/rev");
  input.press("Enter");
  input.value = "typed while running";
  finish();
  await tick();
  assert.equal(input.value, "typed while running");
  assist.dispose();
});

test("@ without a selected chat shows a localized hint and never searches", async () => {
  const { input, host, assist, calls } = setup({ threadId: null });
  input.put("@src", 4);
  const popup = popupOf(host);
  assert.equal(popup.children.length, 1);
  assert.equal(popup.children[0].textContent, composerAssistMessages.en["composerAssist.chooseChat"]);
  await delay(200);
  assert.equal(calls.search.length, 0);
  const event = input.press("Enter");
  assert.equal(event.defaultPrevented, false);
  await delay(10);
  assert.equal(input.value, "@src");
  assist.dispose();
});

test("@ search is debounced 150ms with metadata only", async () => {
  const { input, assist, calls } = setup();
  input.put("@sr", 3);
  assert.equal(calls.search.length, 0);
  await delay(90);
  assert.equal(calls.search.length, 0);
  await delay(120);
  assert.equal(calls.search.length, 1);
  assert.equal(calls.search[0].query, "sr");
  assert.equal(calls.search[0].threadId, "thread-1");
  assert.ok(calls.search[0].signal);
  assert.deepEqual(Object.keys(calls.search[0]).sort(), ["query", "signal", "threadId"]);
  assist.dispose();
});

test("stale @ queries are aborted and cannot render over newer results", async () => {
  const pending = [];
  const { input, host, assist } = setup({
    searchFiles: ({ query, signal }) => new Promise(resolve => pending.push({ query, signal, resolve }))
  });
  input.put("@a", 2);
  await delay(200);
  assert.equal(pending.length, 1);
  input.put("@ab", 3);
  await delay(200);
  assert.equal(pending.length, 2);
  assert.equal(pending[0].signal.aborted, true);
  assert.equal(pending[1].signal.aborted, false);

  pending[1].resolve({ entries: [{ name: "ab.js", path: "src/ab.js", kind: "file" }] });
  await tick();
  const popup = popupOf(host);
  assert.equal(popup.children.length, 1);
  assert.equal(popup.children[0].textContent, "src/ab.js");

  pending[0].resolve({ entries: [{ name: "a.js", path: "src/a.js", kind: "file" }] });
  await tick();
  assert.equal(popup.children[0].textContent, "src/ab.js");
  assist.dispose();
});

test("context changes drop in-flight @ results", async () => {
  const pending = [];
  const { input, host, assist, state } = setup({
    searchFiles: ({ signal }) => new Promise(resolve => pending.push({ signal, resolve }))
  });
  input.put("@a", 2);
  await delay(200);
  assert.equal(pending.length, 1);
  state.threadId = "thread-2";
  assist.contextChanged();
  assert.equal(host.children.length, 0);
  pending[0].resolve({ entries: [{ name: "a.js", path: "src/a.js", kind: "file" }] });
  await tick();
  assert.equal(host.children.length, 0);
  assert.equal(input.value, "@a");
  assist.dispose();
});

test("selecting a file inserts a quoted @ reference and preserves caret", async () => {
  const { input, host, assist } = setup({
    searchFiles: async () => ({ entries: [{ name: "my app.js", path: "src/my app.js", kind: "file" }, { path: ".env", kind: "file" }] })
  });
  input.put("check @src/my", 12);
  await delay(200);
  const popup = popupOf(host);
  assert.equal(popup.children.length, 1, "unsafe candidates are filtered out");
  popup.children[0].dispatch("mousedown", { type: "mousedown", preventDefault() {} });
  assert.equal(input.value, 'check @"src/my app.js"');
  assert.equal(input.selectionStart, input.value.length);
  assert.equal(input.selectionEnd, input.value.length);
  assist.dispose();
});

test("IME composition blocks acceptance until compositionend", async () => {
  const { input, assist, calls } = setup();
  input.put("/rev");
  input.emit("compositionstart");
  const blocked = input.press("Enter", { isComposing: true });
  assert.equal(blocked.defaultPrevented, false);
  await tick();
  assert.deepEqual(calls.run, []);
  input.put("/rev");
  input.emit("compositionend");
  const accepted = input.press("Enter");
  assert.equal(accepted.defaultPrevented, true);
  await tick();
  assert.deepEqual(calls.run, ["review"]);
  assist.dispose();
});

test("locale refresh relabels only and keeps composer buffer and selection", () => {
  const { input, host, locale, assist } = setup({ threadId: null });
  input.put("draft @src", 10);
  const popup = popupOf(host);
  assert.equal(popup.children[0].textContent, composerAssistMessages.en["composerAssist.chooseChat"]);
  locale.current = "ko";
  assist.refresh();
  assert.equal(input.value, "draft @src");
  assert.equal(input.selectionStart, 10);
  assert.equal(input.selectionEnd, 10);
  assert.equal(popup.children[0].textContent, composerAssistMessages.ko["composerAssist.chooseChat"]);
  assist.dispose();
});

test("outside pointer closes only this popup; inside pointer keeps it", () => {
  const { document, input, host, assist } = setup();
  input.put("/");
  const popup = popupOf(host);
  document.emit("pointerdown", { type: "pointerdown", target: popup.children[0] });
  assert.equal(host.children.length, 1);
  const outside = document.createElement("div");
  document.emit("pointerdown", { type: "pointerdown", target: outside });
  assert.equal(host.children.length, 0);
  assert.equal(input.value, "/");
  assist.dispose();
});

test("dispose aborts pending work, removes listeners and restores aria", async () => {
  const pending = [];
  const { document, input, host, assist } = setup({
    searchFiles: ({ signal }) => new Promise(resolve => pending.push({ signal, resolve }))
  });
  input.setAttribute("aria-controls", "composer-own");
  input.put("@a", 2);
  assert.equal(input.getAttribute("aria-controls"), host.children[0].getAttribute("id"));
  assert.equal(input.getAttribute("aria-expanded"), "true");
  await delay(200);
  assert.equal(pending.length, 1);
  assist.dispose();
  assert.equal(host.children.length, 0);
  assert.equal(input.getAttribute("aria-controls"), "composer-own");
  assert.equal(input.getAttribute("aria-expanded"), null);
  assert.equal(input.getAttribute("aria-activedescendant"), null);
  assert.equal(pending[0].signal.aborted, true);
  assert.equal(document.listenerCount("pointerdown"), 0);

  input.put("/new");
  assert.equal(host.children.length, 0);
  input.put("@n", 2);
  await delay(200);
  assert.equal(pending.length, 1);
});

test("dispose cancels a debounced search before it starts", async () => {
  const { input, assist, calls } = setup();
  input.put("@a", 2);
  assist.dispose();
  await delay(200);
  assert.equal(calls.search.length, 0);
});

test("message bundles keep EN/KO key parity", () => {
  const en = Object.keys(composerAssistMessages.en).sort();
  const ko = Object.keys(composerAssistMessages.ko).sort();
  assert.deepEqual(ko, en);
  for (const key of en) {
    assert.match(key, /^composerAssist\./);
    assert.ok(composerAssistMessages.en[key].length > 0);
    assert.ok(composerAssistMessages.ko[key].length > 0);
  }
});
