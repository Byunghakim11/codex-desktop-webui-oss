import test from "node:test";
import assert from "node:assert/strict";

import {
  ATTACHMENT_BLOCK_CLOSE as SERVER_BLOCK_CLOSE,
  ATTACHMENT_BLOCK_OPEN as SERVER_BLOCK_OPEN,
  ChatAttachmentInputError,
  expandChatAttachmentInput
} from "../server/chat-attachment-input.js";
import {
  ATTACHMENT_BLOCK_CLOSE,
  ATTACHMENT_BLOCK_OPEN,
  MAX_ATTACHMENT_JSON_CHARS,
  attachmentReferences,
  stripAttachmentReferences
} from "../public/attachment-reference.js";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

let fileCounter = 0;

function verifiedFile(overrides = {}) {
  fileCounter += 1;
  return {
    id: fileCounter.toString(16).padStart(32, "0"),
    name: "book.xlsx",
    size: 2048,
    mime: XLSX_MIME,
    path: `C:\\Users\\demo\\workspace\\book-${fileCounter}.xlsx`,
    sha256: "c".repeat(64),
    ...overrides
  };
}

function referenceItem(expanded) {
  assert.ok(Array.isArray(expanded.input));
  const item = expanded.input[expanded.input.length - 1];
  assert.equal(item.type, "text");
  assert.ok(item.text.startsWith(ATTACHMENT_BLOCK_OPEN));
  assert.ok(item.text.endsWith(ATTACHMENT_BLOCK_CLOSE));
  return item.text;
}

function expandedBlock({ method = "turn/start", params = {}, files } = {}) {
  return referenceItem(expandChatAttachmentInput({ method, params, files }));
}

function payloadOf(block) {
  return JSON.parse(block.slice(ATTACHMENT_BLOCK_OPEN.length, block.length - ATTACHMENT_BLOCK_CLOSE.length).trim());
}

function payloadFor(files) {
  return {
    version: 1,
    policy: "untrusted",
    attachments: files.map(file => ({
      id: file.id,
      name: file.name,
      size: file.size,
      mime: file.mime,
      path: file.path
    }))
  };
}

function fakeBlock(payload, { close = true } = {}) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  return `${ATTACHMENT_BLOCK_OPEN}\n${body}\n${close ? ATTACHMENT_BLOCK_CLOSE : ""}`;
}

function remoteFile(index, overrides = {}) {
  return {
    id: index.toString(16).padStart(32, "0"),
    name: `file-${index}.txt`,
    size: index,
    mime: "text/plain",
    path: `C:\\server\\file-${index}.txt`,
    ...overrides
  };
}

test("reserved delimiters match the native expander contract", () => {
  assert.equal(ATTACHMENT_BLOCK_OPEN, SERVER_BLOCK_OPEN);
  assert.equal(ATTACHMENT_BLOCK_CLOSE, SERVER_BLOCK_CLOSE);
});

for (const method of ["turn/start", "turn/steer", "thread/queue/add"]) {
  test(`expander appends one reference block and strips client fields for ${method}`, () => {
    const file = verifiedFile();
    const expanded = expandChatAttachmentInput({
      method,
      params: {
        input: [{ type: "text", text: "summarize this", text_elements: [] }],
        clientSendId: "send-1",
        draftId: "draft-1",
        attachmentIds: [file.id],
        draftCwd: "C:\\tmp",
        clientUserMessageId: "keep-client-id",
        model: "gpt-5"
      },
      files: [file]
    });

    assert.deepEqual(expanded.input.map(item => item.type), ["text", "text"]);
    assert.equal(expanded.input[0].text, "summarize this");
    assert.equal(expanded.clientSendId, undefined);
    assert.equal(expanded.draftId, undefined);
    assert.equal(expanded.attachmentIds, undefined);
    assert.equal(expanded.draftCwd, undefined);
    assert.equal(expanded.clientUserMessageId, "keep-client-id");
    assert.equal(expanded.model, "gpt-5");

    const block = expanded.input[1].text;
    const payload = payloadOf(block);
    assert.equal(payload.version, 1);
    assert.equal(payload.attachments.length, 1);
    assert.equal(payload.attachments[0].path, file.path);

    const refs = attachmentReferences(block);
    assert.deepEqual(refs, [{
      id: file.id,
      name: "book.xlsx",
      size: file.size,
      mime: XLSX_MIME
    }]);
    assert.ok(!JSON.stringify(refs).includes("Users"));
    assert.equal(
      stripAttachmentReferences(`before ${block} after`),
      "before [Attached files: book.xlsx] after"
    );
  });
}

test("expander supports files-only input without synthesizing file variants", () => {
  const file = verifiedFile();
  const expanded = expandChatAttachmentInput({ method: "turn/start", params: {}, files: [file] });
  assert.deepEqual(expanded.input.map(item => item.type), ["text"]);
  assert.ok(!expanded.input.some(item => item.type === "file" || item.type === "localFile"));
  assert.equal(stripAttachmentReferences(expanded.input[0].text), "[Attached files: book.xlsx]");
});

test("expander preserves existing text and image item order", () => {
  const expanded = expandChatAttachmentInput({
    method: "turn/steer",
    params: {
      input: [
        { type: "text", text: "look at these" },
        { type: "localImage", path: "C:\\Users\\demo\\pictures\\screen.png", detail: "high" },
        { type: "image", fileId: "file-123", detail: "low" }
      ]
    },
    files: [verifiedFile()]
  });

  assert.deepEqual(expanded.input.map(item => item.type), ["text", "localImage", "image", "text"]);
  assert.equal(expanded.input[1].path, "C:\\Users\\demo\\pictures\\screen.png");
  assert.equal(expanded.input[1].detail, "high");
  assert.equal(expanded.input[2].fileId, "file-123");
  assert.equal(expanded.input[2].detail, "low");
  assert.ok(expanded.input[3].text.startsWith(ATTACHMENT_BLOCK_OPEN));
});

test("localImage cannot be used to smuggle a spreadsheet", () => {
  assert.throws(
    () => expandChatAttachmentInput({
      method: "turn/start",
      params: { input: [{ type: "localImage", path: "C:\\tmp\\book.xlsx" }] },
      files: []
    }),
    error => error instanceof ChatAttachmentInputError && error.code === "IMAGE_NOT_IMAGE"
  );
});

test("caller path-like params are rejected instead of reaching native params", () => {
  const fields = [
    "path", "paths", "absolutePath", "filePath", "localPath", "cwd",
    "workingDirectory", "storageKey", "fileIdentity", "digest", "sha256", "files"
  ];
  for (const field of fields) {
    assert.throws(
      () => expandChatAttachmentInput({
        method: "turn/start",
        params: { [field]: "C:\\secret\\workspace\\book.xlsx" },
        files: [verifiedFile()]
      }),
      error => error instanceof ChatAttachmentInputError && error.code === "CALLER_PATH_REJECTED",
      field
    );
  }
});

test("attachment fields are not silently expanded for unsupported methods", () => {
  assert.throws(
    () => expandChatAttachmentInput({ method: "turn/plan", params: { attachmentIds: ["a"] }, files: [] }),
    error => error instanceof ChatAttachmentInputError && error.code === "METHOD_NOT_SUPPORTED"
  );
  assert.throws(
    () => expandChatAttachmentInput({ method: "turn/plan", params: {}, files: [verifiedFile()] }),
    error => error instanceof ChatAttachmentInputError && error.code === "METHOD_NOT_SUPPORTED"
  );
  assert.deepEqual(
    expandChatAttachmentInput({ method: "turn/plan", params: { input: [{ type: "text", text: "ok" }] } }),
    { input: [{ type: "text", text: "ok" }] }
  );
});

test("redaction returns only allowlisted metadata and sanitizes names", () => {
  const first = verifiedFile({ name: "book.xlsx" });
  const second = verifiedFile({ name: "evil<script>&\u0007\u202e.pdf", mime: "application/pdf" });
  const block = expandedBlock({ method: "thread/queue/add", files: [first, second] });

  const refs = attachmentReferences(block);
  assert.equal(refs.length, 2);
  for (const ref of refs) {
    assert.deepEqual(Object.keys(ref).sort(), ["id", "mime", "name", "size"]);
    assert.ok(!Object.hasOwn(ref, "path"));
    assert.ok(!ref.name.includes("<"));
    assert.ok(!ref.name.includes(">"));
    assert.ok(!ref.name.includes("&"));
    assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(ref.name));
    assert.ok(!/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/.test(ref.name));
    assert.ok(Array.from(ref.name).length <= 200);
  }
  assert.equal(refs[0].id, first.id.toLowerCase());
  assert.equal(refs[1].name, "evilscript.pdf");

  const stripped = stripAttachmentReferences(block);
  assert.equal(stripped, "[Attached files: book.xlsx, evilscript.pdf]");
  assert.ok(!stripped.includes("Users"));
  assert.ok(!stripped.includes("workspace"));
});

test("ordinary user text outside blocks is preserved byte-for-byte", () => {
  const file = verifiedFile({ name: "book.xlsx" });
  const block = expandedBlock({ files: [file] });
  const text = `请保留这段中文 😀\n${block}\n后面的普通文字 <b>不解析</b> </codex-webui-attachments-v1>`;
  assert.equal(
    stripAttachmentReferences(text),
    "请保留这段中文 😀\n[Attached files: book.xlsx]\n后面的普通文字 <b>不解析</b> </codex-webui-attachments-v1>"
  );
  assert.equal(attachmentReferences(text).length, 1);

  const noBlocks = "请保留中文 😀 ordinary </codex-webui-attachments-v1> tail";
  assert.equal(stripAttachmentReferences(noBlocks), noBlocks);
  assert.deepEqual(attachmentReferences(noBlocks), []);
});

test("malformed blocks are removed without exposing their JSON", () => {
  const validBlock = expandedBlock({ files: [verifiedFile({ name: "book.xlsx" })] });
  const badBodies = [
    "{not json",
    JSON.stringify({ version: 1, attachments: "nope" }),
    JSON.stringify({ version: 2, attachments: [remoteFile(1)] }),
    JSON.stringify({ version: 1, attachments: [{ ...remoteFile(2), id: "bad" }] }),
    JSON.stringify({ version: 1, attachments: [{ ...remoteFile(3), size: -1 }] }),
    JSON.stringify({ version: 1, attachments: [{ ...remoteFile(4), size: 25 * 1024 * 1024 + 1 }] }),
    JSON.stringify({ version: 1, attachments: [{ ...remoteFile(5), mime: "not-a-mime" }] }),
    JSON.stringify({ version: 1, attachments: [{ ...remoteFile(6), name: "" }] })
  ];

  for (const body of badBodies) {
    const text = `before ${ATTACHMENT_BLOCK_OPEN}\n${body}\n${ATTACHMENT_BLOCK_CLOSE} after`;
    assert.equal(stripAttachmentReferences(text), "before  after");
    assert.deepEqual(attachmentReferences(text), []);
    assert.ok(!stripAttachmentReferences(text).includes("server"));
  }

  const mixed = `before ${fakeBlock(badBodies[0])} middle ${validBlock} after`;
  assert.equal(stripAttachmentReferences(mixed), "before  middle [Attached files: book.xlsx] after");
  assert.deepEqual(attachmentReferences(mixed).map(ref => ref.name), ["book.xlsx"]);
});

test("truncated blocks fail closed to the end without leaking their body", () => {
  const body = JSON.stringify(payloadFor([remoteFile(7)]));
  const text = `keep ${ATTACHMENT_BLOCK_OPEN}\n${body}\nand this must not leak`;
  assert.equal(stripAttachmentReferences(text), "keep ");
  assert.deepEqual(attachmentReferences(text), []);
  assert.ok(!stripAttachmentReferences(text).includes("C:\\\\server"));
});

test("multiple valid blocks are redacted separately and combined safely", () => {
  const first = verifiedFile({ name: "book.xlsx" });
  const second = verifiedFile({ name: "notes.pdf", mime: "application/pdf" });
  const blockA = expandedBlock({ files: [first] });
  const blockB = expandedBlock({ files: [second] });
  const text = `${blockA} middle ${blockB}`;

  assert.equal(
    stripAttachmentReferences(text),
    "[Attached files: book.xlsx] middle [Attached files: notes.pdf]"
  );
  assert.deepEqual(
    attachmentReferences(text).map(ref => ref.name),
    ["book.xlsx", "notes.pdf"]
  );
});

test("a nested reserved start tag invalidates the block", () => {
  const body = `${ATTACHMENT_BLOCK_OPEN}${JSON.stringify(payloadFor([remoteFile(8)]))}`;
  const text = fakeBlock(body);
  assert.equal(stripAttachmentReferences(text), "");
  assert.deepEqual(attachmentReferences(text), []);
});

test("oversized and over-count payloads fail closed", () => {
  const oversized = fakeBlock(" ".repeat(MAX_ATTACHMENT_JSON_CHARS + 1));
  assert.equal(stripAttachmentReferences(oversized), "");
  assert.deepEqual(attachmentReferences(oversized), []);

  const tooMany = {
    version: 1,
    attachments: Array.from({ length: 21 }, (_, index) => remoteFile(index + 1))
  };
  const block = fakeBlock(tooMany);
  assert.equal(stripAttachmentReferences(block), "");
  assert.deepEqual(attachmentReferences(block), []);
});

test("duplicate attachment ids invalidate the whole block", () => {
  const entry = remoteFile(9);
  const block = fakeBlock({ version: 1, attachments: [entry, { ...entry, name: "copy.txt" }] });
  assert.deepEqual(attachmentReferences(block), []);
  assert.equal(stripAttachmentReferences(block), "");
});

test("names are bounded and path separators are never exposed", () => {
  const longName = `${"a".repeat(250)}.xlsx`;
  const longBlock = fakeBlock({
    version: 1,
    attachments: [{ id: "a".repeat(32), name: longName, size: 1, mime: "text/plain" }]
  });
  const longRefs = attachmentReferences(longBlock);
  assert.equal(longRefs.length, 1);
  assert.equal(Array.from(longRefs[0].name).length, 200);

  const pathName = "C:\\Users\\demo\\secret.xlsx";
  const pathBlock = fakeBlock({
    version: 1,
    attachments: [{ id: "b".repeat(32), name: pathName, size: 1, mime: "text/plain" }]
  });
  const pathRefs = attachmentReferences(pathBlock);
  assert.equal(pathRefs[0].name, "C:_Users_demo_secret.xlsx");
  assert.ok(!pathRefs[0].name.includes("\\"));
  assert.ok(!pathRefs[0].name.includes("/"));
  assert.ok(!stripAttachmentReferences(pathBlock).includes("C:\\Users"));
});

test("labels never emit HTML or control characters from payload names", () => {
  const block = fakeBlock({
    version: 1,
    attachments: [{
      id: "c".repeat(32),
      name: "<img src=x onerror=alert(1)>\u0000\u202e.pdf",
      size: 1,
      mime: "text/plain"
    }]
  });
  const refs = attachmentReferences(block);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].name, "img src=x onerror=alert(1).pdf");

  const stripped = stripAttachmentReferences(block);
  assert.equal(stripped, "[Attached files: img src=x onerror=alert(1).pdf]");
  assert.ok(!stripped.includes("<"));
  assert.ok(!stripped.includes(">"));
  assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(stripped));
});

test("non-string input is handled safely", () => {
  assert.equal(stripAttachmentReferences(null), "");
  assert.equal(stripAttachmentReferences(undefined), "");
  assert.equal(stripAttachmentReferences(123), "");
  assert.deepEqual(attachmentReferences(null), []);
  assert.deepEqual(attachmentReferences(123), []);
});
