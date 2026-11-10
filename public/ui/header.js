// Compact header helpers. These are deliberately small, DOM-light utilities so
// app.js keeps ownership of the real controllers and handlers: the header only
// hosts, relabels and re-states existing controls.
export const HEADER_SLOT_IDS = Object.freeze({
  search: "headerSearchSlot",
  bookmarks: "headerBookmarksSlot",
  more: "workflowMenuBody"
});

// Order in which the compact header exposes controls. Files/connection keep
// their existing ids and callbacks; only the visual row moves.
export const HEADER_ACTION_ORDER = Object.freeze(["search", "bookmarks", "more", "files", "activity", "connection", "fullscreen"]);

export const LANGUAGE_OPTIONS = Object.freeze([
  Object.freeze({ value: "en", labelKey: "ui.language.english" }),
  Object.freeze({ value: "ko", labelKey: "ui.language.korean" })
]);

const MAX_COMPACT_TITLE = 120;

function label(t, key, fallback, params) {
  if (typeof t !== "function") return fallback;
  const value = t(key, params);
  return typeof value === "string" && value && value !== key ? value : fallback;
}

export function compactTitle(value, limit = MAX_COMPACT_TITLE) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  const max = Number.isFinite(limit) && limit > 8 ? Math.floor(limit) : MAX_COMPACT_TITLE;
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

// A meaningful connected-state label. The visible "Desktop owns it"
// implementation wording is replaced by a user-facing connection statement
// while the control keeps its disabled ownership semantics.
export function connectionLabel({ connected = false, reconnecting = false, desktopConnected = false, t } = {}) {
  const connectionTitle = label(t, "ui.header.connection", "Connection");
  if (reconnecting) {
    return { state: "reconnecting", text: label(t, "ui.header.reconnecting", "Reconnecting…"), title: connectionTitle };
  }
  if (connected && desktopConnected) {
    return { state: "connected", text: label(t, "ui.header.connected", "Connected to Codex Desktop"), title: connectionTitle };
  }
  if (connected) {
    return { state: "app", text: label(t, "ui.header.connectedApp", "Connected to the app"), title: connectionTitle };
  }
  return { state: "offline", text: label(t, "ui.header.desktopOffline", "Desktop app offline"), title: connectionTitle };
}

export function projectBreadcrumbText({ project, fallback, t } = {}) {
  const name = String(project ?? "").trim();
  if (!name) return fallback ?? label(t, "ui.header.noProject", "No project");
  return label(t, "ui.header.project", `Project: ${name}`, { project: name });
}

export function projectNewThreadLabel({ project, t } = {}) {
  const name = String(project ?? "").trim();
  if (!name) return label(t, "ui.project.newThreadPlain", "New conversation in this project");
  return label(t, "ui.project.newThread", `New conversation in ${name}`, { project: name });
}

// Moves an existing, already-wired control into a header slot. Moving keeps the
// original click handlers (no duplicated callbacks) and only relabels the
// accessible name.
export function mountHeaderControl({ slot, node, labelText, titleText } = {}) {
  if (!slot || !node || typeof slot.append !== "function") return false;
  if (labelText) {
    node.setAttribute?.("aria-label", String(labelText));
    node.title = String(titleText || labelText);
  } else if (titleText) {
    node.title = String(titleText);
  }
  slot.append(node);
  return true;
}

// Language selector next to the theme/sidebar controls. Changing language is a
// label-only refresh: the callback decides what to relabel, never reload.
export function createLanguageSelector({ document: doc = globalThis.document, select, t, current = "en", onChange } = {}) {
  if (!doc || typeof doc.createElement !== "function" || !select) throw new TypeError("createLanguageSelector needs a document and a select");
  let disposed = false;

  function render(locale = current) {
    if (disposed || !select) return [];
    const values = [];
    if (typeof select.replaceChildren === "function") select.replaceChildren();
    for (const option of LANGUAGE_OPTIONS) {
      const node = doc.createElement("option");
      node.value = option.value;
      node.textContent = label(t, option.labelKey, option.value === "ko" ? "한국어" : "English");
      select.append(node);
      values.push(option.value);
    }
    select.value = LANGUAGE_OPTIONS.some((option) => option.value === locale) ? locale : "en";
    select.setAttribute("aria-label", label(t, "ui.language.label", "Language"));
    select.title = label(t, "ui.language.label", "Language");
    return values;
  }

  function onSelectChange() {
    if (disposed || typeof onChange !== "function") return;
    onChange(String(select.value || ""));
  }

  select.addEventListener?.("change", onSelectChange);
  render(current);

  return {
    render,
    current: () => select.value,
    dispose() {
      if (disposed) return;
      disposed = true;
      select.removeEventListener?.("change", onSelectChange);
    }
  };
}
