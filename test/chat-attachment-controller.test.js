import test from "node:test";
import assert from "node:assert/strict";

import {
  CHAT_ATTACHMENT_LIMITS,
  ChatAttachmentController,
  sameAttachmentContext
} from "../public/chat-attachments.js";

const MIB = 1024 * 1024;

const file = (name, size = 16, type = "") => ({ name, size, type });

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// Fake transport: no filesystem and no network. Each upload registers a controllable task.
function fakeTransport(options = {}) {
  const calls = { upload: [], remove: [] };
  const tasks = [];
  let counter = 0;
  const readyResult = (request, id) => ({
    id,
    name: request.file.name,
    size: request.file.size,
    mime: request.file.type || "application/octet-stream",
    status: "ready"
  });
  const transport = {
    async upload(request) {
      calls.upload.push(request);
      counter += 1;
      const task = { request, defer: deferred(), progress: request.onProgress, id: `srv-${counter}` };
      tasks.push(task);
      if(request.signal && !options.ignoreAbort) {
        request.signal.addEventListener("abort", () => {
          task.defer.reject(Object.assign(new Error("aborted"), { name: "AbortError", code: "upload-aborted" }));
        }, { once: true });
      }
      if(options.auto) {
        request.onProgress?.(request.file.size, request.file.size);
        task.defer.resolve(readyResult(request, task.id));
      }
      return task.defer.promise;
    },
    async remove(request) {
      calls.remove.push(request);
      if(options.removeError) throw Object.assign(new Error("remove failed"), { code: "remove-failed" });
      return { ok: true };
    }
  };
  const settle = async (index, value) => {
    const task = tasks[index];
    task.request.onProgress?.(task.request.file.size, task.request.file.size);
    task.defer.resolve(value ?? readyResult(task.request, task.id));
    await flush();
  };
  const fail = async (index, code = "upload-failed") => {
    tasks[index].defer.reject(Object.assign(new Error(code), { code }));
    await flush();
  };
  return { transport, tasks, calls, settle, fail };
}

const makeContext = (overrides = {}) => ({ draftId: "draft-1", cwd: "/workspace/project", threadId: null, scopeKey: "scope-1", ...overrides });

function makeController(options = {}) {
  const state = { context: options.context ?? makeContext(), changes: 0 };
  const fake = options.fake ?? fakeTransport();
  const ids = ["client-a", "client-b", "client-c", "client-d", "client-e", "client-f"];
  const controller = new ChatAttachmentController({
    transport: fake.transport,
    contextProvider: () => state.context,
    onChange: () => { state.changes += 1; },
    createId: options.createId ?? (() => ids.shift() ?? `client-${Math.random().toString(16).slice(2)}`),
    limits: options.limits
  });
  return { controller, state, fake, ids };
}

test("mixed empty-MIME files are accepted without an image-only filter", async () => {
  const fake = fakeTransport({ auto: true });
  const { controller } = makeController({ fake });
  const result = controller.addFiles([
    file("report.xlsx", 40, ""),
    file("contract.pdf", 50, "application/pdf"),
    file("data.csv", 10, "text/csv"),
    file("notes.docx", 20, "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
    file("photo.jpg", 30, "image/jpeg")
  ], "picker");
  assert.equal(result.rejected.length, 0);
  assert.equal(result.accepted.length, 5);
  assert.deepEqual(controller.snapshot().map((item) => [item.name, item.mime]), [
    ["report.xlsx", ""],
    ["contract.pdf", "application/pdf"],
    ["data.csv", "text/csv"],
    ["notes.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    ["photo.jpg", "image/jpeg"]
  ]);
  await flush();
  assert.deepEqual(fake.calls.upload.map((request) => request.file.name), ["report.xlsx", "contract.pdf", "data.csv", "notes.docx", "photo.jpg"]);
  assert.deepEqual(controller.snapshot().map((item) => item.status), ["ready", "ready", "ready", "ready", "ready"]);
  assert.equal(controller.snapshot()[0].mime, "application/octet-stream", "server detected type replaces an empty declared type");
  controller.dispose();
});

test("limits are enforced before any upload starts and byte totals are exposed", () => {
  const fake = fakeTransport();
  const { controller, state } = makeController({ fake, limits: { maxFileBytes: 10 * MIB, maxFiles: 2, maxBatchBytes: 15 * MIB } });
  const result = controller.addFiles([
    file("big.bin", 11 * MIB, ""),
    file("one.bin", 8 * MIB, ""),
    file("two.bin", 8 * MIB, ""),
    file("three.bin", 1, ""),
    file("four.bin", 1, "")
  ], "drop");
  assert.deepEqual(result.rejected.map((entry) => entry.error), ["file-too-large", "draft-too-large", "file-count-limit"]);
  assert.equal(result.accepted.length, 2);
  assert.deepEqual(fake.calls.upload.map((request) => request.file.name), ["one.bin"], "rejected files never reach the transport");
  const totals = controller.totals();
  assert.equal(totals.files, 2);
  assert.equal(totals.bytes, 8 * MIB + 1);
  assert.equal(totals.pending, 2);
  assert.equal(totals.maxFiles, 2);
  assert.equal(totals.maxFileBytes, 10 * MIB);
  assert.equal(totals.maxBatchBytes, 15 * MIB);
  assert.ok(state.changes >= 1, "onChange fired for the accepted files");
  controller.dispose();
});

test("progress, late settle after cancel and orphan cleanup keep snapshots UI safe", async () => {
  const fake = fakeTransport({ ignoreAbort: true });
  const { controller } = makeController({ fake });
  controller.addFiles([file("a.bin", 100, "")], "picker");
  const [first] = controller.snapshot();
  assert.equal(first.status, "uploading");
  assert.equal(first.id, null);
  fake.tasks[0].progress(40, 100);
  assert.equal(controller.snapshot()[0].progress, 0.4);
  fake.tasks[0].progress(10, 100);
  assert.equal(controller.snapshot()[0].progress, 0.4, "progress never moves backwards");
  await fake.settle(0);
  const [ready] = controller.snapshot();
  assert.equal(ready.status, "ready");
  assert.equal(ready.id, "srv-1");
  assert.equal(ready.progress, 1);
  assert.ok(Object.isFrozen(ready));
  assert.ok(Object.isFrozen(controller.snapshot()));
  assert.deepEqual(Object.keys(ready).sort(), ["clientId", "error", "id", "mime", "name", "progress", "size", "status"]);
  assert.equal(ready.file, undefined);
  assert.equal(ready.context, undefined);

  // Cancel while uploading: the item is dropped immediately and the late server write is purged.
  controller.addFiles([file("b.bin", 50, "")], "picker");
  const uploading = controller.snapshot()[1];
  fake.tasks[1].progress(10, 50);
  assert.equal(fake.tasks[1].request.signal.aborted, false);
  assert.deepEqual(await controller.remove(uploading.clientId), { ok: true, status: "aborted" });
  assert.equal(fake.tasks[1].request.signal.aborted, true);
  assert.deepEqual(controller.snapshot().map((item) => item.name), ["a.bin"]);
  await fake.settle(1, { id: "srv-orphan", name: "b.bin", size: 50, mime: "", status: "ready" });
  assert.equal(fake.calls.remove.at(-1).id, "srv-orphan");
  controller.dispose();
});

test("failed uploads keep the same file for a same-context retry and refuse duplicate events", async () => {
  const fake = fakeTransport();
  const { controller } = makeController({ fake });
  const spreadsheet = file("books.xlsx", 64, "");
  controller.addFiles([spreadsheet], "picker");
  await fake.fail(0, "upload-failed");
  const [failed] = controller.snapshot();
  assert.equal(failed.status, "failed");
  assert.equal(failed.error, "upload-failed");

  // Re-adding the pending File object is suppressed; a fresh File object is a separate attachment.
  const repeat = controller.addFiles([spreadsheet], "picker");
  assert.deepEqual(repeat.accepted, []);
  assert.deepEqual(repeat.rejected.map((entry) => entry.error), ["duplicate-file"]);
  assert.equal(controller.snapshot().length, 1);
  const fresh = controller.addFiles([file("books.xlsx", 64, "")], "picker");
  assert.equal(fresh.accepted.length, 1);

  assert.deepEqual(controller.retry(controller.snapshot()[0].clientId), { ok: true });
  assert.equal(fake.calls.upload.length, 2, "the retry is queued behind the in-flight fresh file");
  await fake.settle(1);
  assert.equal(fake.calls.upload.length, 3);
  assert.equal(fake.calls.upload[2].file, spreadsheet, "retry reuses the same File object");
  assert.deepEqual(fake.calls.upload[2].context, fake.calls.upload[0].context);

  await fake.settle(2);
  assert.deepEqual(controller.snapshot().map((item) => item.status), ["ready", "ready"]);
  controller.dispose();
});

test("prepareSend waits for pending uploads, locks once and dedupes the clientSendId", async () => {
  const fake = fakeTransport();
  const { controller } = makeController({ fake });
  controller.addFiles([file("a.pdf", 20, "application/pdf")], "picker");
  const context = makeContext();
  const pending = controller.prepareSend(context);
  // Locked before the first await: input and mutations are refused.
  assert.deepEqual(controller.addFiles([file("late.txt", 5, "text/plain")], "picker").rejected.map((entry) => entry.error), ["send-locked"]);
  assert.deepEqual(await controller.remove(controller.snapshot()[0].clientId), { ok: false, error: "send-locked" });
  assert.deepEqual(controller.retry(controller.snapshot()[0].clientId), { ok: false, error: "send-locked" });
  assert.equal(controller.locked, true);

  let prepared = false;
  pending.then(() => { prepared = true; }, () => { prepared = true; });
  await flush();
  assert.equal(prepared, false, "prepareSend awaits the real upload promise");
  assert.equal(controller.snapshot()[0].status, "uploading");
  await fake.settle(0);
  const plan = await pending;
  assert.deepEqual([...plan.attachmentIds], ["srv-1"]);
  assert.equal(plan.draftId, "draft-1");
  assert.match(plan.clientSendId, /\S+/);
  assert.equal(controller.snapshot()[0].status, "sending");

  // A repeated prepare of the same snapshot returns the same send id instead of a duplicate send.
  const again = await controller.prepareSend(context);
  assert.equal(again.clientSendId, plan.clientSendId);
  assert.deepEqual([...again.attachmentIds], ["srv-1"]);

  assert.deepEqual(plan.commit(), { ok: true, status: "sent" });
  assert.deepEqual(controller.snapshot(), []);
  assert.equal(controller.locked, false);
  controller.dispose();
});

test("prepareSend blocks on a pending failure instead of sending partially", async () => {
  const fake = fakeTransport();
  const { controller } = makeController({ fake });
  controller.addFiles([file("a.pdf", 20, "application/pdf"), file("b.pdf", 20, "application/pdf")], "picker");
  await flush();
  await fake.fail(0, "upload-failed");
  assert.equal(fake.tasks.length, 2);
  const pending = controller.prepareSend(makeContext());
  let settled = false;
  pending.then(() => { settled = true; }, () => { settled = true; });
  await flush();
  assert.equal(settled, false, "prepareSend waits for the remaining upload");
  assert.equal(controller.snapshot()[1].status, "uploading");
  await fake.settle(1);
  await assert.rejects(pending, { code: "upload-failed" });
  assert.deepEqual(controller.snapshot().map((item) => item.status), ["failed", "ready"]);
  assert.equal(controller.locked, false, "a blocked prepare releases the send lock");
  controller.dispose();
});

test("prepareSend rejects project changes and mismatched thread bindings", async () => {
  const fake = fakeTransport({ auto: true });
  const { controller, state } = makeController({ fake });
  controller.addFiles([file("a.pdf", 20, "application/pdf")], "picker");
  await flush();

  state.context = makeContext({ cwd: "/workspace/other" });
  await assert.rejects(controller.prepareSend(makeContext()), { code: "context-changed" });
  assert.equal(controller.snapshot()[0].status, "ready", "items survive a rejected prepare");

  // Same draft/cwd/scope with a newly created current thread: the unbound item may bind to it.
  state.context = makeContext({ threadId: "thread-new" });
  const plan = await controller.prepareSend(makeContext({ threadId: "thread-new" }));
  assert.deepEqual([...plan.attachmentIds], ["srv-1"]);
  assert.deepEqual(plan.fail(), { ok: true, status: "retry" });
  assert.equal(controller.snapshot()[0].status, "ready");

  // An attachment captured on a concrete thread never moves to a different thread.
  state.context = makeContext({ threadId: "thread-1" });
  controller.addFiles([file("b.pdf", 20, "application/pdf")], "picker");
  await flush();
  await assert.rejects(controller.prepareSend(makeContext({ threadId: "thread-2" })), { code: "context-mismatch" });
  const sameThread = await controller.prepareSend(makeContext({ threadId: "thread-1" }));
  assert.equal(sameThread.attachmentIds.length, 2);
  sameThread.commit();
  assert.deepEqual(controller.snapshot(), []);
  controller.dispose();
});

test("unknown sends stay locked and never auto retry until an authoritative outcome", async () => {
  const fake = fakeTransport({ auto: true });
  const { controller } = makeController({ fake });
  controller.addFiles([file("a.pdf", 20, "application/pdf")], "picker");
  await flush();
  const plan = await controller.prepareSend(makeContext());
  assert.deepEqual(plan.fail({ unknown: true }), { ok: true, status: "unknown" });
  assert.equal(controller.snapshot()[0].status, "unknown");
  assert.equal(controller.locked, true);
  assert.equal(fake.calls.upload.length, 1, "no automatic resend");

  await assert.rejects(controller.prepareSend(makeContext()), { code: "send-unknown" });
  assert.deepEqual(await controller.remove(controller.snapshot()[0].clientId), { ok: false, error: "send-unknown" });
  assert.deepEqual(controller.reconcileSend("some-other-id", { status: "accepted" }), { ok: false, error: "unknown-send" });
  assert.deepEqual(controller.reconcileSend(plan.clientSendId, { status: "bogus" }), { ok: false, error: "invalid-status" });
  assert.deepEqual(controller.reconcileSend(plan.clientSendId, { status: "unknown" }), { ok: true, status: "unknown" });
  assert.equal(controller.locked, true);
  assert.deepEqual(controller.reconcileSend(plan.clientSendId, { status: "rejected" }), { ok: true, status: "rejected" });
  assert.deepEqual(controller.snapshot().map((item) => [item.status, item.error]), [["ready", null]]);
  assert.equal(controller.locked, false);
  assert.equal(fake.calls.upload.length, 1);

  const retryPlan = await controller.prepareSend(makeContext());
  assert.equal(retryPlan.clientSendId, plan.clientSendId, "the rejected send reuses its dedupe id");
  retryPlan.fail({ unknown: true, error: "gateway-timeout" });
  assert.equal(controller.snapshot()[0].error, "gateway-timeout");
  assert.deepEqual(controller.reconcileSend(retryPlan.clientSendId, { status: "accepted" }), { ok: true, status: "accepted" });
  assert.deepEqual(controller.snapshot(), []);
  assert.equal(controller.locked, false);
  controller.dispose();
});

test("commit removes only the captured files and keeps later input", async () => {
  const fake = fakeTransport({ auto: true });
  const { controller } = makeController({ fake });
  controller.addFiles([file("a.pdf", 20, "application/pdf")], "picker");
  controller.addFiles([file("b.pdf", 20, "application/pdf")], "picker");
  await flush();
  const rejectedPlan = await controller.prepareSend(makeContext());
  assert.equal(rejectedPlan.attachmentIds.length, 2);
  rejectedPlan.fail();
  assert.deepEqual(controller.snapshot().map((item) => item.status), ["ready", "ready"], "a definite rejection keeps everything");

  const plan = await controller.prepareSend(makeContext());
  assert.deepEqual(plan.commit(), { ok: true, status: "sent" });
  assert.deepEqual(controller.snapshot(), []);

  controller.addFiles([file("c.txt", 3, "text/plain")], "picker");
  await flush();
  assert.deepEqual(controller.snapshot().map((item) => item.name), ["c.txt"]);
  assert.equal(controller.totals().bytes, 3);
  controller.dispose();
});

test("remove deletes ready attachments on the server and reports a failed deletion", async () => {
  const failing = fakeTransport({ auto: true, removeError: true });
  const first = makeController({ fake: failing });
  first.controller.addFiles([file("a.pdf", 20, "application/pdf")], "picker");
  await flush();
  const clientId = first.controller.snapshot()[0].clientId;
  assert.deepEqual(await first.controller.remove(clientId), { ok: false, error: "remove-failed" });
  assert.deepEqual(first.controller.snapshot().map((item) => [item.status, item.error]), [["ready", "remove-failed"]]);

  const working = fakeTransport({ auto: true });
  const second = makeController({ fake: working });
  second.controller.addFiles([file("b.pdf", 20, "application/pdf")], "picker");
  await flush();
  assert.deepEqual(await second.controller.remove(second.controller.snapshot()[0].clientId), { ok: true, status: "removed" });
  assert.deepEqual(second.controller.snapshot(), []);
  assert.deepEqual(working.calls.remove.map((request) => request.id), ["srv-1"]);
  first.controller.dispose();
  second.controller.dispose();
});

test("dispose aborts uploads, clears state and replays no send", async () => {
  const fake = fakeTransport();
  const { controller } = makeController({ fake });
  controller.addFiles([file("a.bin", 30, "")], "picker");
  const signal = fake.tasks[0].request.signal;
  const waiting = controller.prepareSend(makeContext());
  controller.dispose();
  assert.equal(signal.aborted, true);
  await assert.rejects(waiting, { code: "disposed" });
  assert.deepEqual(controller.snapshot(), []);
  assert.equal(controller.locked, false);
  assert.deepEqual(controller.addFiles([file("b.bin", 5, "")], "picker").rejected.map((entry) => entry.error), ["disposed"]);
  assert.equal(fake.calls.upload.length, 1, "dispose never re-uploads");
  await assert.rejects(controller.prepareSend(makeContext()), { code: "disposed" });
});

test("context equality accepts exact matches and unbound threads only", () => {
  const base = makeContext();
  assert.equal(sameAttachmentContext(base, makeContext()), true);
  assert.equal(sameAttachmentContext(base, makeContext({ threadId: "thread-new" })), true);
  assert.equal(sameAttachmentContext(makeContext({ threadId: "thread-1" }), makeContext({ threadId: "thread-1" })), true);
  assert.equal(sameAttachmentContext(makeContext({ threadId: "thread-1" }), makeContext({ threadId: "thread-2" })), false);
  assert.equal(sameAttachmentContext(makeContext({ threadId: "thread-1" }), makeContext()), false);
  assert.equal(sameAttachmentContext(base, makeContext({ draftId: "draft-2" })), false);
  assert.equal(sameAttachmentContext(base, makeContext({ scopeKey: "scope-2" })), false);
  assert.equal(sameAttachmentContext(base, makeContext({ cwd: "/workspace/other" })), false);
  assert.equal(CHAT_ATTACHMENT_LIMITS.maxFileBytes, 25 * MIB);
  assert.equal(CHAT_ATTACHMENT_LIMITS.maxFiles, 20);
  assert.equal(CHAT_ATTACHMENT_LIMITS.maxBatchBytes, 100 * MIB);
});
