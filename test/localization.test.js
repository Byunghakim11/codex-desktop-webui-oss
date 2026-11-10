import test from "node:test";
import assert from "node:assert/strict";
import en from "../public/i18n/en.js";
import ko from "../public/i18n/ko.js";
import {
  LANGUAGE_STORAGE_KEY,
  bindAttribute,
  bindText,
  createLocaleRuntime,
  currentLocale,
  initI18n,
  registerMessages,
  setLocale,
  subscribeLocale,
  supportedLanguage,
  supportedLanguages,
  t,
  translateDocument,
  unbindI18n,
} from "../public/ui/locale.js";

const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const placeholders = value => [...String(value).matchAll(/\{([A-Za-z0-9_]+)\}/g)].map(match => match[1]).sort();

class FakeStorage {
  constructor(initial = {}, { failGet = false, failSet = false } = {}) {
    this.values = new Map(Object.entries(initial));
    this.failGet = failGet;
    this.failSet = failSet;
    this.setCalls = [];
  }
  getItem(key) {
    if (this.failGet) throw new Error("storage read blocked");
    return this.values.has(key) ? this.values.get(key) : null;
  }
  setItem(key, value) {
    if (this.failSet) throw new Error("storage write blocked");
    this.setCalls.push([key, value]);
    this.values.set(key, value);
  }
}

// An HTMLCollection-shaped children value: length + item(), iterable, but not an Array.
class FakeCollection {
  constructor(items = []) {
    this.items = [...items];
  }
  get length() { return this.items.length; }
  item(index) { return this.items[index] ?? null; }
  [Symbol.iterator]() { return this.items[Symbol.iterator](); }
}

class FakeElement {
  constructor(tagName, { dataset = {}, classes = [], attributes = {}, textContent = "", value = "" } = {}) {
    this.tagName = tagName.toUpperCase();
    this.dataset = { ...dataset };
    this.classes = new Set(classes);
    this.attributes = new Map(Object.entries(attributes).map(([key, item]) => [key, String(item)]));
    this.classList = { contains: name => this.classes.has(name) };
    this.children = [];
    this.parentNode = null;
    this.textContent = textContent;
    this.value = value;
    this.selectionStart = 0;
    this.selectionEnd = 0;
    this.contentEditable = this.getAttribute("contenteditable") || "inherit";
  }
  append(...children) {
    for (const child of children) { child.parentNode = this; this.children.push(child); }
    return this;
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  hasAttribute(name) { return this.attributes.has(name); }
  get className() { return [...this.classes].join(" "); }
}

class FakeDocument {
  constructor() {
    this.documentElement = new FakeElement("html", { attributes: { lang: "en" } });
    this.body = new FakeElement("body");
    this.documentElement.append(this.body);
  }
  querySelectorAll(selector) {
    const datasetKey = {
      "[data-i18n]": "i18n",
      "[data-i18n-placeholder]": "i18nPlaceholder",
      "[data-i18n-title]": "i18nTitle",
      "[data-i18n-aria-label]": "i18nAriaLabel",
    }[selector];
    if (!datasetKey) throw new Error(`unsupported test selector: ${selector}`);
    const found = [];
    const visit = node => {
      for (const child of node.children) {
        if (typeof child.dataset?.[datasetKey] === "string" && child.dataset[datasetKey]) found.push(child);
        visit(child);
      }
    };
    visit(this.documentElement);
    return found;
  }
}

const runtimeFor = (languages = ["en-US"], storage = new FakeStorage()) => {
  const document = new FakeDocument();
  const runtime = createLocaleRuntime({ document, navigator: { languages, language: languages[0] }, storage });
  return { document, runtime, storage };
};

test("supported language list and browser/stored language resolution", () => {
  assert.deepEqual(supportedLanguages, ["en", "ko"]);
  assert.equal(supportedLanguage, supportedLanguages);

  assert.equal(runtimeFor(["ko-KR"]).runtime.init(), "ko");
  assert.equal(runtimeFor(["ko"]).runtime.init(), "ko");
  assert.equal(runtimeFor(["fr-FR", "ko-KR"]).runtime.init(), "en");
  assert.equal(runtimeFor([], new FakeStorage()).runtime.init(), "en");

  const storedEnglish = new FakeStorage({ [LANGUAGE_STORAGE_KEY]: "en-US" });
  assert.equal(runtimeFor(["ko-KR"], storedEnglish).runtime.init(), "en");
  const storedKorean = new FakeStorage({ [LANGUAGE_STORAGE_KEY]: "ko-KR" });
  assert.equal(runtimeFor(["en-US"], storedKorean).runtime.init(), "ko");
  const invalidStored = new FakeStorage({ [LANGUAGE_STORAGE_KEY]: "zh-CN" });
  assert.equal(runtimeFor(["ko-KR"], invalidStored).runtime.init(), "ko");
  const malformedStored = new FakeStorage({ [LANGUAGE_STORAGE_KEY]: "not-a-language" });
  assert.equal(runtimeFor(["en-US"], malformedStored).runtime.init(), "en");
});

test("setLocale accepts aliases, persists only language, rejects unsupported values, and tolerates storage failures", () => {
  const { document, runtime, storage } = runtimeFor(["en-US"]);
  runtime.init();
  assert.equal(runtime.setLocale("ko-KR"), true);
  assert.equal(runtime.currentLocale(), "ko");
  assert.equal(document.documentElement.getAttribute("lang"), "ko");
  assert.deepEqual(storage.setCalls, [[LANGUAGE_STORAGE_KEY, "ko"]]);

  assert.equal(runtime.setLocale("en-US"), true);
  assert.equal(runtime.currentLocale(), "en");
  assert.equal(runtime.setLocale("zh-CN"), false);
  assert.equal(runtime.currentLocale(), "en");

  const failingRead = runtimeFor(["ko-KR"], new FakeStorage({}, { failGet: true })).runtime;
  assert.equal(failingRead.init(), "ko");
  const failingWriteStorage = new FakeStorage({}, { failSet: true });
  const failingWrite = runtimeFor(["en-US"], failingWriteStorage).runtime;
  failingWrite.init();
  assert.equal(failingWrite.setLocale("ko"), true);
  assert.equal(failingWrite.currentLocale(), "ko");
});

test("fallback and placeholder substitution never treat labels as user content", () => {
  const { runtime } = runtimeFor(["ko-KR"]);
  runtime.init();
  assert.equal(runtime.t("missing.key"), "missing.key");
  assert.equal(runtime.t("activity.summary", { count: 3 }), "작업 활동 · 항목 3개");
  assert.equal(runtime.t("usage.remaining", { percent: 0 }), "0% 남음");
  assert.equal(runtime.t("auth.instructions", { url: "https://example.test", code: "ABC" }).includes("https://example.test"), true);
  assert.equal(runtime.t("auth.instructions", { url: "https://example.test", code: "ABC" }).includes("ABC"), true);
  assert.equal(runtime.t("activity.summary"), "작업 활동 · 항목 개");
  runtime.setLocale("en");
  assert.equal(runtime.t("activity.summary", { count: 2 }), "Work activity · 2 items");
});

test("tracked English and Korean resources keep key, placeholder, privacy and bounds invariants", () => {
  const enKeys = Object.keys(en);
  const koKeys = Object.keys(ko);

  assert.ok(enKeys.length >= 400, `expected at least 400 base keys, saw ${enKeys.length}`);
  assert.deepEqual([...koKeys].sort(), [...enKeys].sort());
  for (const key of enKeys) {
    assert.equal(typeof en[key], "string", key);
    assert.ok(en[key].trim().length > 0, key);
    assert.equal(typeof ko[key], "string", key);
    assert.ok(ko[key].trim().length > 0, key);
    assert.deepEqual(placeholders(ko[key]), placeholders(en[key]), key);
  }
  assert.equal(HAN.test(JSON.stringify(en)), false);
  assert.equal(HAN.test(JSON.stringify(ko)), false);
  assert.equal(HAN.test(JSON.stringify(koKeys)), false);

  const criticalKeys = [
    "activity.summary",
    "apps.companionInvalid",
    "auth.instructions",
    "composer.placeholder",
    "composer.send",
    "draft.privacy",
    "files.loadedBody",
    "files.previousPage",
    "files.title",
    "permission.fullAccessConfirm",
    "question.freeText",
    "role.user",
    "usage.remaining",
  ];
  for (const key of criticalKeys) assert.ok(enKeys.includes(key), key);

  assert.equal(en["files.previousPage"], "Previous page");
  assert.equal(ko["files.previousPage"], "이전 페이지");
  assert.ok(en["draft.privacy"].includes("64 KiB"));
  assert.ok(ko["draft.privacy"].includes("64 KiB"));
  assert.ok(en["apps.companionInvalid"].includes("HTTPS"));
  assert.ok(en["apps.companionInvalid"].includes("credentials"));
  assert.ok(ko["apps.companionInvalid"].includes("HTTPS"));
  assert.ok(ko["permission.fullAccessConfirm"].includes("전체 접근"));
});

test("static translation and registered bindings change labels only", () => {
  const { document, runtime } = runtimeFor(["ko-KR"]);
  const label = new FakeElement("span", { dataset: { i18n: "composer.send" } });
  const userMarkdown = new FakeElement("div", { classes: ["markdown-body"] });
  const userLabel = new FakeElement("span", { dataset: { i18n: "role.user" }, textContent: "Original user markdown" });
  const fileContent = new FakeElement("div", { classes: ["file-content"] });
  const fileLabel = new FakeElement("span", { dataset: { i18n: "files.title" }, textContent: "Original file bytes" });
  const pre = new FakeElement("pre", { dataset: { i18n: "files.loadedBody" }, textContent: "const original = true;" });
  const editor = new FakeElement("div", { attributes: { contenteditable: "true" } });
  const editorLabel = new FakeElement("span", { dataset: { i18n: "composer.placeholder" }, textContent: "user editor text" });
  const nativeAnswer = new FakeElement("textarea", { value: "native answer text", dataset: { i18nPlaceholder: "question.freeText" } });
  nativeAnswer.selectionStart = 2; nativeAnswer.selectionEnd = 5;
  const composer = new FakeElement("textarea", { value: "unsent draft", dataset: { i18nPlaceholder: "composer.placeholder" } });
  composer.selectionStart = 1; composer.selectionEnd = 4;
  userMarkdown.append(userLabel);
  fileContent.append(fileLabel);
  editor.append(editorLabel);
  document.body.append(label, userMarkdown, fileContent, pre, editor, nativeAnswer, composer);

  assert.equal(runtime.init(), "ko");
  assert.equal(label.textContent, "보내기");
  assert.equal(userLabel.textContent, "Original user markdown");
  assert.equal(fileLabel.textContent, "Original file bytes");
  assert.equal(pre.textContent, "const original = true;");
  assert.equal(editorLabel.textContent, "user editor text");
  assert.equal(composer.getAttribute("placeholder"), "Codex에 메시지 보내기");
  assert.equal(nativeAnswer.getAttribute("placeholder"), "위에서 옵션을 선택하거나 답변을 입력하세요…");
  assert.equal(composer.value, "unsent draft");
  assert.deepEqual([composer.selectionStart, composer.selectionEnd], [1, 4]);
  assert.equal(nativeAnswer.value, "native answer text");
  assert.deepEqual([nativeAnswer.selectionStart, nativeAnswer.selectionEnd], [2, 5]);

  const registered = new FakeElement("span");
  assert.equal(runtime.bindText(registered, "activity.summary", { count: 4 }), registered);
  assert.equal(runtime.setLocale("en"), true);
  assert.equal(label.textContent, "Send");
  assert.equal(registered.textContent, "Work activity · 4 items");
  assert.equal(composer.getAttribute("placeholder"), "Message Codex");
  assert.equal(composer.value, "unsent draft");
  assert.deepEqual([composer.selectionStart, composer.selectionEnd], [1, 4]);

  assert.throws(() => runtime.bindAttribute(registered, "value", "composer.send"));
  assert.equal(runtime.bindAttribute(registered, "title", "files.title"), registered);
  assert.equal(registered.getAttribute("title"), "Files");
});

test("HTMLCollection-like descendants protect nested native answer value, selection and DOM", () => {
  const { document, runtime } = runtimeFor(["ko-KR"]);
  const container = new FakeElement("div", { dataset: { i18n: "files.title" } });
  const answer = new FakeElement("textarea", { value: "native answer", dataset: { i18nPlaceholder: "question.freeText" } });
  answer.selectionStart = 3;
  answer.selectionEnd = 7;
  container.append(answer);
  container.children = new FakeCollection(container.children);
  document.body.append(container);

  assert.equal(runtime.init(), "ko");
  assert.equal(container.textContent, "");
  assert.equal(container.children.length, 1);
  assert.equal(container.children.item(0), answer);
  assert.equal(container.children[Symbol.iterator]().next().value, answer);
  assert.equal(answer.value, "native answer");
  assert.deepEqual([answer.selectionStart, answer.selectionEnd], [3, 7]);
  assert.equal(answer.getAttribute("placeholder"), "위에서 옵션을 선택하거나 답변을 입력하세요…");

  assert.equal(runtime.setLocale("en"), true);
  assert.equal(container.textContent, "");
  assert.equal(container.children.item(0), answer);
  assert.equal(answer.value, "native answer");
  assert.deepEqual([answer.selectionStart, answer.selectionEnd], [3, 7]);
  assert.equal(answer.getAttribute("placeholder"), "Choose an option above or type an answer…");
});

test("explicit bindText rejects user text targets but accepts leaf UI labels inside message ancestors", () => {
  const { runtime } = runtimeFor(["ko-KR"]);
  runtime.init();

  const answer = new FakeElement("textarea", { textContent: "native answer", value: "native answer" });
  answer.selectionStart = 1;
  answer.selectionEnd = 6;
  runtime.bindText(answer, "composer.send");
  assert.equal(answer.textContent, "native answer");
  assert.equal(answer.value, "native answer");
  assert.deepEqual([answer.selectionStart, answer.selectionEnd], [1, 6]);

  const editable = new FakeElement("div", { attributes: { contenteditable: "true" }, textContent: "user editor body" });
  runtime.bindText(editable, "files.title");
  assert.equal(editable.textContent, "user editor body");

  const userContainer = new FakeElement("div", { classes: ["message-content"], textContent: "user answer body" });
  runtime.bindText(userContainer, "files.title");
  assert.equal(userContainer.textContent, "user answer body");

  const wrapper = new FakeElement("div");
  const nestedAnswer = new FakeElement("textarea", { value: "nested native answer" });
  nestedAnswer.selectionStart = 2;
  nestedAnswer.selectionEnd = 8;
  wrapper.append(nestedAnswer);
  runtime.bindText(wrapper, "files.title");
  assert.equal(wrapper.textContent, "");
  assert.equal(nestedAnswer.value, "nested native answer");
  assert.deepEqual([nestedAnswer.selectionStart, nestedAnswer.selectionEnd], [2, 8]);

  const message = new FakeElement("div", { classes: ["message"] });
  const leafButton = new FakeElement("button");
  message.append(leafButton);
  assert.equal(runtime.bindText(leafButton, "composer.send"), leafButton);
  assert.equal(leafButton.textContent, "보내기");
  assert.equal(runtime.setLocale("en"), true);
  assert.equal(leafButton.textContent, "Send");
});

test("unbindI18n deterministically stops refreshing a widget label", () => {
  const { runtime } = runtimeFor(["en-US"]);
  runtime.init();
  const label = new FakeElement("span");
  assert.equal(runtime.bindText(label, "composer.send"), label);
  assert.equal(label.textContent, "Send");

  assert.equal(runtime.unbindI18n(label), true);
  assert.equal(runtime.unbindI18n(label), false);
  assert.equal(runtime.setLocale("ko"), true);
  assert.equal(label.textContent, "Send");

  assert.equal(runtime.bindText(label, "files.title"), label);
  assert.equal(label.textContent, "파일");
  assert.equal(runtime.setLocale("en"), true);
  assert.equal(label.textContent, "Files");
});

test("registerMessages adds per-runtime bilingual labels to t and registered bindings", () => {
  const first = runtimeFor(["en-US"]).runtime;
  const second = runtimeFor(["en-US"]).runtime;
  first.init();
  second.init();

  const label = new FakeElement("span");
  first.bindText(label, "widgets.nativeQueue", { count: 3 });
  assert.equal(label.textContent, "widgets.nativeQueue");

  assert.equal(first.registerMessages({
    en: {
      "widgets.nativeQueue": "Native queue · {count} ready",
      "widgets.fileFilter": "Filter rendered files",
    },
    ko: {
      "widgets.nativeQueue": "네이티브 대기열 · {count}개 준비",
      "widgets.fileFilter": "렌더링된 파일 필터",
    },
  }), 2);

  assert.equal(first.t("widgets.nativeQueue", { count: 3 }), "Native queue · 3 ready");
  assert.equal(first.t("widgets.fileFilter"), "Filter rendered files");
  assert.equal(label.textContent, "Native queue · 3 ready");
  assert.equal(second.t("widgets.nativeQueue"), "widgets.nativeQueue");
  assert.equal(second.t("widgets.fileFilter"), "widgets.fileFilter");
  assert.equal(Object.prototype.hasOwnProperty.call(en, "widgets.nativeQueue"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(ko, "widgets.nativeQueue"), false);

  assert.equal(first.setLocale("ko"), true);
  assert.equal(label.textContent, "네이티브 대기열 · 3개 준비");
  assert.equal(first.t("widgets.fileFilter"), "렌더링된 파일 필터");
  assert.equal(second.t("widgets.nativeQueue"), "widgets.nativeQueue");

  const invalidBundles = [
    { en: { "widgets.invalid": "English only" } },
    { en: { "widgets.invalid": "English" }, ko: {} },
    { en: { "widgets.invalid": 5 }, ko: { "widgets.invalid": "한국어" } },
    { en: { "widgets.invalid": "English" }, ko: { "widgets.invalid": "" } },
    { en: { "widgets.invalid": "Hi {name}" }, ko: { "widgets.invalid": "안녕 {other}" } },
    { en: {}, ko: { "widgets.invalid": "한국어" } },
    { en: { "composer.send": "Override" }, ko: { "composer.send": "덮어쓰기" } },
    { en: { "widgets.invalid": "English" }, ko: null },
  ];
  for (const bundle of invalidBundles) {
    assert.throws(() => first.registerMessages(bundle), TypeError);
  }
  assert.equal(first.t("widgets.invalid"), "widgets.invalid");

  const unsafeEn = Object.create(null);
  const unsafeKo = Object.create(null);
  unsafeEn.__proto__ = "unsafe";
  unsafeKo.__proto__ = "안전하지 않음";
  assert.throws(() => first.registerMessages({ en: unsafeEn, ko: unsafeKo }), TypeError);
  assert.equal(first.t("__proto__"), "__proto__");
});

test("locale subscriptions notify once per successful change and can unsubscribe", () => {
  const { runtime } = runtimeFor(["en-US"]);
  runtime.init();
  const seen = [];
  const unsubscribe = runtime.subscribeLocale(locale => seen.push(locale));
  assert.equal(runtime.setLocale("ko"), true);
  assert.equal(runtime.setLocale("ko"), true);
  assert.deepEqual(seen, ["ko", "ko"]);
  assert.equal(typeof unsubscribe, "function");
  unsubscribe();
  runtime.setLocale("en");
  assert.deepEqual(seen, ["ko", "ko"]);
  assert.equal(runtime.setLocale("zh"), false);
  assert.deepEqual(seen, ["ko", "ko"]);
});

test("module facade keeps the named compatibility interface wired to the default runtime", () => {
  for (const fn of [
    initI18n,
    t,
    currentLocale,
    translateDocument,
    setLocale,
    subscribeLocale,
    bindText,
    bindAttribute,
    unbindI18n,
    registerMessages,
  ]) {
    assert.equal(typeof fn, "function");
  }
  assert.deepEqual(supportedLanguages, ["en", "ko"]);
});
