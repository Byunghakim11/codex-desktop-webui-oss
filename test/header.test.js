import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import en from "../public/i18n/en.js";
import ko from "../public/i18n/ko.js";
import { createLocaleRuntime } from "../public/ui/locale.js";
import { registerUI, uiMessages } from "../public/ui/messages.js";
import {
  connectionLabel,
  createLanguageSelector,
  compactTitle,
  projectBreadcrumbText,
  projectNewThreadLabel
} from "../public/ui/header.js";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const HAN = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

function fakeDocument() {
  const doc = {
    createElement(tag) {
      const listeners = new Map();
      return {
        tagName: String(tag).toUpperCase(),
        value: "",
        textContent: "",
        title: "",
        attributes: new Map(),
        children: [],
        addEventListener(type, fn) {
          if (!listeners.has(type)) listeners.set(type, []);
          listeners.get(type).push(fn);
        },
        removeEventListener(type, fn) {
          listeners.set(type, (listeners.get(type) || []).filter((candidate) => candidate !== fn));
        },
        dispatch(type) {
          const event = { type };
          for (const fn of listeners.get(type) || []) fn(event);
        },
        append(...nodes) { this.children.push(...nodes); },
        replaceChildren() { this.children = []; },
        setAttribute(name, value) { this.attributes.set(name, String(value)); },
        getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
      };
    }
  };
  return doc;
}

test("the static document starts in English with no Chinese UI text", () => {
  assert.match(html, /<html lang="en">/);
  assert.equal(HAN.test(html), false, "no Han UI text may remain in index.html");
  assert.match(html, /<title>Codex WebUI<\/title>/);
  // Every static label is keyed so locale changes only relabel.
  for (const key of [
    "thread.new",
    "composer.send",
    "auth.deviceLogin",
    "empty.chooseTitle",
    "files.title",
    "theme.label",
    "ui.header.more",
    "ui.language.label"
  ]) {
    assert.ok(html.includes(`data-i18n="${key}"`), `missing data-i18n key ${key}`);
  }
  assert.equal(/data-i18n="[^"]*"[^>]*>[\u4e00-\u9fff]/.test(html), false);
});

test("every static data-i18n key resolves to a real bilingual label", () => {
  const known = new Set([...Object.keys(en), ...Object.keys(uiMessages.en)]);
  const knownKo = new Set([...Object.keys(ko), ...Object.keys(uiMessages.ko)]);
  const keys = new Set();
  for (const match of html.matchAll(/data-i18n(?:-placeholder|-title|-aria-label)?="([^"]+)"/g)) keys.add(match[1]);
  assert.ok(keys.size > 30, "index.html should stay fully keyed");
  for (const key of keys) {
    assert.ok(known.has(key), `missing English label for ${key}`);
    assert.ok(knownKo.has(key), `missing Korean label for ${key}`);
  }
});

test("compact header keeps required ids, slots and a language selector", () => {
  for (const id of [
    "workflowMenu",
    "workflowMenuBody",
    "workflowSearchHost",
    "threadTitle",
    "resumeStatus",
    "activityToggle",
    "fullscreenToggle",
    "filesToggle",
    "filesPanel",
    "threadBreadcrumb",
    "headerSearchSlot",
    "headerBookmarksSlot",
    "headerFilesButton",
    "headerConnection",
    "languageSelect"
  ]) {
    assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
  }
  // The language selector sits next to the theme control in the sidebar brand row.
  assert.ok(html.indexOf('id="themeSelect"') < html.indexOf('id="languageSelect"'));
  // Files/connection stay in the header row while the isolated tools row is gone.
  assert.equal(/class="tools-row"|workflow-tools-row/.test(html), false);
  assert.ok(html.indexOf('id="headerSearchSlot"') < html.indexOf('id="workflowMenu"'));
});

test("the header keeps controls that are hosted, not re-implemented", () => {
  const workflow = appSource.slice(appSource.indexOf("function initializeWorkflow("));
  assert.match(workflow, /mountHeaderControl\(\{ slot: document\.querySelector\("#headerSearchSlot"\)/);
  assert.match(workflow, /mountHeaderControl\(\{ slot: document\.querySelector\("#headerBookmarksSlot"\)/);
  assert.match(workflow, /\.wf-open-search/);
  assert.match(workflow, /\.wf-open-bookmarks/);
  // The Files header button reuses the existing drawer toggle callback.
  assert.match(appSource, /#filesToggle"\)\?\.click\(\)/);
  // No second engine takeover button was added.
  assert.equal(/id="enterEngine"|second-engine/.test(html), false);
});

test("connection wording is a real app status, not internal ownership wording", () => {
  const t = (key) => (key === "ui.header.connection" ? "Connection" : key);
  const connected = connectionLabel({ connected: true, desktopConnected: true, t });
  assert.notEqual(connected.text, "Desktop owns it");
  assert.notEqual(connected.text, "thread.bridgeConnected");
  assert.equal(connected.state, "connected");
  assert.equal(connectionLabel({ connected: true, t }).state, "app");
  assert.equal(connectionLabel({ reconnecting: true, t }).state, "reconnecting");
  assert.equal(connectionLabel({ t }).state, "offline");

  assert.equal(
    appSource.includes('t(resuming ? "thread.bridgeLoading" : resumed ? "thread.bridgeConnected" : "thread.bridgeLoad")'),
    false,
    "the visible 'Desktop owns it' label must be replaced"
  );
  assert.match(appSource, /resumed \? "ui\.header\.connectedApp" : "thread\.bridgeLoad"/);
});

test("breadcrumb and per-project labels use the group's own project name", () => {
  const t = (key, params) => {
    if (key === "ui.header.project") return `Project: ${params?.project}`;
    if (key === "ui.project.newThread") return `New conversation in ${params?.project}`;
    if (key === "ui.header.noProject") return "No project";
    return key;
  };
  assert.equal(projectBreadcrumbText({ project: "Alpha", t }), "Project: Alpha");
  assert.equal(projectBreadcrumbText({ project: "", t }), "No project");
  assert.equal(projectNewThreadLabel({ project: "Alpha", t }), "New conversation in Alpha");
  assert.equal(compactTitle("  a   b  "), "a b");
  assert.ok(compactTitle("x".repeat(300)).length <= 120);
});

test("language selector renders both languages and reports changes without reloading", () => {
  const doc = fakeDocument();
  const select = doc.createElement("select");
  const changes = [];
  const t = (key) => (key === "ui.language.korean" ? "한국어" : key === "ui.language.english" ? "English" : key === "ui.language.label" ? "Language" : key);
  const selector = createLanguageSelector({ document: doc, select, t, current: "en", onChange: (value) => changes.push(value) });

  assert.deepEqual(select.children.map((option) => option.value), ["en", "ko"]);
  assert.deepEqual(select.children.map((option) => option.textContent), ["English", "한국어"]);
  assert.equal(select.value, "en");
  assert.equal(select.getAttribute("aria-label"), "Language");

  select.value = "ko";
  select.dispatch("change");
  assert.deepEqual(changes, ["ko"]);

  selector.render("ko");
  assert.equal(select.value, "ko");
  selector.dispose();
  select.value = "en";
  select.dispatch("change");
  assert.deepEqual(changes, ["ko"], "disposed selector stops reporting");
});

test("UI message bundle only adds new ui.* keys with EN/KO parity", () => {
  const baseKeys = new Set([...Object.keys(en), ...Object.keys(ko)]);
  const enKeys = Object.keys(uiMessages.en);
  const koKeys = Object.keys(uiMessages.ko);
  assert.deepEqual(enKeys.sort(), koKeys.sort());
  for (const key of enKeys) {
    assert.match(key, /^ui\./, `${key} must use the ui.* prefix`);
    assert.equal(baseKeys.has(key), false, `${key} would override a base key`);
    assert.equal(typeof uiMessages.en[key], "string");
    assert.equal(typeof uiMessages.ko[key], "string");
    assert.ok(uiMessages.en[key].trim().length > 0);
    assert.ok(uiMessages.ko[key].trim().length > 0);
  }
  assert.equal(HAN.test(JSON.stringify(uiMessages.ko)), false, "Korean labels must not contain Han characters");
  const placeholders = (value) => [...value.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((match) => match[1]).sort().join(",");
  for (const key of enKeys) {
    assert.equal(placeholders(uiMessages.en[key]), placeholders(uiMessages.ko[key]), `placeholder mismatch in ${key}`);
  }
});

test("register UI bundle adds keys to a locale runtime and rejects base-key overrides", () => {
  const runtime = createLocaleRuntime({ document: fakeDocument(), navigator: { language: "en-US" }, storage: null });
  runtime.init();
  const added = registerUI(runtime.registerMessages);
  assert.equal(added, Object.keys(uiMessages.en).length);
  assert.equal(runtime.t("ui.header.more"), "More");
  runtime.setLocale("ko");
  assert.equal(runtime.t("ui.header.more"), "더보기");
  assert.throws(() => runtime.registerMessages({ en: { "thread.new": "X" }, ko: { "thread.new": "Y" } }), TypeError);
  // Registering our bundle twice would override our own keys, which is rejected too.
  assert.throws(() => registerUI(runtime.registerMessages), TypeError);
});

test("language changes relabel in place and never reload, rebuild messages or clear inputs", () => {
  assert.equal(/window\.location\.reload\(\)/.test(appSource), false, "no reload on language change");
  assert.equal(/addEventListener\("languagechange"/.test(appSource), false, "old browser languagechange reload handler removed");
  assert.match(appSource, /subscribeLocale\(/);
  assert.match(appSource, /onChange: \(value\) => \{\s*if \(!setLocale\(value\)\)/);
  assert.match(appSource, /function refreshLocalizedChrome\(/);
  const refresh = appSource.slice(appSource.indexOf("function refreshLocalizedChrome("));
  const body = refresh.slice(0, refresh.indexOf("\n}\n"));
  assert.equal(/renderMessages\(/.test(body), false, "language change must not rebuild the message list");
  assert.equal(/els\.threadTitle\.value\s*=/.test(body), false, "language change must not overwrite the rename text");
  assert.equal(/promptInput\.value\s*=/.test(body), false, "language change must not clear the composer");
  assert.equal(/asyncQuestionCards\.refresh|interactionController\.setContext/.test(body), false, "native answer forms stay mounted");
});
