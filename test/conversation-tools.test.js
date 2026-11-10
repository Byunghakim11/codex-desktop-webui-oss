import test from "node:test";
import assert from "node:assert/strict";
import * as tools from "../public/conversation-tools.js";
import * as workflow from "../public/workflow-tools.js";
import { liveHarness } from "../test-support/workflow-app-harness.js";

const snapshot = (messages, extra = {}) => tools.buildConversationSnapshot({ threadKey: "thread-A", revision: 1, title: "대화", messages, ...extra });
const message = (id, text, extra = {}) => ({ id, role: "assistant", phase: "final", text, ...extra });

test("snapshot accepts ordinary bodies only and preserves stable IDs after prepend", () => {
  const source = [message("a", "완료"), message("b", "현재", { turnId: "live" }),
    message("activity", "숨김", { phase: "commentary" }), message("question", "질문", { delivery: "async" }),
    message("reply", "답변", { role: "user", questionReplies: [] }), message("pending", "...", { pendingReply: true }),
    message("wrapper", "quoted <send_user_message_question_reply>secret</send_user_message_question_reply>"),
    message("tool", "secret", { role: "tool" }), { role: "user", text: "no stable ID" }];
  const result = snapshot(source, { activeTurnId: "live" });
  assert.deepEqual(result.messages.map(m => [m.messageKey, m.incomplete]), [["a", false], ["b", true]]);
  assert.equal(result.loadedMessageCount, 2);
  assert.equal(snapshot([message("older", "old"), ...source]).messages[1].messageKey, "a");
  source[0].text = "mutated";
  assert.equal(result.messages[0].text, "완료");
});
test("native normalized final_answer phase has message and code controls while async stays excluded", () => {
  const env=ui(),final=message("native-final","Final body\n```js\ncode\n```",{phase:"final_answer"}),user=message("u","request",{role:"user"});
  const data=snapshot([user,final,message("native-q","excluded",{phase:"final_answer",delivery:"async"})]);
  assert.equal(data.loadedMessageCount,2);assert.equal(tools.prepareConversationText(data,{purpose:"markdown-export"}).includedMessageCount,2);
  env.setSnapshot(data);const article=env.article("Final body"),pre=env.doc.createElement("pre"),code=env.doc.createElement("code");code.textContent="code\n";pre.append(code);article.querySelector(".bubble").append(pre);env.view.decorateMessage(article,final);
  assert.equal(article.querySelectorAll(".wf-message-copy").length,1);assert.equal(article.querySelectorAll(".wf-code-copy").length,1);env.view.dispose();
});

test("literal search handles Korean, emoji and special characters without regex or duplicate IDs", () => {
  const data = snapshot([message("a", "한글 [.*] 😀 [.*]"), message("a", "한글 [.*] 😀 [.*]")]);
  assert.deepEqual(tools.findConversationMatches(data, "[.*]"), [
    { messageKey: "a", start: 3, end: 7 }, { messageKey: "a", start: 11, end: 15 }
  ]);
  assert.deepEqual(tools.findConversationMatches(data, "😀"), [{ messageKey: "a", start: 8, end: 10 }]);
  assert.equal(tools.findConversationMatches(data, "").length, 0);
  assert.equal(tools.findConversationMatches(data, "absent").length, 0);
  assert.ok(tools.findConversationMatches(snapshot([message("many", "x".repeat(3000))]), "x").length <= 2000);
});

test("copy selects one code block and preserves its whitespace including final newline", () => {
  const data = snapshot([message("a", "Text\n\n````js\n  one\n\n```inside\n````\n\n~~~py\n  two\n~~~", { streamingReply: true })]);
  assert.equal(tools.prepareConversationText(data, { purpose: "code-copy", messageKey: "a", blockIndex: 0 }).text, "  one\n\n```inside\n");
  assert.equal(tools.prepareConversationText(data, { purpose: "code-copy", messageKey: "a", blockIndex: 1 }).text, "  two\n");
  assert.equal(tools.prepareConversationText(data, { purpose: "code-copy", messageKey: "a", blockIndex: 9 }).text, "");
  assert.equal(tools.prepareConversationText(data, { purpose: "message-copy", messageKey: "missing" }).text, "");
});

test("export omits incomplete bodies and masks credentials in body and title", () => {
  const data = snapshot([
    message("u", "URL https://host.test/x?token=hidden&v=1\nAuthorization: Bearer hidden\napi_key=secret-value", { role: "user" }),
    message("a", "Ready\n```txt\ncode\n```"), message("live", "partial", { turnId: "live" })
  ], { activeTurnId: "live", title: "https://host.test/?access_token=hidden" });
  const result = tools.prepareConversationText(data, { purpose: "markdown-export" });
  assert.equal(result.includedMessageCount, 2);
  assert.equal(result.omittedBlockCount, 1);
  assert.ok(result.redactedValueCount >= 4);
  assert.doesNotMatch(result.text, /hidden|secret-value|partial/);
  assert.match(result.text, /## User[\s\S]*## Assistant[\s\S]*```txt\ncode\n```/);
  assert.throws(() => tools.prepareConversationText(data, { purpose: "unknown" }), /purpose/i);
});

test("bookmark store retains only minimal metadata and enforces limit without persistence", () => {
  const store = tools.createBookmarkStore({ limit: 2 });
  assert.equal(store.add({ threadKey: "A", messageKey: "1", title: "Title", role: "user", ordinal: 1, text: "secret" }), true);
  assert.equal(store.add({ threadKey: "A", messageKey: "1", title: "Updated", role: "user", ordinal: 2 }), true);
  assert.equal(store.add({ threadKey: "B", messageKey: "1", title: "Other", role: "assistant", ordinal: 1 }), true);
  assert.equal(store.add({ threadKey: "A", messageKey: "2", title: "Full", role: "user", ordinal: 3 }), false);
  assert.deepEqual(store.list()[0], { threadKey: "A", messageKey: "1", title: "Updated", role: "user", ordinal: 2 });
  store.list()[0].title = "mutated";
  assert.equal(store.list()[0].title, "Updated");
  assert.equal(store.remove("A", "1"), true);
  store.clear(); assert.equal(store.list().length, 0);
  assert.equal(tools.createBookmarkStore().list().length, 0);
});

function dom() {
  const nodes = [];
  const doc = { activeElement: null, createElement(tag) { return new Element(tag); }, createTextNode(data) { return new Text(data); } };
  class Text {
    constructor(data) { this.nodeType = 3; this.data = data; this.parentNode = null; }
    get textContent() { return this.data; }
    get parentElement() { return this.parentNode; }
    replaceWith(...items) { this.parentNode.replace(this, ...items); }
  }
  class Element {
    constructor(tag) { this.nodeType = 1; this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null; this.dataset = {}; this.attrs = {}; this.events = {}; this.className = ""; this.hidden = false; this.value = ""; nodes.push(this); }
    get childNodes() { return this.children; }
    get textContent() { return this.children.map(n => n.textContent).join(""); }
    set textContent(value) { this.children = [new Text(String(value))]; this.children[0].parentNode = this; }
    set innerHTML(_value) { throw new Error("HTML injection is forbidden"); }
    get parentElement() { return this.parentNode; }
    get isConnected() { return this === root || Boolean(this.parentNode?.isConnected); }
    get classList() { return { contains: c => this.className.split(" ").includes(c), toggle: (c, on) => { const classes = new Set(this.className.split(" ").filter(Boolean)); if (on) classes.add(c); else classes.delete(c); this.className = [...classes].join(" "); } }; }
    append(...items) { for (let n of items) { if (typeof n === "string") n = new Text(n); n.remove?.(); n.parentNode = this; this.children.push(n); } }
    replaceChildren(...items) { this.children.forEach(n => { n.parentNode = null; }); this.children = []; this.append(...items); }
    replace(old, ...items) { const index = this.children.indexOf(old); this.children.splice(index, 1, ...items); old.parentNode = null; items.forEach(n => { n.parentNode = this; }); }
    replaceWith(...items) { this.parentNode.replace(this, ...items); }
    remove() { if (this.parentNode) { const parent = this.parentNode; parent.children = parent.children.filter(n => n !== this); this.parentNode = null; } }
    normalize() {}
    setAttribute(k, v) { this.attrs[k] = String(v); }
    getAttribute(k) { return this.attrs[k] ?? null; }
    removeAttribute(k) { delete this.attrs[k]; }
    addEventListener(type, fn) { (this.events[type] ||= []).push(fn); }
    removeEventListener(type, fn) { this.events[type] = (this.events[type] || []).filter(f => f !== fn); }
    async fire(type, extra = {}) { const event = { target: this, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...extra }; for (const fn of this.events[type] || []) await fn(event); return event; }
    click() { return this.disabled ? Promise.resolve() : this.fire("click"); }
    focus() { doc.activeElement = this; }
    scrollIntoView(options) { (this.scrollCalls ||= []).push(options); }
    select() { this.selected = true; }
    showModal() { this.open = true; }
    close() { this.open = false; void this.fire("close"); }
    querySelectorAll(selector) {
      const matches = (node, part) => {
        if (node.nodeType !== 1) return false;
        const [tag, ...classes] = part.split(".");
        return (!tag || node.tagName === tag.toUpperCase()) && classes.every(c => node.className.split(" ").includes(c));
      };
      const result = [];
      const visit = node => { for (const child of node.childNodes || []) { if (selector.split(",").some(part => matches(child, part.trim()))) result.push(child); visit(child); } };
      visit(this); return result;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  }
  const root = doc.createElement("main"), host = doc.createElement("div"); root.append(host);
  const article = text => { const a = doc.createElement("article"), bubble = doc.createElement("div"); bubble.className = "bubble markdown"; bubble.textContent = text; a.append(bubble); root.append(a); return a; };
  return { doc, nodes, root, host, article };
}

function ui(extra = {}) {
  const env = dom(); let current = snapshot([message("a", "Visible 한글"), message("b", "Final")]);
  const feedback = [], downloads = [], reveals = [];
  const view = tools.createConversationTools({ document: env.doc, host: env.host, getSnapshot: () => current,
    revealMessage: (key, scope) => { reveals.push([key, scope]); return "revealed"; }, onFeedback: value => feedback.push(value),
    copyText: async () => {}, downloadText: (text, filename) => downloads.push([text, filename]), ...extra });
  return { ...env, view, feedback, downloads, reveals, setSnapshot(value) { current = value; } };
}

test("conversation rollback removes each feature action and rejects direct openers", async () => {
  const env = ui({ features: { F01:false,F02:false,F03:false,F04:false,F05:false,F06:false } });
  const a = env.article("Visible 한글"), pre=env.doc.createElement("pre"),code=env.doc.createElement("code");code.textContent="code";pre.append(code);a.querySelector(".bubble").append(pre);
  env.view.decorateMessage(a,message("a","Visible 한글"));
  assert.equal(env.host.querySelectorAll(".wf-open-search,.wf-open-outline,.wf-open-export,.wf-open-bookmarks").length,0);
  assert.equal(a.querySelectorAll(".wf-message-copy,.wf-code-copy,.wf-bookmark-add").length,0);
  env.view.openSearch();env.view.openExportPreview();env.view.openOutline();env.view.openBookmarks();
  assert.equal(env.host.querySelector(".wf-conversation-search").hidden,true);assert.equal(env.host.querySelectorAll("dialog").length,0);env.view.dispose();
});
test("conversation dialogs use the external modal host and clean it on disposal", async () => {
  const env=dom(),modalHost=env.doc.createElement("section");env.root.append(modalHost);
  const current=snapshot([message("a","Final body")]);
  const view=tools.createConversationTools({document:env.doc,host:env.host,dialogHost:modalHost,getSnapshot:()=>current,revealMessage:()=>"revealed",copyText:async()=>{throw new Error("denied");}});
  view.openExportPreview();assert.ok(modalHost.querySelector("dialog.wf-export"));
  view.openOutline();assert.ok(modalHost.querySelector("dialog.wf-outline"));view.openBookmarks();assert.ok(modalHost.querySelector("dialog.wf-bookmarks"));
  const article=env.article("Final body");view.decorateMessage(article,message("a","Final body"));await article.querySelector(".wf-message-copy").click();assert.ok(modalHost.querySelector("dialog.wf-copy-fallback"));
  assert.equal(env.host.querySelectorAll("dialog").length,0);view.dispose();assert.equal(modalHost.children.length,0);assert.equal(env.host.children.length,0);
});
test("actual live handler classifications govern message and code decoration", () => {
  for(const metadata of [{phase:"commentary"},{delivery:"async",questions:[{title:"native question",options:[]}]},{phase:"unknown"},{},{phase:"final_answer"}]){
    const h=liveHarness();h.send("item/started",{item:{type:"agentMessage",id:"live",text:"",...metadata}});h.send("item/agentMessage/delta",{itemId:"live",delta:"body\n```js\ncode\n```"});
    const env=ui({getSnapshot:()=>h.snapshot()}),article=env.article("body"),pre=env.doc.createElement("pre"),code=env.doc.createElement("code");code.textContent="code\n";pre.append(code);article.querySelector(".bubble").append(pre);
    env.view.decorateMessage(article,h.state.messages[0]);const expected=metadata.phase==="final_answer"?1:0;
    assert.equal(article.querySelectorAll(".wf-message-copy").length,expected);assert.equal(article.querySelectorAll(".wf-code-copy").length,expected);env.view.dispose();
  }
});
test("large actual decoration/update builds one immutable snapshot per revision", () => {
  const messages=Array.from({length:1000},(_,i)=>message(`m${i}`,`Body ${i}`));
  let source={threadKey:"A",revision:1,title:"A",messages},builds=0;
  const build=input=>{builds++;return tools.buildConversationSnapshot(input);};
  const cache=workflow.createConversationSnapshotCache({getInput:()=>source,build});
  const env=ui({getSnapshot:()=>cache.get()});
  for(const msg of messages)env.view.decorateMessage(env.article(msg.text),msg);
  env.view.update();assert.equal(builds,1);
  env.view.update();assert.equal(builds,1);
  source={...source,revision:2};env.view.update();assert.equal(builds,2);env.view.dispose();
});

test("export dialog requires explicit confirmation and invalidates changed thread/revision", async () => {
  const env = ui(); env.view.openExportPreview();
  assert.equal(env.downloads.length, 0);
  assert.match(env.host.querySelector(".wf-export-summary").textContent, /2/);
  env.setSnapshot(snapshot([message("new", "Other")], { threadKey: "B", revision: 2 })); env.view.update();
  const confirm = env.host.querySelector(".wf-export-confirm");
  assert.equal(confirm.disabled, true); await confirm.click(); assert.equal(env.downloads.length, 0);
  env.view.openExportPreview(); await env.host.querySelector(".wf-export-confirm").click();
  assert.equal(env.downloads.length, 1); assert.match(env.downloads[0][0], /Other/);
  env.view.dispose(); assert.equal(env.host.children.length, 0);
});
test("Markdown download uses a generic timestamped filename without conversation metadata",async()=>{
  const env=ui({now:()=>Date.UTC(2026,10,10,1,2,3,4)});env.view.openExportPreview();await env.host.querySelector(".wf-export-confirm").click();
  assert.equal(env.downloads[0][1],"conversation-2026-11-10T01-02-03-004Z.md");env.view.dispose();
});

test("denied clipboard provides selectable fallback without retry; malicious markup stays inert", async () => {
  let attempts = 0; const env = ui({ copyText: async () => { attempts++; throw new Error("denied"); } });
  const raw = message("evil", "<img src=x onerror=alert(1)>\n\n```js\n  exact\n```", { role: "user" });
  env.setSnapshot(snapshot([raw]));
  const article = env.article(raw.text), pre = env.doc.createElement("pre"), code = env.doc.createElement("code"); code.textContent = "  exact\n"; pre.append(code); article.querySelector(".bubble").append(pre);
  env.view.decorateMessage(article, raw); await article.querySelector(".wf-message-copy").click();
  assert.equal(attempts, 1);
  const fallback = env.host.querySelector(".wf-copy-fallback-text"); assert.match(fallback.value, /<img/); assert.equal(fallback.readOnly, true); assert.equal(fallback.selected, true);
  env.host.querySelector(".wf-copy-fallback").close(); await article.querySelector(".wf-code-copy").click();
  assert.equal(attempts, 2); assert.equal(env.host.querySelector(".wf-copy-fallback-text").value, "  exact\n");
});

test("search highlights visible text safely and Escape is scoped to its input and IME", async () => {
  const env = ui(); const raw = message("a", "Visible 한글"); const article = env.article(raw.text);
  env.view.decorateMessage(article, raw); env.view.openSearch();
  const input = env.host.querySelector(".wf-search-input"); input.value = "한글"; await input.fire("input");
  assert.equal(article.querySelectorAll("mark.wf-search-highlight").length, 1);
  assert.match(env.host.querySelector(".wf-search-count").textContent, /1/);
  await env.host.querySelector(".wf-search-next").click(); assert.equal(env.reveals[0][0], "a");
  await input.fire("keydown", { key: "Escape", isComposing: true }); assert.equal(input.value, "한글");
  const event = await input.fire("keydown", { key: "Escape" }); assert.equal(event.defaultPrevented, true); assert.equal(input.value, "");
  assert.equal(article.querySelectorAll("mark.wf-search-highlight").length, 0);
  assert.equal(article.querySelector(".bubble").textContent, "Visible 한글");
});

test("bookmarks never reveal another thread; outline updates without duplicates", async () => {
  const env = ui(); const raw = message("a", "Visible 한글"); const article = env.article(raw.text); env.view.decorateMessage(article, raw);
  await article.querySelector(".wf-bookmark-add").click(); env.view.openBookmarks();
  assert.doesNotMatch(env.host.querySelector(".wf-bookmark-list").textContent, /Visible 한글/);
  await env.host.querySelector(".wf-bookmark-jump").click(); assert.equal(env.reveals.length, 1);
  env.setSnapshot(snapshot([message("other", "Other")], { threadKey: "B" })); env.view.update(); env.view.openBookmarks();
  assert.equal(env.host.querySelector(".wf-bookmark-jump").disabled, true);
  await env.host.querySelector(".wf-bookmark-jump").click(); assert.equal(env.reveals.length, 1);
  env.view.openOutline(); assert.equal(env.host.querySelectorAll(".wf-outline-jump").length, 1);
  env.view.update(); assert.equal(env.host.querySelectorAll(".wf-outline-jump").length, 1);
});

test("copy completion and old message controls do not act in a changed conversation", async () => {
  let finish, copied = 0;
  const env = ui({ copyText: () => { copied++; return new Promise(resolve => { finish = resolve; }); } });
  const raw = message("a", "Visible 한글"), article = env.article(raw.text); env.view.decorateMessage(article, raw);
  const pending = article.querySelector(".wf-message-copy").click();
  env.setSnapshot(snapshot([message("a", "Other thread")], { threadKey: "B" })); env.view.update(); finish(); await pending;
  assert.equal(env.feedback.length, 0);
  await article.querySelector(".wf-message-copy").click(); assert.equal(copied, 1);
});

test("code copy uses clicked rendered block in lists and captures streaming text immediately", async () => {
  const copied = []; const env = ui({ copyText: async text => copied.push(text) });
  const raw = message("a", "- example\n\n    ```js\n    kept\n    ```", { streamingReply: true }); env.setSnapshot(snapshot([raw]));
  const article = env.article("example"), pre = env.doc.createElement("pre"), code = env.doc.createElement("code"); code.textContent = "kept\n"; pre.append(code); article.querySelector(".bubble").append(pre);
  env.view.decorateMessage(article, raw); const pending = article.querySelector(".wf-code-copy").click();
  code.textContent = "kept\nlate\n"; await pending;
  assert.deepEqual(copied, ["kept\n"]);
});

test("export closes an unfinished fence and redacts encoded URL credentials and PEM keys", () => {
  const data = snapshot([message("a", "```txt\nhttps://host/x?access%5Ftoken=hidden\n-----BEGIN PRIVATE KEY-----\nprivate\n-----END PRIVATE KEY-----")]);
  const result = tools.prepareConversationText(data, { purpose: "markdown-export" });
  assert.doesNotMatch(result.text, /hidden|private/); assert.match(result.text, /\n```\n/); assert.equal(result.redactedValueCount, 2);
});

test("bookmark identities are rejected rather than truncated into a different anchor", () => {
  const store = tools.createBookmarkStore();
  assert.equal(store.add({ threadKey: "A", messageKey: "x".repeat(513), title: "T", role: "user", ordinal: 1 }), false);
  assert.equal(store.list().length, 0);
});

test("prepending loaded messages preserves the selected search match by message ID", async () => {
  const env = ui(), first = message("a", "needle"), second = message("b", "needle"); env.setSnapshot(snapshot([first, second]));
  env.view.decorateMessage(env.article(first.text), first); env.view.decorateMessage(env.article(second.text), second); env.view.openSearch();
  const input = env.host.querySelector(".wf-search-input"); input.value = "needle"; await input.fire("input");
  await env.host.querySelector(".wf-search-next").click(); assert.equal(env.reveals.at(-1)[0], "b");
  const older = message("old", "needle"); env.setSnapshot(snapshot([older, first, second], { revision: 2 })); env.view.decorateMessage(env.article(older.text), older); env.view.update();
  assert.match(env.host.querySelector(".wf-search-count").textContent, /3 \/ 3/);
  await env.host.querySelector(".wf-search-prev").click(); assert.equal(env.reveals.at(-1)[0], "a");
});

test("export reports rejected wrapper and identity counts without retaining their payload", () => {
  const data = snapshot([message("ok", "safe"), message("wrapper", "<tool_result>payload</tool_result>"), { role: "user", text: "unstable payload" }, message("live", "incomplete", { streamingReply: true })]);
  const exported = tools.prepareConversationText(data, { purpose: "markdown-export" });
  assert.equal(exported.omittedBlockCount, 3);
  assert.doesNotMatch(JSON.stringify(data), /payload/);
});

test("export preview freezes mutable adapter data and invalidates title changes", async () => {
  const data = { threadKey: "A", revision: 1, title: "Before", loadedMessageCount: 1, messages: [{ messageKey: "a", text: "Before body", role: "user", ordinal: 1, incomplete: false }] };
  const env = ui({ getSnapshot: () => data }); env.view.openExportPreview(); data.messages[0].text = "After body";
  await env.host.querySelector(".wf-export-confirm").click(); assert.equal(env.downloads.length, 0);
  env.view.openExportPreview(); data.title = "After title"; env.view.update(); assert.equal(env.host.querySelector(".wf-export-confirm").disabled, true);
});

test("prefixed environment secrets and unsafe title wrappers are masked or omitted", () => {
  const data = snapshot([message("a", "OPENAI_API_KEY=hidden1\nAWS_SECRET_ACCESS_KEY='hidden2'\nTOKEN=hidden3")], { title: "<tool_result>hidden title</tool_result>" });
  const exported = tools.prepareConversationText(data, { purpose: "markdown-export" });
  assert.doesNotMatch(exported.text, /hidden|tool_result/); assert.equal(exported.redactedValueCount, 3);
});

test("copy helper defends its allowlist even against an incorrectly assembled snapshot", () => {
  const exported = tools.prepareConversationText({ title: "Test", messages: [{ role: "tool", messageKey: "x", text: "hidden payload" }] }, { purpose: "markdown-export" });
  assert.equal(exported.includedMessageCount, 0); assert.equal(exported.omittedBlockCount, 1); assert.doesNotMatch(exported.text, /hidden payload/);
});

test("export preparation never displays a native-wrapper title or token-bearing title", () => {
  const env = ui(); env.setSnapshot(snapshot([message("a", "safe")], { title: "<tool_result>hidden payload</tool_result>" })); env.view.openExportPreview();
  assert.doesNotMatch(env.host.querySelector(".wf-export-title").textContent, /hidden|tool_result/);
  env.setSnapshot(snapshot([message("a", "safe")], { title: "https://host.test/?token=hidden" })); env.view.openExportPreview();
  assert.doesNotMatch(env.host.querySelector(".wf-export-title").textContent, /hidden/);
});

test("search navigates to the active occurrence within a long message and retains its control focus", async () => {
  const env = ui(), raw = message("a", `needle\n${"padding\n".repeat(100)}needle`), article = env.article(raw.text);
  env.setSnapshot(snapshot([raw])); env.view.decorateMessage(article, raw); env.view.openSearch();
  const input = env.host.querySelector(".wf-search-input"); input.value = "needle"; await input.fire("input");
  const next = env.host.querySelector(".wf-search-next"); next.focus(); await next.click();
  let active = article.querySelector("mark.wf-search-current");
  assert.equal(active.dataset.matchIndex, "1"); assert.equal(active.scrollCalls?.length, 1); assert.equal(env.doc.activeElement, next);
  const previous = env.host.querySelector(".wf-search-prev"); previous.focus(); await previous.click();
  active = article.querySelector("mark.wf-search-current"); assert.equal(active.dataset.matchIndex, "0"); assert.equal(active.scrollCalls?.length, 1); assert.equal(env.doc.activeElement, previous);
  input.focus(); await input.fire("keydown", { key: "Enter" });
  assert.equal(article.querySelector("mark.wf-search-current").scrollCalls?.length, 1); assert.equal(env.doc.activeElement, input);
  assert.equal(env.reveals.length, 3);
});

test("search preserves semantic paragraph, break and cell boundaries while matching contiguous inline nodes", async () => {
  const env = ui(), raw = message("a", "rendered body"), article = env.article(""); env.setSnapshot(snapshot([raw]));
  const bubble = article.querySelector(".bubble");
  const p = env.doc.createElement("p"), strong = env.doc.createElement("strong"), p2 = env.doc.createElement("p"), br = env.doc.createElement("br");
  strong.textContent = "st"; p.append(env.doc.createTextNode("fir"), strong); p2.append(env.doc.createTextNode("second"), br, env.doc.createTextNode("third"));
  const table = env.doc.createElement("table"), row = env.doc.createElement("tr"), cell1 = env.doc.createElement("td"), cell2 = env.doc.createElement("td"); cell1.textContent = "left"; cell2.textContent = "right"; row.append(cell1, cell2); table.append(row); bubble.append(p, p2, table);
  env.view.decorateMessage(article, raw); env.view.openSearch(); const input = env.host.querySelector(".wf-search-input");
  for (const query of ["firstsecond", "secondthird", "leftright"]) {
    input.value = query; await input.fire("input"); assert.equal(env.host.querySelector(".wf-search-count").textContent, "0건"); assert.equal(article.querySelectorAll("mark.wf-search-highlight").length, 0);
  }
  input.value = "first"; await input.fire("input");
  assert.match(env.host.querySelector(".wf-search-count").textContent, /1 \/ 1/); assert.deepEqual(article.querySelectorAll("mark.wf-search-highlight").map(mark => mark.textContent), ["fir", "st"]);
  input.value = "third"; await input.fire("input"); assert.equal(article.querySelector("mark.wf-search-highlight").textContent, "third");
  assert.equal(env.reveals.length, 0);
});

test("a late search reveal cannot scroll an older occurrence after a newer selection", async () => {
  const pending = []; const env = ui({ revealMessage: () => new Promise(resolve => pending.push(resolve)) });
  const raw = message("a", "needle needle needle"), article = env.article(raw.text); env.setSnapshot(snapshot([raw])); env.view.decorateMessage(article, raw); env.view.openSearch();
  const input = env.host.querySelector(".wf-search-input"); input.value = "needle"; await input.fire("input"); input.focus();
  const first = env.host.querySelector(".wf-search-next").click(), second = env.host.querySelector(".wf-search-next").click();
  pending[1]("revealed"); await second; assert.equal(article.querySelector("mark.wf-search-current").dataset.matchIndex, "2");
  const active = article.querySelector("mark.wf-search-current"), count = active.scrollCalls?.length;
  assert.equal(count, 1);
  pending[0]("revealed"); await first; assert.equal(active.scrollCalls?.length, count); assert.equal(env.doc.activeElement, input);
});
