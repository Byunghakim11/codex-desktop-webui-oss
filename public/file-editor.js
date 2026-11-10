import { fileWriteMessages } from "./file-write-messages.js";

const MAX_EDIT_BYTES = 1024 * 1024;
const HEX32 = /^[0-9a-f]{32}$/;
const CONFLICT_REASON = /^(?!OPERATION_CONFLICT$).*?(?:conflict|file[_-]?changed|stale[_-]?version)/i;

export function utf8ByteLength(text) {
  let bytes = 0;
  for (const character of String(text)) {
    const code = character.codePointAt(0);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code < 0x10000) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

export function normalizeLf(text) {
  return String(text).replace(/\r\n?/g, "\n");
}

// Lone surrogates cannot be encoded as UTF-8, so they are rejected up front.
export function isWellFormedText(value) {
  if (typeof value !== "string") return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

// One id per save intent: the 32 hex characters of a crypto UUID, no hyphens.
export function createOperationId(source) {
  const cryptoSource = source || (typeof globalThis !== "undefined" ? globalThis.crypto : undefined);
  if (!cryptoSource || typeof cryptoSource.randomUUID !== "function") return null;
  const id = String(cryptoSource.randomUUID()).replace(/-/g, "").toLowerCase();
  return HEX32.test(id) ? id : null;
}

export function createFileEditor({ document, container, t, registerMessages, transport, getContext, onFeedback, onDirtyChange } = {}) {
  if (typeof registerMessages === "function") {
    try {
      registerMessages(fileWriteMessages);
    } catch {
      // Message registration belongs to the host; never break the editor.
    }
  }

  const messages = fileWriteMessages.en;
  const view = document?.defaultView || null;
  const state = {
    open: false, path: null, contextId: null, threadId: null, rootRevision: null,
    version: null, text: "", baselineText: "", editable: false, bom: false, eol: "lf", size: 0,
    status: "saved", operationId: null, recoveryId: null, lastSentText: null,
    saving: false, checking: false, controller: null, generation: 0, disposed: false,
    unload: false, revertConfirm: false, reloadConfirm: false, snapshot: null,
    dialog: null, dialogRefs: null, dialogFinish: null
  };
  const owned = [];
  let lastDirty = false;

  function label(key, params) {
    try {
      const value = typeof t === "function" ? (params ? t(key, params) : t(key)) : undefined;
      if (typeof value === "string" && value !== "" && value !== key) return value;
    } catch {
      // Fall back to the bundled English label.
    }
    const template = messages[key] ?? key;
    if (!params) return template;
    return template.replace(/\{(\w+)\}/g, (match, name) => (params[name] === undefined ? match : String(params[name])));
  }

  function feedback(kind, key, params) {
    try {
      onFeedback?.({ kind, code: key, label: label(key, params) });
    } catch {
      // Feedback is advisory.
    }
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function listen(node, type, handler) {
    node.addEventListener(type, handler);
    owned.push([node, type, handler]);
  }

  function button(className, action, key) {
    const node = element("button", `file-editor-button ${className}`, label(key));
    node.type = "button";
    node.setAttribute("data-file-write", action);
    return node;
  }

  const root = element("section", "file-editor");
  root.hidden = true;
  const pathNode = element("div", "file-editor-path", "");
  const toolbar = element("div", "file-editor-toolbar");
  const statusNode = element("div", "file-editor-status", "");
  statusNode.setAttribute("role", "status");
  const textarea = element("textarea", "file-editor-input", "");
  textarea.setAttribute("spellcheck", "false");
  textarea.setAttribute("autocapitalize", "off");
  textarea.setAttribute("aria-label", label("fileWrite.inputLabel"));
  const saveButton = button("file-editor-save", "save", "fileWrite.save");
  const revertButton = button("file-editor-revert", "revert", "fileWrite.revert");
  const checkButton = button("file-editor-check-status", "check-status", "fileWrite.checkStatus");
  const reloadButton = button("file-editor-reload", "reload", "fileWrite.reload");
  checkButton.hidden = true;
  reloadButton.hidden = true;
  toolbar.append(saveButton, revertButton, checkButton, reloadButton);
  const recoveryButton = typeof transport?.recoveryDownload === "function"
    ? button("file-editor-recovery", "recovery", "fileWrite.downloadRecovery")
    : null;
  if (recoveryButton) {
    recoveryButton.hidden = true;
    toolbar.append(recoveryButton);
  }
  root.append(pathNode, toolbar, statusNode, textarea);
  container.append(root);

  const scope = () => {
    try {
      return getContext?.() ?? {};
    } catch {
      return {};
    }
  };
  const connected = () => scope().connected !== false;
  function scopeChanged() {
    if (!state.open) return false;
    const current = scope();
    if (typeof current.contextId === "string" && current.contextId !== state.contextId) return true;
    if (typeof current.threadId === "string" && current.threadId !== state.threadId) return true;
    if (typeof current.rootRevision === "string" && current.rootRevision !== state.rootRevision) return true;
    return false;
  }
  const isDirty = () => state.open && state.text !== state.baselineText;
  const statusOf = () => {
    if (!state.open) return "saved";
    if (!connected() || scopeChanged()) return "offline";
    return state.status;
  };

  function notifyDirty() {
    const dirty = isDirty();
    if (dirty === lastDirty) return;
    lastDirty = dirty;
    try {
      onDirtyChange?.(dirty);
    } catch {
      // Listener failures stay contained.
    }
  }

  function wantsUnloadGuard() {
    return state.open && !state.disposed && (isDirty() || state.saving || state.status === "unknown");
  }
  function onBeforeUnload(event) {
    if (!wantsUnloadGuard()) return;
    event.preventDefault();
    event.returnValue = label("fileWrite.error.unsaved");
  }
  function syncUnload() {
    const wanted = wantsUnloadGuard();
    if (wanted && !state.unload && typeof view?.addEventListener === "function") {
      view.addEventListener("beforeunload", onBeforeUnload);
      state.unload = true;
    } else if (!wanted && state.unload && typeof view?.removeEventListener === "function") {
      view.removeEventListener("beforeunload", onBeforeUnload);
      state.unload = false;
    }
  }

  function render() {
    const status = statusOf();
    root.hidden = !state.open;
    if (!state.open) {
      pathNode.textContent = "";
      statusNode.textContent = "";
      notifyDirty();
      syncUnload();
      return;
    }
    pathNode.textContent = label("fileWrite.pathLabel", { path: state.path ?? "" });
    if (state.text !== textarea.value) textarea.value = state.text;
    textarea.readOnly = !state.editable;
    textarea.setAttribute("aria-readonly", state.editable ? "false" : "true");
    saveButton.textContent = label("fileWrite.save");
    saveButton.disabled = !canSave();
    revertButton.textContent = label(state.revertConfirm ? "fileWrite.revertConfirm" : "fileWrite.revert");
    revertButton.disabled = state.saving || (!isDirty() && status !== "conflict");
    checkButton.textContent = label("fileWrite.checkStatus");
    checkButton.hidden = status !== "unknown";
    checkButton.disabled = status === "offline" || state.checking;
    reloadButton.textContent = label(state.reloadConfirm ? "fileWrite.reloadConfirm" : "fileWrite.reload");
    reloadButton.hidden = status !== "conflict";
    reloadButton.disabled = state.saving;
    statusNode.textContent = label(`fileWrite.status.${status}`);
    if (recoveryButton) recoveryButton.hidden = !state.recoveryId;
    notifyDirty();
    syncUnload();
  }

  function canSave() {
    const status = statusOf();
    return state.open && state.editable && !state.disposed && !state.saving
      && status !== "offline" && status !== "conflict" && status !== "unknown"
      && typeof transport?.saveText === "function" && isDirty();
  }

  function abortCurrent() {
    if (!state.controller) return;
    try {
      state.controller.abort();
    } catch {
      // Abort is best effort.
    }
    state.controller = null;
  }

  function captureSnapshot(reason) {
    if (!state.open) return;
    const pending = isDirty() || state.status === "saving" || state.status === "unknown" || state.status === "conflict";
    if (!pending) return;
    state.snapshot = {
      text: state.text, version: state.version, path: state.path, contextId: state.contextId,
      threadId: state.threadId, rootRevision: state.rootRevision, status: statusOf(), reason
    };
  }

  function applyOpen(dto, text, editable) {
    state.generation += 1;
    abortCurrent();
    state.open = true;
    state.path = dto.path;
    state.contextId = dto.contextId;
    state.threadId = dto.threadId;
    state.rootRevision = dto.rootRevision;
    state.version = dto.version;
    state.text = text;
    state.baselineText = text;
    state.editable = editable;
    state.bom = dto.bom === true;
    state.eol = typeof dto.eol === "string" && dto.eol !== "" ? dto.eol : "lf";
    state.size = Number.isFinite(Number(dto.size)) ? Number(dto.size) : utf8ByteLength(text);
    state.status = "saved";
    state.operationId = null;
    state.recoveryId = null;
    state.lastSentText = null;
    state.saving = false;
    state.checking = false;
    state.revertConfirm = false;
    state.reloadConfirm = false;
    state.snapshot = null;
    textarea.value = text;
    render();
  }

  function open(dto, { replaceConfirmed = false } = {}) {
    if (state.disposed || !dto || typeof dto !== "object") return false;
    if (typeof dto.path !== "string" || dto.path === "") {
      feedback("error", "fileWrite.error.invalid");
      return false;
    }
    if (typeof dto.contextId !== "string" || dto.contextId === "" || typeof dto.threadId !== "string"
      || dto.threadId === "" || typeof dto.rootRevision !== "string" || dto.rootRevision === "") {
      feedback("error", "fileWrite.error.invalid");
      return false;
    }
    if (typeof dto.version !== "string" || dto.version === "") {
      feedback("error", "fileWrite.error.version");
      return false;
    }
    if (typeof dto.text !== "string") {
      feedback("error", "fileWrite.error.invalid");
      return false;
    }
    if (!isWellFormedText(dto.text)) {
      feedback("error", "fileWrite.error.encoding");
      return false;
    }
    const text = normalizeLf(dto.text);
    const editable = dto.editable === true;
    if (editable && utf8ByteLength(text) > MAX_EDIT_BYTES) {
      feedback("error", "fileWrite.error.tooLarge");
      return false;
    }
    if (!replaceConfirmed && state.open && (isDirty() || state.saving || state.status === "unknown" || state.status === "conflict")) {
      feedback("info", "fileWrite.error.unsaved", { path: state.path });
      return false;
    }
    applyOpen(dto, text, editable);
    return true;
  }

  function applySaveDto(dto, sentText, operationId) {
    state.saving = false;
    if (!dto || typeof dto !== "object") {
      state.status = "unknown";
      render();
      return false;
    }
    if ((dto.operationId !== undefined && dto.operationId !== operationId)
      || (dto.kind !== undefined && dto.kind !== "save-text")) {
      return false;
    }
    if (typeof dto.recoveryId === "string") { state.recoveryId=dto.recoveryId; state.recoveryOperationId=operationId; }
    if (dto.status === "succeeded") {
      const result = dto.result && typeof dto.result === "object" ? dto.result : {};
      if (typeof result.version !== "string" || result.version === "") {
        state.status = "unknown";
        render();
        return false;
      }
      state.version = result.version;
      state.baselineText = sentText;
      state.bom = result.bom === true;
      if (typeof result.eol === "string" && result.eol !== "") state.eol = result.eol;
      state.size = Number.isFinite(Number(result.size)) ? Number(result.size) : utf8ByteLength(sentText);
      state.status = isDirty() ? "dirty" : "saved";
      state.operationId = null;
      state.recoveryId = dto.recoveryId || null;
      render();
      return true;
    }
    if (dto.status === "failed") {
      const reason = `${dto.result?.reason ?? ""} ${dto.result?.code ?? ""}`;
      if (CONFLICT_REASON.test(reason)) {
        state.status = "conflict";
        state.recoveryId = typeof dto.recoveryId === "string" ? dto.recoveryId : null;
        render();
        return false;
      }
      if (dto.recoveryId) { state.status="unknown"; render(); return false; }
      state.status = isDirty() ? "dirty" : "saved";
      state.operationId = null;
      feedback("error", "fileWrite.error.saveFailed");
      render();
      return false;
    }
    state.status = "unknown";
    if (typeof dto.recoveryId === "string") state.recoveryId = dto.recoveryId;
    render();
    return false;
  }

  async function save() {
    if (!canSave()) return false;
    let operationId = state.operationId;
    if (!operationId) {
      operationId = createOperationId();
      if (!operationId) {
        feedback("error", "fileWrite.error.unavailable");
        return false;
      }
      state.operationId = operationId;
    }
    const generation = state.generation;
    const sentText = state.text;
    const path = state.path;
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    state.controller = controller;
    state.saving = true;
    state.status = "saving";
    state.lastSentText = sentText;
    state.revertConfirm = false;
    state.reloadConfirm = false;
    render();
    let dto;
    try {
      dto = await transport.saveText({
        contextId: state.contextId, path, operationId, text: sentText, expectedVersion: state.version
      }, controller?.signal);
    } catch (error) {
      if (state.disposed || generation !== state.generation) return false;
      // A typed 4xx response is a definite rejection. Network failures and
      // proxy timeouts remain unknown because the write may have been accepted.
      if(Number.isInteger(error?.status)&&error.status>=400&&error.status<500&&error.status!==408){
        return applySaveDto({operationId,kind:"save-text",status:"failed",path,result:{reason:error.code||"SAVE_REJECTED"}},sentText,operationId);
      }
      state.saving = false;
      state.status = "unknown";
      render();
      return false;
    }
    if (state.disposed || generation !== state.generation || state.path !== path) return false;
    return applySaveDto(dto, sentText, operationId);
  }

  async function checkStatus() {
    if (state.saving || state.checking || state.status !== "unknown" || !state.operationId) return false;
    if (statusOf() === "offline") return false;
    if (typeof transport?.operationStatus !== "function") {
      feedback("error", "fileWrite.error.checkFailed");
      return false;
    }
    const generation = state.generation;
    const operationId = state.operationId;
    const sentText = state.lastSentText ?? state.text;
    state.checking = true;
    render();
    let dto;
    try {
      dto = await transport.operationStatus({
        contextId: state.contextId, path: state.path, operationId, kind: "save-text"
      });
    } catch {
      if (state.disposed || generation !== state.generation) return false;
      state.checking = false;
      feedback("error", "fileWrite.error.checkFailed");
      render();
      return false;
    }
    if (state.disposed || generation !== state.generation) return false;
    state.checking = false;
    return applySaveDto(dto, sentText, operationId);
  }

  function requestRevert() {
    if (!state.open || state.saving) return;
    const status = statusOf();
    if (!isDirty() && status !== "conflict") return;
    if (!state.revertConfirm) {
      state.revertConfirm = true;
      state.reloadConfirm = false;
      render();
      return;
    }
    state.text = state.baselineText;
    state.revertConfirm = false;
    if (state.status === "dirty" || state.status === "saving") state.status = "saved";
    render();
  }

  function discardBuffer(reason) {
    captureSnapshot(reason);
    state.text = state.baselineText;
    state.revertConfirm = false;
    state.reloadConfirm = false;
    if (state.status === "dirty" || state.status === "saving") state.status = "saved";
    render();
  }

  function emitReloadRequired() {
    let entry;
    try {
      entry = {
        kind: "info", code: "fileWrite.reloadRequired", action: "reload-required",
        label: label("fileWrite.reloadRequired", { path: state.path ?? "" }),
        path: state.path, contextId: state.contextId
      };
      onFeedback?.(entry);
    } catch {
      // Advisory only.
    }
  }

  async function requestReload() {
    if (!state.open || state.saving || state.reloading || statusOf() !== "conflict") return false;
    if (!state.reloadConfirm) {
      state.reloadConfirm = true;
      state.revertConfirm = false;
      render();
      return false;
    }
    state.reloadConfirm = false;
    captureSnapshot("reload");
    if (typeof transport?.editOpen === "function") {
      const generation = state.generation;
      const requestedText = state.text;
      state.reloading = true;
      let dto;
      try {
        dto = await transport.editOpen({
          contextId: state.contextId, path: state.path, threadId: state.threadId, rootRevision: state.rootRevision
        });
      } catch {
        if (state.disposed || generation !== state.generation) return false;
        feedback("error", "fileWrite.error.invalid");
        return false;
      } finally {
        if(generation===state.generation)state.reloading=false;
      }
      if (state.disposed || generation !== state.generation) return false;
      if(state.text!==requestedText){feedback("info","fileWrite.error.unsaved");return false;}
      if (!dto || dto.path !== state.path || dto.threadId !== state.threadId || String(dto.rootRevision) !== String(state.rootRevision) || !open(dto, { replaceConfirmed: true })) {
        feedback("error", "fileWrite.error.invalid");
        return false;
      }
      return true;
    }
    state.text = state.baselineText;
    state.status = "saved";
    render();
    emitReloadRequired();
    return true;
  }

  async function downloadRecovery() {
    if (!state.recoveryId || typeof transport?.recoveryDownload !== "function") return false;
    try {
      await transport.recoveryDownload({
        contextId: state.contextId, path: state.path, operationId: state.recoveryOperationId || state.operationId, recoveryId: state.recoveryId
      });
      return true;
    } catch {
      feedback("error", "fileWrite.error.recovery");
      return false;
    }
  }

  function askUnsaved() {
    const dialog = document.createElement("dialog");
    dialog.className = "file-editor-dialog wf-dialog";
    const title = element("h2", "file-editor-dialog-title", label("fileWrite.unsavedTitle"));
    const summary = element("p", "file-editor-dialog-summary", label("fileWrite.unsavedSummary", { path: state.path ?? "" }));
    const statusLine = element("p", "file-editor-dialog-status", label(`fileWrite.status.${statusOf()}`));
    const actions = element("div", "file-editor-dialog-actions");
    const saveNode = element("button", "file-editor-dialog-save", label("fileWrite.dialogSave"));
    const discardNode = element("button", "file-editor-dialog-discard", label("fileWrite.dialogDiscard"));
    const cancelNode = element("button", "file-editor-dialog-cancel", label("fileWrite.dialogCancel"));
    for (const node of [saveNode, discardNode, cancelNode]) node.type = "button";
    actions.append(saveNode, discardNode, cancelNode);
    dialog.append(title, summary, statusLine, actions);

    const listeners = [];
    const bind = (node, type, handler) => {
      node.addEventListener(type, handler);
      listeners.push([node, type, handler]);
    };
    let settle;
    const promise = new Promise((resolve) => {
      settle = resolve;
    });
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      for (const [node, type, handler] of listeners.splice(0)) {
        try {
          node.removeEventListener(type, handler);
        } catch {
          // Detached node.
        }
      }
      state.dialog = null;
      state.dialogRefs = null;
      state.dialogFinish = null;
      try {
        dialog.close?.();
      } catch {
        // Not shown yet.
      }
      if (typeof dialog.remove === "function") dialog.remove();
      settle(value);
    };
    state.dialog = dialog;
    state.dialogRefs = { dialog, title, summary, statusLine, save: saveNode, discard: discardNode, cancel: cancelNode };
    state.dialogFinish = finish;
    bind(saveNode, "click", () => finish("save"));
    bind(discardNode, "click", () => finish("discard"));
    bind(cancelNode, "click", () => finish("cancel"));
    bind(dialog, "cancel", (event) => {
      event?.preventDefault?.();
      finish("cancel");
    });
    container.append(dialog);
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    return promise;
  }

  async function beforeContextChange() {
    if (state.disposed || !state.open) return true;
    if (!isDirty() && !state.saving && state.status !== "unknown") return true;
    const action = await askUnsaved();
    if (action === "save") return (await save()) === true && !isDirty() && !state.saving && state.status !== "unknown";
    if (action === "discard") {
      discardBuffer("context-change");
      return true;
    }
    return false;
  }

  function refreshLabels() {
    if (state.disposed) return;
    render();
    textarea.setAttribute("aria-label", label("fileWrite.inputLabel"));
    const refs = state.dialogRefs;
    if (!refs) return;
    refs.title.textContent = label("fileWrite.unsavedTitle");
    refs.summary.textContent = label("fileWrite.unsavedSummary", { path: state.path ?? "" });
    refs.statusLine.textContent = label(`fileWrite.status.${statusOf()}`);
    refs.save.textContent = label("fileWrite.dialogSave");
    refs.discard.textContent = label("fileWrite.dialogDiscard");
    refs.cancel.textContent = label("fileWrite.dialogCancel");
  }

  function dispose() {
    if (state.disposed) return;
    captureSnapshot("dispose");
    state.disposed = true;
    state.generation += 1;
    abortCurrent();
    state.saving = false;
    state.checking = false;
    if (state.dialogFinish) state.dialogFinish("cancel");
    for (const [node, type, handler] of owned.splice(0)) {
      try {
        node.removeEventListener(type, handler);
      } catch {
        // Detached node.
      }
    }
    if (state.unload && typeof view?.removeEventListener === "function") {
      view.removeEventListener("beforeunload", onBeforeUnload);
      state.unload = false;
    }
    if (typeof root.remove === "function") root.remove();
    else if (root.parent && typeof root.parent.removeChild === "function") root.parent.removeChild(root);
  }

  function getState() {
    return {
      open: state.open, path: state.path, contextId: state.contextId, threadId: state.threadId,
      rootRevision: state.rootRevision, version: state.version, text: state.text,
      baselineText: state.baselineText, editable: state.editable, bom: state.bom,
      eol: state.eol, size: state.size, status: statusOf(), dirty: isDirty(),
      operationId: state.operationId, recoveryId: state.recoveryId,
      snapshot: state.snapshot ? { ...state.snapshot } : null, disposed: state.disposed
    };
  }

  function onInput() {
    if (!state.open || !state.editable || state.disposed) return;
    state.text = textarea.value;
    if (state.status !== "unknown" && state.status !== "conflict" && state.status !== "saving") {
      state.status = isDirty() ? "dirty" : "saved";
    }
    state.revertConfirm = false;
    state.reloadConfirm = false;
    render();
  }

  function onKeydown(event) {
    if (!state.open || state.disposed) return;
    if (event?.key !== "s" && event?.key !== "S") return;
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
    event.preventDefault?.();
    void save();
  }

  listen(textarea, "input", onInput);
  listen(textarea, "keydown", onKeydown);
  listen(saveButton, "click", () => void save());
  listen(revertButton, "click", requestRevert);
  listen(checkButton, "click", () => void checkStatus());
  listen(reloadButton, "click", () => void requestReload());
  if (recoveryButton) listen(recoveryButton, "click", () => void downloadRecovery());

  render();

  return {
    open,
    renewAuthority({ contextId, path, threadId, rootRevision } = {}) {
      if (state.disposed || !state.open || typeof contextId !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(contextId)
        || path !== state.path || threadId !== state.threadId || String(rootRevision) !== String(state.rootRevision)) return false;
      state.contextId = contextId;
      return true;
    },
    hasUnsavedChanges: isDirty,
    beforeContextChange,
    refreshLabels,
    dispose,
    getState
  };
}
