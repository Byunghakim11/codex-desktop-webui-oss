// Accessible context menu rendered as a body portal.
// Only the caller decides which targets are actionable: this module never
// installs a global contextmenu listener and never calls preventDefault on
// Shift+right-click, so text inputs, editors and native answer fields keep the
// browser menu.
const MENU_CLASS = "ui-context-menu";
const ITEM_CLASS = "ui-context-menu-item";
const SEPARATOR_CLASS = "ui-context-menu-separator";
const DEFAULT_WIDTH = 224;
const DEFAULT_ITEM_HEIGHT = 34;
const EDGE_MARGIN = 8;
const VIEWPORT_FALLBACK = { width: 1024, height: 768 };

export function clampMenuPosition({
  x = 0,
  y = 0,
  width = DEFAULT_WIDTH,
  height = DEFAULT_ITEM_HEIGHT,
  viewportWidth = VIEWPORT_FALLBACK.width,
  viewportHeight = VIEWPORT_FALLBACK.height,
  margin = EDGE_MARGIN
} = {}) {
  const safeWidth = Number.isFinite(viewportWidth) && viewportWidth > 0 ? viewportWidth : VIEWPORT_FALLBACK.width;
  const safeHeight = Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : VIEWPORT_FALLBACK.height;
  const maxWidth = Math.max(0, safeWidth - margin * 2);
  const maxHeight = Math.max(0, safeHeight - margin * 2);
  const boxWidth = Math.min(Number(width) > 0 ? Number(width) : DEFAULT_WIDTH, maxWidth || DEFAULT_WIDTH);
  const boxHeight = Math.min(Number(height) > 0 ? Number(height) : DEFAULT_ITEM_HEIGHT, maxHeight || DEFAULT_ITEM_HEIGHT);
  const left = Math.min(Math.max(margin, Number(x) || 0), Math.max(margin, safeWidth - margin - boxWidth));
  const top = Math.min(Math.max(margin, Number(y) || 0), Math.max(margin, safeHeight - margin - boxHeight));
  return {
    left,
    top,
    maxWidth: maxWidth || safeWidth,
    maxHeight: Math.max(margin, safeHeight - top - margin)
  };
}

// A separator is never leading, trailing or doubled; unusable entries are dropped.
export function normalizeMenuItems(items) {
  const list = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== "object") continue;
    if (item.type === "separator") {
      if (list.length > 0 && list[list.length - 1].type !== "separator") list.push({ type: "separator" });
      continue;
    }
    if (item.id === undefined || item.id === null) continue;
    if (typeof item.label !== "string" && typeof item.label !== "function") continue;
    if (typeof item.run !== "function") continue;
    list.push({ ...item, id: String(item.id) });
  }
  while (list.length > 0 && list[list.length - 1].type === "separator") list.pop();
  return list;
}

function isDisabled(item) {
  if (!item) return true;
  if (typeof item.disabled === "function") {
    try {
      return Boolean(item.disabled());
    } catch {
      return true;
    }
  }
  return Boolean(item.disabled);
}

function flatChildren(element) {
  return element?.children ?? element?.childNodes ?? [];
}

export function createContextMenu(options = {}) {
  const doc = options.document ?? globalThis.document;
  if (!doc || typeof doc.createElement !== "function") throw new TypeError("createContextMenu requires a document");
  const win = options.window ?? doc.defaultView ?? globalThis.window ?? null;
  const t = options.t;
  const onError = options.onError;
  const menu = doc.createElement("div");
  menu.className = MENU_CLASS;
  menu.setAttribute("role", "menu");
  menu.setAttribute("data-ui-context-menu", "");
  menu.hidden = true;

  let opened = false;
  let disposed = false;
  let entries = [];
  let activeIndex = -1;
  let lastFocus = null;
  let anchorNode = null;
  let lastPoint = null;
  let labelText = "";

  function report(error) {
    if (typeof onError === "function") {
      try {
        onError(error);
      } catch {
        // A failing error reporter must not break menu state.
      }
    }
  }

  function translate(key, fallback) {
    if (typeof t !== "function") return fallback;
    const value = t(key);
    return typeof value === "string" && value && value !== key ? value : fallback;
  }

  function mount() {
    if (menu.parentNode === doc.body) return;
    doc.body.append(menu);
  }

  function viewport() {
    if (typeof options.viewport === "function") {
      const size = options.viewport() || {};
      return {
        width: Number(size.width) || VIEWPORT_FALLBACK.width,
        height: Number(size.height) || VIEWPORT_FALLBACK.height
      };
    }
    return {
      width: Number(win?.innerWidth) || VIEWPORT_FALLBACK.width,
      height: Number(win?.innerHeight) || VIEWPORT_FALLBACK.height
    };
  }

  function position() {
    const size = viewport();
    const rect = typeof menu.getBoundingClientRect === "function" ? menu.getBoundingClientRect() : null;
    const width = Number(rect?.width) || DEFAULT_WIDTH;
    const measured = Number(rect?.height) || 0;
    const height = measured || entries.length * DEFAULT_ITEM_HEIGHT + EDGE_MARGIN;
    let x = lastPoint?.x;
    let y = lastPoint?.y;
    if ((!Number.isFinite(x) || !Number.isFinite(y)) && anchorNode && typeof anchorNode.getBoundingClientRect === "function") {
      const anchorRect = anchorNode.getBoundingClientRect();
      x = Number(anchorRect?.left) || 0;
      y = Number(anchorRect?.bottom) || Number(anchorRect?.top) || 0;
    }
    const clamped = clampMenuPosition({
      x: Number.isFinite(x) ? x : 0,
      y: Number.isFinite(y) ? y : 0,
      width,
      height,
      viewportWidth: size.width,
      viewportHeight: size.height
    });
    if (menu.style && typeof menu.style === "object") {
      menu.style.left = `${clamped.left}px`;
      menu.style.top = `${clamped.top}px`;
      menu.style.maxHeight = `${clamped.maxHeight}px`;
      menu.style.maxWidth = `${clamped.maxWidth}px`;
    }
    menu.setAttribute("data-menu-left", String(clamped.left));
    menu.setAttribute("data-menu-top", String(clamped.top));
    return clamped;
  }

  function reposition() {
    if (!opened) return;
    if (anchorNode && anchorNode.isConnected === false) {
      close({ restoreFocus: false });
      return;
    }
    position();
  }

  function enabledEntries() {
    return entries.filter((entry) => !entry.button.disabled);
  }

  function focusIndex(index) {
    const entry = entries[index];
    if (!entry || entry.button.disabled) return false;
    activeIndex = index;
    for (const candidate of entries) {
      candidate.button.setAttribute("tabindex", candidate.index === index ? "0" : "-1");
    }
    try {
      entry.button.focus({ preventScroll: true });
    } catch {
      try {
        entry.button.focus();
      } catch {
        // Focus is best-effort in restricted environments.
      }
    }
    return true;
  }

  function setActive(index) {
    if (!entries.length) return false;
    const bounded = Math.max(0, Math.min(entries.length - 1, index));
    if (focusIndex(bounded)) return true;
    for (let candidate = bounded; candidate < entries.length; candidate += 1) {
      if (focusIndex(candidate)) return true;
    }
    for (let candidate = bounded; candidate >= 0; candidate -= 1) {
      if (focusIndex(candidate)) return true;
    }
    return false;
  }

  function moveActive(step) {
    const total = entries.length;
    if (!total) return false;
    const start = activeIndex < 0 ? 0 : activeIndex;
    for (let offset = 1; offset <= total; offset += 1) {
      const index = (((start + step * offset) % total) + total) % total;
      if (focusIndex(index)) return true;
    }
    return false;
  }

  function activate(entry) {
    if (!opened || !entry || disposed) return false;
    // Availability is re-evaluated immediately before execution: a menu that
    // stayed open across a thread/auth change must not fire a stale action.
    if (isDisabled(entry.item)) {
      setActive(entry.index);
      return false;
    }
    const item = entry.item;
    close({ restoreFocus: true });
    try {
      const result = item.run();
      if (result && typeof result.catch === "function") result.catch((error) => report(error));
    } catch (error) {
      report(error);
    }
    return true;
  }

  function onClick(event) {
    const target = event?.currentTarget ?? event?.target ?? null;
    const entry = entries.find((candidate) => candidate.button === target);
    if (entry) {
      event?.preventDefault?.();
      activate(entry);
    }
  }

  function onKeyDown(event) {
    if (!opened || disposed) return;
    const key = event?.key;
    if (key === "Escape" || key === "Esc") {
      event.preventDefault?.();
      event.stopPropagation?.();
      close({ restoreFocus: true });
      return;
    }
    if (key === "Tab") {
      close({ restoreFocus: false });
      return;
    }
    if (key === "ArrowDown" || key === "Down") {
      event.preventDefault?.();
      moveActive(1);
      return;
    }
    if (key === "ArrowUp" || key === "Up") {
      event.preventDefault?.();
      moveActive(-1);
      return;
    }
    if (key === "Home") {
      event.preventDefault?.();
      setActive(0);
      return;
    }
    if (key === "End") {
      event.preventDefault?.();
      setActive(entries.length - 1);
      return;
    }
    if (key === "Enter" || key === " " || key === "Spacebar") {
      const entry = entries[activeIndex];
      if (entry) {
        event.preventDefault?.();
        activate(entry);
      }
    }
  }

  function onPointerDown(event) {
    if (!opened) return;
    const target = event?.target ?? null;
    if (target && contains(target)) return;
    close({ restoreFocus: false });
  }

  function addWindowListeners() {
    win?.addEventListener?.("resize", reposition);
    win?.addEventListener?.("scroll", reposition, true);
  }

  function removeWindowListeners() {
    win?.removeEventListener?.("resize", reposition);
    win?.removeEventListener?.("scroll", reposition, true);
  }

  function render(items, menuLabel) {
    if (typeof menu.replaceChildren === "function") menu.replaceChildren();
    else for (const child of [...flatChildren(menu)]) child.remove?.();
    entries = [];
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", String(menuLabel || translate("ui.context.menuLabel", "Actions")));
    let firstEnabled = true;
    for (const item of items) {
      if (item.type === "separator") {
        const separator = doc.createElement("div");
        separator.className = SEPARATOR_CLASS;
        separator.setAttribute("role", "separator");
        menu.append(separator);
        continue;
      }
      const button = doc.createElement("button");
      button.type = "button";
      button.className = ITEM_CLASS;
      button.setAttribute("role", "menuitem");
      let text = item.label;
      if (typeof text === "function") {
        try {
          text = text();
        } catch {
          text = "";
        }
      }
      button.textContent = String(text ?? "");
      const disabled = isDisabled(item);
      button.disabled = disabled;
      button.setAttribute("aria-disabled", String(disabled));
      if (disabled && typeof item.disabledReason === "string") button.setAttribute("title", item.disabledReason);
      const tabbable = !disabled && firstEnabled;
      if (tabbable) firstEnabled = false;
      button.setAttribute("tabindex", tabbable ? "0" : "-1");
      button.addEventListener("click", onClick);
      button.addEventListener("keydown", onKeyDown);
      entries.push({ item, button, index: entries.length });
      menu.append(button);
    }
    activeIndex = entries.findIndex((entry) => !entry.button.disabled);
  }

  function close({ restoreFocus = true } = {}) {
    if (!opened) return false;
    opened = false;
    menu.hidden = true;
    if (typeof menu.replaceChildren === "function") menu.replaceChildren();
    entries = [];
    activeIndex = -1;
    doc.removeEventListener?.("pointerdown", onPointerDown, true);
    removeWindowListeners();
    const focusTarget = lastFocus;
    const shouldRestore = restoreFocus && focusTarget && typeof focusTarget.focus === "function";
    lastFocus = null;
    anchorNode = null;
    lastPoint = null;
    if (shouldRestore) {
      try {
        focusTarget.focus({ preventScroll: true });
      } catch {
        try {
          focusTarget.focus();
        } catch {
          // Ignore disconnected focus targets.
        }
      }
    }
    return true;
  }

  function show({ event, anchor, items, menuLabel, point } = {}) {
    if (disposed) return false;
    // Shift+right-click keeps the browser's native menu and its own handling.
    if (event && event.shiftKey) return false;
    const normalized = normalizeMenuItems(items);
    if (!normalized.length) return false;
    if (opened) close({ restoreFocus: false });
    mount();
    lastFocus = doc.activeElement ?? null;
    anchorNode = anchor ?? null;
    lastPoint = point && Number.isFinite(point.x) && Number.isFinite(point.y)
      ? { x: point.x, y: point.y }
      : event && Number.isFinite(event.clientX) && Number.isFinite(event.clientY)
        ? { x: event.clientX, y: event.clientY }
        : null;
    labelText = menuLabel || "";
    render(normalized, labelText);
    menu.hidden = false;
    opened = true;
    position();
    doc.addEventListener?.("pointerdown", onPointerDown, true);
    addWindowListeners();
    event?.preventDefault?.();
    event?.stopPropagation?.();
    setActive(activeIndex);
    return true;
  }

  function contains(node) {
    if (!opened || !node) return false;
    if (menu === node) return true;
    if (typeof menu.contains === "function") return Boolean(menu.contains(node));
    let current = node;
    while (current) {
      if (current === menu) return true;
      current = current.parentNode ?? null;
    }
    return false;
  }

  function dispose() {
    if (disposed) return;
    close({ restoreFocus: false });
    disposed = true;
    if (typeof menu.remove === "function") menu.remove();
    else if (menu.parentNode?.removeChild) menu.parentNode.removeChild(menu);
  }

  return {
    show,
    close,
    isOpen: () => opened,
    contains,
    dispose,
    element: menu
  };
}
