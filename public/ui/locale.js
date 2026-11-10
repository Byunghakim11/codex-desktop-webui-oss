// Bilingual UI locale facade. Labels only: never user content, form values or selection.
import en from "../i18n/en.js";
import ko from "../i18n/ko.js";

export const supportedLanguages = Object.freeze(["en", "ko"]);
export const supportedLanguage = supportedLanguages;
export const LANGUAGE_STORAGE_KEY = "codex-webui.language";

const ATTRIBUTE_NAMES = new Set(["title", "aria-label", "placeholder"]);
const DANGEROUS_LABEL_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const USER_CONTENT_CLASSES = new Set([
  "markdown-body",
  "user-message",
  "message-content",
  "user-content",
  "file-content",
  "file-body",
  "attachment",
  "native-answer",
  "markdown",
  "bubble",
  "message",
  "message-stream",
  "editor",
  "editor-content",
  "code-editor",
  "cm-editor",
  "monaco-editor",
  "xterm",
  "prose",
]);
const USER_CONTENT_TAGS = new Set(["PRE", "CODE", "SCRIPT", "STYLE", "TEXTAREA", "INPUT"]);
const STRUCTURAL_CONTENT_TAGS = new Set(["PRE", "CODE", "SCRIPT", "STYLE"]);
const PLACEHOLDER_PATTERN = /\{([A-Za-z0-9_]+)\}/g;

export function normalizeLocale(value) {
  if (typeof value !== "string") return null;
  const primary = value.trim().toLowerCase().split(/[-_]/)[0];
  return primary === "en" || primary === "ko" ? primary : null;
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function isRecord(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function copyDictionary(source) {
  const copy = Object.create(null);
  if (!isRecord(source)) return copy;
  for (const key of Object.keys(source)) {
    if (typeof source[key] === "string") copy[key] = source[key];
  }
  return copy;
}

function placeholderNames(value) {
  return [...String(value).matchAll(PLACEHOLDER_PATTERN)].map(match => match[1]).sort();
}

function validateMessageBundle(messages, resources) {
  if (!isRecord(messages) || !hasOwn(messages, "en") || !hasOwn(messages, "ko")) {
    throw new TypeError("registerMessages expects { en: {...}, ko: {...} }");
  }
  const enMessages = messages.en;
  const koMessages = messages.ko;
  if (!isRecord(enMessages) || !isRecord(koMessages)) {
    throw new TypeError("registerMessages language entries must be label objects");
  }
  const enKeys = Object.keys(enMessages);
  const koKeys = Object.keys(koMessages);
  if (enKeys.length !== koKeys.length) {
    throw new TypeError("English and Korean registered label keys must match");
  }
  const koKeySet = new Set(koKeys);
  for (const key of enKeys) {
    if (typeof key !== "string" || key.length === 0) {
      throw new TypeError("Registered label keys must be non-empty strings");
    }
    if (DANGEROUS_LABEL_KEYS.has(key)) {
      throw new TypeError(`Unsafe registered label key: ${key}`);
    }
    if (!koKeySet.has(key)) {
      throw new TypeError(`Missing Korean registered label: ${key}`);
    }
    if (hasOwn(resources.en, key) || hasOwn(resources.ko, key)) {
      throw new TypeError(`Registered label key already exists: ${key}`);
    }
    const enValue = enMessages[key];
    const koValue = koMessages[key];
    if (typeof enValue !== "string" || enValue.trim().length === 0) {
      throw new TypeError(`Registered English label must be a non-empty string: ${key}`);
    }
    if (typeof koValue !== "string" || koValue.trim().length === 0) {
      throw new TypeError(`Registered Korean label must be a non-empty string: ${key}`);
    }
    if (placeholderNames(enValue).join(",") !== placeholderNames(koValue).join(",")) {
      throw new TypeError(`Registered label placeholders must match: ${key}`);
    }
  }
  return enKeys;
}

function attributeValue(element, name) {
  if (!element) return null;
  if (typeof element.getAttribute === "function") return element.getAttribute(name);
  const attributes = element.attributes;
  if (!attributes) return null;
  if (typeof attributes.get === "function") return attributes.get(name) ?? null;
  return hasOwn(attributes, name) ? attributes[name] : null;
}

function hasClass(element, name) {
  if (typeof element?.classList?.contains === "function" && element.classList.contains(name)) return true;
  const className = typeof element?.className === "string" ? element.className : "";
  return className.split(/\s+/).includes(name);
}

function hasUserContentMarker(element) {
  if (!element) return false;
  if (element.dataset?.userContent || element.dataset?.i18nSkip) return true;
  if (attributeValue(element, "data-user-content") != null) return true;
  if (attributeValue(element, "data-i18n-skip") != null) return true;
  if (attributeValue(element, "data-role") === "user") return true;
  for (const name of USER_CONTENT_CLASSES) {
    if (hasClass(element, name)) return true;
  }
  return false;
}

function isEditable(element) {
  if (element?.isContentEditable === true) return true;
  const editable = attributeValue(element, "contenteditable");
  return editable != null && String(editable).toLowerCase() !== "false";
}

function isTextContentNode(element) {
  if (!element) return true;
  const tag = String(element.tagName || "").toUpperCase();
  return USER_CONTENT_TAGS.has(tag) || isEditable(element) || hasUserContentMarker(element);
}

function isUserContentContainer(element) {
  if (!element) return false;
  const tag = String(element.tagName || "").toUpperCase();
  return STRUCTURAL_CONTENT_TAGS.has(tag) || isEditable(element) || hasUserContentMarker(element);
}

// Real DOM `children` is an HTMLCollection, not an Array. Support arrays,
// array-like collections (length/item) and generic iterables.
function childElements(element) {
  const children = element?.children;
  if (!children) return [];
  if (Array.isArray(children)) return [...children];
  if (typeof children !== "object") return [];
  const length = Number(children.length);
  if (Number.isFinite(length) && length > 0) {
    const result = [];
    for (let index = 0; index < length; index += 1) {
      const child = typeof children.item === "function" ? children.item(index) : children[index];
      if (child) result.push(child);
    }
    return result;
  }
  if (typeof children[Symbol.iterator] === "function") return [...children];
  return [];
}

function hasContentAncestor(element, predicate) {
  let node = element?.parentNode ?? null;
  while (node) {
    if (predicate(node)) return true;
    node = node.parentNode ?? null;
  }
  return false;
}

// Text labels are only safe on leaf UI nodes. Inputs, textareas, editable
// surfaces, user-content containers and wrappers around them must never have
// their body/value replaced by a label.
function isSafeTextBindingTarget(element) {
  if (!element || typeof element !== "object") return false;
  if (isTextContentNode(element)) return false;
  const stack = childElements(element);
  while (stack.length > 0) {
    const child = stack.pop();
    if (isTextContentNode(child)) return false;
    stack.push(...childElements(child));
  }
  return true;
}

function placeholderParams(value) {
  if (typeof value === "function") {
    try {
      const result = value();
      return result && typeof result === "object" ? result : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" ? value : {};
}

export function createLocaleRuntime(options = {}) {
  const documentRef = options.document ?? globalThis.document;
  const navigatorRef = options.navigator ?? globalThis.navigator;
  const storageRef = options.storage;
  // Per-runtime copies: registering labels never mutates the imported resources.
  const resources = { en: copyDictionary(en), ko: copyDictionary(ko) };
  const bindings = new WeakMap();
  const bindingRefs = new Set();
  const supportsWeakRef = typeof WeakRef === "function";
  const listeners = new Set();
  let activeLocale = "en";

  function trackBindingElement(element) {
    bindingRefs.add(supportsWeakRef ? new WeakRef(element) : element);
  }

  function liveBindingElements() {
    const elements = [];
    for (const ref of bindingRefs) {
      const element = supportsWeakRef ? ref.deref() : ref;
      if (!element || !bindings.has(element)) {
        bindingRefs.delete(ref);
        continue;
      }
      elements.push(element);
    }
    return elements;
  }

  function resolveStorage() {
    if (storageRef !== undefined) return storageRef;
    try {
      return globalThis.localStorage ?? null;
    } catch {
      return null;
    }
  }

  function readSavedLocale() {
    const storage = resolveStorage();
    if (!storage || typeof storage.getItem !== "function") return null;
    try {
      return normalizeLocale(storage.getItem(LANGUAGE_STORAGE_KEY));
    } catch {
      return null;
    }
  }

  function saveLocale(locale) {
    const storage = resolveStorage();
    if (!storage || typeof storage.setItem !== "function") return false;
    try {
      storage.setItem(LANGUAGE_STORAGE_KEY, locale);
      return true;
    } catch {
      return false;
    }
  }

  function browserLocale() {
    let languages = navigatorRef?.languages;
    if (!Array.isArray(languages) || languages.length === 0) {
      languages = [navigatorRef?.language];
    }
    const first = String(languages?.[0] ?? "").trim().toLowerCase();
    return first.startsWith("ko") ? "ko" : "en";
  }

  function resolveInitialLocale() {
    return readSavedLocale() ?? browserLocale();
  }

  function t(key, params = {}) {
    const dictionary = resources[activeLocale] ?? resources.en;
    const template = hasOwn(dictionary, key) ? dictionary[key] : hasOwn(resources.en, key) ? resources.en[key] : key;
    const values = params && typeof params === "object" ? params : {};
    return String(template).replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ""));
  }

  function currentLocale() {
    return activeLocale;
  }

  function hasContentDescendant(element) {
    const stack = childElements(element);
    while (stack.length > 0) {
      const child = stack.pop();
      if (isTextContentNode(child)) return true;
      stack.push(...childElements(child));
    }
    return false;
  }

  function isStaticTextEligible(element) {
    return !isTextContentNode(element)
      && !hasContentAncestor(element, isTextContentNode)
      && !hasContentDescendant(element);
  }

  function isStaticAttributeEligible(element) {
    return !isUserContentContainer(element) && !hasContentAncestor(element, isUserContentContainer);
  }

  function applyStatic(root, selector, apply) {
    if (!root || typeof root.querySelectorAll !== "function") return;
    let elements;
    try {
      elements = root.querySelectorAll(selector);
    } catch {
      return;
    }
    for (const element of elements ?? []) apply(element);
  }

  function translateDocument(root = documentRef) {
    applyStatic(root, "[data-i18n]", element => {
      if (!isStaticTextEligible(element)) return;
      const key = element.dataset?.i18n;
      if (typeof key === "string" && key) element.textContent = t(key);
    });
    applyStatic(root, "[data-i18n-placeholder]", element => {
      if (!isStaticAttributeEligible(element)) return;
      const key = element.dataset?.i18nPlaceholder;
      if (typeof key === "string" && key) element.setAttribute("placeholder", t(key));
    });
    applyStatic(root, "[data-i18n-title]", element => {
      if (!isStaticAttributeEligible(element)) return;
      const key = element.dataset?.i18nTitle;
      if (typeof key === "string" && key) element.setAttribute("title", t(key));
    });
    applyStatic(root, "[data-i18n-aria-label]", element => {
      if (!isStaticAttributeEligible(element)) return;
      const key = element.dataset?.i18nAriaLabel;
      if (typeof key === "string" && key) element.setAttribute("aria-label", t(key));
    });
  }

  function applyBinding(element, binding) {
    if (binding.type === "text" && !isSafeTextBindingTarget(element)) return;
    const text = t(binding.key, placeholderParams(binding.paramsOrFn));
    if (binding.type === "text") {
      if (element.textContent !== text) element.textContent = text;
    } else {
      element.setAttribute(binding.attribute, text);
    }
  }

  function registerBinding(element, binding) {
    if (!element || typeof element !== "object") return element;
    if (binding.type === "text" && !isSafeTextBindingTarget(element)) return element;
    let elementBindings = bindings.get(element);
    if (!elementBindings) {
      elementBindings = new Map();
      bindings.set(element, elementBindings);
      trackBindingElement(element);
    }
    const slot = binding.type === "text" ? "text" : `attribute:${binding.attribute}`;
    elementBindings.set(slot, binding);
    applyBinding(element, binding);
    return element;
  }

  function bindText(element, key, paramsOrFn) {
    return registerBinding(element, { type: "text", key, paramsOrFn });
  }

  function bindAttribute(element, attribute, key, paramsOrFn) {
    if (!ATTRIBUTE_NAMES.has(attribute)) {
      throw new TypeError(`Unsupported localized attribute: ${attribute}`);
    }
    return registerBinding(element, { type: "attribute", attribute, key, paramsOrFn });
  }

  function unbindI18n(element) {
    if (!element || typeof element !== "object") return false;
    if (!bindings.has(element)) return false;
    bindings.delete(element);
    for (const ref of bindingRefs) {
      const target = supportsWeakRef ? ref.deref() : ref;
      if (!target || target === element) bindingRefs.delete(ref);
    }
    return true;
  }

  function applyRegisteredBindings() {
    for (const element of liveBindingElements()) {
      const elementBindings = bindings.get(element);
      if (!elementBindings) continue;
      for (const binding of elementBindings.values()) {
        try {
          applyBinding(element, binding);
        } catch {
          // A disconnected or hostile node must not break the locale change.
        }
      }
    }
  }

  function registerMessages(messages) {
    const keys = validateMessageBundle(messages, resources);
    const enMessages = messages.en;
    const koMessages = messages.ko;
    for (const key of keys) {
      resources.en[key] = enMessages[key];
      resources.ko[key] = koMessages[key];
    }
    applyRegisteredBindings();
    return keys.length;
  }

  function applyDocumentLanguage() {
    try {
      documentRef?.documentElement?.setAttribute("lang", activeLocale);
    } catch {
      // Language metadata is best-effort; labels still update.
    }
  }

  function notify() {
    for (const callback of [...listeners]) {
      try {
        callback(activeLocale);
      } catch {
        // Subscribers are isolated from each other and from the locale state.
      }
    }
  }

  function init(root = documentRef) {
    activeLocale = resolveInitialLocale();
    applyDocumentLanguage();
    translateDocument(root);
    applyRegisteredBindings();
    return activeLocale;
  }

  function setLocale(locale) {
    const normalized = normalizeLocale(locale);
    if (!normalized) return false;
    activeLocale = normalized;
    saveLocale(normalized);
    applyDocumentLanguage();
    translateDocument(documentRef);
    applyRegisteredBindings();
    notify();
    return true;
  }

  function subscribeLocale(callback) {
    if (typeof callback !== "function") return () => {};
    listeners.add(callback);
    return () => listeners.delete(callback);
  }

  return {
    init,
    t,
    currentLocale,
    translateDocument,
    setLocale,
    subscribeLocale,
    bindText,
    bindAttribute,
    unbindI18n,
    registerMessages,
    resolveInitialLocale,
  };
}

let defaultRuntime = null;

function runtime() {
  if (!defaultRuntime) defaultRuntime = createLocaleRuntime();
  return defaultRuntime;
}

export function initI18n(root) {
  return runtime().init(root);
}

export function t(key, params) {
  return runtime().t(key, params);
}

export function currentLocale() {
  return runtime().currentLocale();
}

export function translateDocument(root) {
  return runtime().translateDocument(root);
}

export function setLocale(locale) {
  return runtime().setLocale(locale);
}

export function subscribeLocale(callback) {
  return runtime().subscribeLocale(callback);
}

export function bindText(element, key, paramsOrFn) {
  return runtime().bindText(element, key, paramsOrFn);
}

export function bindAttribute(element, attribute, key, paramsOrFn) {
  return runtime().bindAttribute(element, attribute, key, paramsOrFn);
}

export function unbindI18n(element) {
  return runtime().unbindI18n(element);
}

export function registerMessages(messages) {
  return runtime().registerMessages(messages);
}
