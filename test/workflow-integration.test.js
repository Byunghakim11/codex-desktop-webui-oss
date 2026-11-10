import test from "node:test";
import assert from "node:assert/strict";
import { createComposerDraftController, WORKFLOW_FEATURES } from "../public/workflow-tools.js";

function editor() {
  const listeners = new Map();
  return { value: "", selectionStart: 0, selectionEnd: 0, selectionDirection: "none",
    addEventListener(type, fn) { listeners.set(type, fn); }, removeEventListener(type) { listeners.delete(type); },
    setSelectionRange(start, end, direction) { this.selectionStart = start; this.selectionEnd = end; this.selectionDirection = direction; },
    emit(type, extra = {}) { listeners.get(type)?.({ target: this, ...extra }); },
    type(text) { this.value = text; this.selectionStart = this.selectionEnd = text.length; this.emit("input"); },
  };
}
test("drafts restore text and selection per thread without reconnect overwrite", () => {
  const input = editor(), notices = [];
  const drafts = createComposerDraftController({ input, notify: status => notices.push(status) });
  drafts.switchThread("A"); input.type("A 한국어"); input.setSelectionRange(1, 3, "backward");
  assert.equal(drafts.switchThread("B"), true); assert.equal(input.value, ""); input.type("B");
  drafts.switchThread("A"); assert.equal(input.value, "A 한국어"); assert.equal(input.selectionStart, 1);
  input.type("new edit"); drafts.switchThread("A"); assert.equal(input.value, "new edit");
  drafts.switchThread("B"); assert.equal(input.value, "B"); drafts.dispose();
});
test("pending and failed send preserve edits; confirmed send clears only its unchanged version", () => {
  const input = editor(), drafts = createComposerDraftController({ input }); drafts.switchThread("A"); input.type("send me");
  let ticket = drafts.beginSend(); assert.equal(input.value, "send me");
  input.type("new typing"); drafts.finishSend(ticket, true); assert.equal(input.value, "new typing");
  drafts.switchThread("B"); drafts.switchThread("A"); assert.equal(input.value, "new typing");
  ticket = drafts.beginSend(); drafts.finishSend(ticket, false); assert.equal(input.value, "new typing");
  ticket = drafts.beginSend(); drafts.finishSend(ticket, true); assert.equal(input.value, "");
  assert.equal(drafts.undoClear(), false); drafts.switchThread("B"); drafts.switchThread("A"); assert.equal(input.value, "");
});
test("whole clear undo excludes partial deletion and IME and never overwrites new input", () => {
  const input = editor(), drafts = createComposerDraftController({ input }); drafts.switchThread("A"); input.type("draft");
  input.setSelectionRange(0, 5, "forward"); input.emit("beforeinput", { inputType: "deleteContentBackward", isComposing: true }); input.type(""); assert.equal(drafts.undoClear(), false);
  input.type("draft"); input.setSelectionRange(0, 5, "forward"); input.emit("beforeinput", { inputType: "deleteContentBackward" }); input.type(""); assert.equal(drafts.undoClear(), true); assert.equal(input.value, "draft");
  drafts.clear(); input.type("new"); assert.equal(drafts.undoClear(), false); drafts.clear(); drafts.forget(); assert.equal(drafts.undoClear(), false);
});
test("capacity and attachments block switch without losing current input; key adoption preserves edits", () => {
  const input = editor(); let blocked = false;
  const drafts = createComposerDraftController({ input, blocked: () => blocked }); drafts.switchThread("A"); input.type("attachments"); blocked = true;
  assert.equal(drafts.switchThread("B"), false); assert.equal(input.value, "attachments"); blocked = false;
  input.type("x".repeat(65537)); assert.equal(drafts.switchThread("B"), false); assert.equal(input.value.length, 65537);
  input.type("send draft"); const ticket = drafts.beginSend(); drafts.adoptThread("created"); input.type("new"); drafts.finishSend(ticket, true);
  drafts.switchThread("B"); drafts.switchThread("created"); assert.equal(input.value, "new"); drafts.switchThread("A"); assert.equal(input.value, "");
  assert.equal(Object.keys(WORKFLOW_FEATURES).length, 15); assert.ok(Object.values(WORKFLOW_FEATURES).every(Boolean));
});
test("failed send offers its bounded snapshot without overwriting newer text", () => {
  const input = editor(), drafts = createComposerDraftController({ input }); drafts.switchThread("A"); input.type("sent snapshot");
  const ticket = drafts.beginSend(); input.type("new text"); drafts.finishSend(ticket, false);
  assert.equal(input.value, "new text"); assert.equal(drafts.getRecovery().text, "sent snapshot");
  drafts.switchThread("B"); assert.equal(drafts.getRecovery(), null); drafts.switchThread("A"); assert.equal(drafts.getRecovery().text, "sent snapshot");
  drafts.forget(); assert.equal(drafts.getRecovery(), null);
});
test("explicit clear keeps oversized active text when undo cannot retain it", () => {
  const input=editor(),drafts=createComposerDraftController({input});drafts.switchThread("A");input.type("x".repeat(65537));
  assert.equal(drafts.clear(),false);assert.equal(input.value.length,65537);assert.equal(drafts.undoClear(),false);
});
