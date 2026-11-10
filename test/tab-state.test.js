import test from "node:test";
import assert from "node:assert/strict";
import { createTabState, isFullComposerDeletion } from "../public/tab-state.js";

const draft = (text, composerRevision = 1) => ({ text, selectionStart: 1, selectionEnd: text.length, selectionDirection: "backward", composerRevision });
test("drafts restore independent text and selection without sharing mutable values", () => {
  const state = createTabState();
  state.drafts.setActive("A");
  assert.equal(state.drafts.put("A", draft("alpha")).ok, true);
  state.drafts.setActive("B"); state.drafts.put("B", draft("beta")); state.drafts.setActive("A");
  const restored = state.drafts.get("A");
  assert.equal(restored.text, "alpha");
  assert.equal(restored.selectionStart, 1);
  assert.equal(restored.selectionEnd, 5);
  assert.equal(restored.selectionDirection, "backward");
  restored.text = "changed";
  assert.equal(state.drafts.get("A").text, "alpha");
  assert.equal(state.drafts.get("B").text, "beta");
});
test("UTF8 and total limits reject replacement without silently evicting", () => {
  const { drafts } = createTabState();
  drafts.put("keep", draft("original"));
  assert.deepEqual(drafts.put("keep", draft("한".repeat(21846))), { ok: false, status: "item-limit" });
  assert.equal(drafts.get("keep").text, "original");
  drafts.remove("keep");
  for (let i = 0; i < 8; i++) assert.equal(drafts.put(String(i), draft("a".repeat(65536))).ok, true);
  assert.equal(drafts.put("overflow", draft("a")).status, "total-limit");
  assert.equal(drafts.listMetadata().filter(x => x.status === "saved").length, 8);
});
test("ten draft limit rejects an eleventh while allowing existing replacement", () => {
  const { drafts } = createTabState();
  for (let i = 0; i < 10; i++) drafts.put(String(i), draft("text"));
  assert.equal(drafts.put("11", draft("extra")).status, "count-limit");
  assert.equal(drafts.put("1", draft("replacement")).ok, true);
  assert.equal(drafts.get("0").text, "text");
});
test("inactive TTL begins on leaving editor and expiry stays visible without text", () => {
  let time = 0; const { drafts } = createTabState({ now: () => time });
  drafts.setActive("A"); drafts.put("A", draft("protected"));
  time = 1800001;
  assert.equal(drafts.get("A").text, "protected");
  drafts.setActive("B"); time += 1799999;
  assert.equal(drafts.get("A").text, "protected"); time++;
  assert.equal(drafts.get("A").status, "expired");
  assert.deepEqual(drafts.listMetadata(), [{ threadKey: "A", status: "expired", bytes: 0, active: false, expiresAt: 3600001 }]);
  drafts.setActive("A"); assert.equal(drafts.get("A").status, "expired");
});
test("undo is once per thread, expires at 60 seconds and guards post-clear revision", () => {
  let time = 10; const { undo } = createTabState({ now: () => time });
  undo.capture("A", draft("restore", 4));
  assert.equal(undo.take("B", 4).status, "missing");
  assert.equal(undo.take("A", 5).status, "revision-mismatch");
  assert.equal(undo.take("A", 4).status, "missing");
  undo.capture("A", draft("restore", 4)); time = 60010;
  assert.equal(undo.take("A", 4).status, "expired");
  undo.capture("A", draft("restore", 6));
  assert.equal(undo.take("A", 6).text, "restore");
  assert.equal(undo.take("A", 6).status, "missing");
});
test("invalidation, full deletion and clearAll never resurrect content", () => {
  const state = createTabState();
  state.undo.capture("A", draft("old")); state.undo.invalidate("A");
  assert.equal(state.undo.take("A", 1).status, "missing");
  state.drafts.put("A", draft("old")); state.undo.capture("A", draft("old")); state.drafts.remove("A");
  assert.equal(state.undo.take("A", 1).status, "missing");
  state.drafts.put("A", draft("old")); state.undo.capture("A", draft("old")); state.clearAllTabContent();
  assert.equal(state.drafts.get("A").status, "missing");
  assert.equal(state.undo.take("A", 1).status, "missing");
});
test("full deletion detector ignores partial edits, IME, cut and other input types", () => {
  assert.equal(isFullComposerDeletion({ text: "text", selectionStart: 0, selectionEnd: 4, inputType: "deleteContentBackward" }), true);
  for (const extra of [{ selectionEnd: 3 }, { isComposing: true }, { inputType: "insertCompositionText" }, { inputType: "deleteByCut" }, { inputType: "historyUndo" }]) {
    assert.equal(isFullComposerDeletion({ text: "text", selectionStart: 0, selectionEnd: 4, inputType: "deleteContentForward", ...extra }), false);
  }
});
