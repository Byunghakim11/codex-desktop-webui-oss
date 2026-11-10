// These tools consume already-loaded ordinary message bodies only. No persistence,
// transport, native interaction payloads, or HTML parsing belongs in this module.
const MAX_MESSAGES = 10000;
const MAX_BODY = 250000;
const MAX_TOTAL = 2000000;
const MAX_MATCHES = 2000;
const INTERNAL_WRAPPER = /<\/?(?:send_user_message_question_reply|request_user_input(?:_async)?|system(?:_reminder)?|developer|assistant|analysis|thinking|reasoning|commentary|tool(?:_call|_result|_response)?|function_calls?|invoke|approval(?:_request)?|permission(?:_request)?|app[_-]context|environment_context|instructions|mcp[_:-][\w:-]*)\b|\[im_(?:start|end)\]|<\|(?:im_start|im_end|start_header_id|end_header_id)\|>/i;

function allowed(message) {
  return message && (message.role === "user" || message.role === "assistant")
    && (typeof message.id === "string" || typeof message.id === "number") && String(message.id).length > 0 && String(message.id).length <= 512
    && !message.kind && !message.pendingReply && message.delivery !== "async"
    && message.questions == null && message.questionReplies == null
    && (message.role !== "assistant" || (!message.classificationPending && (!message.streamingReply || ["final", "final_answer"].includes(message.phase))))
    && (message.role !== "assistant" || message.phase == null || message.phase === "final" || message.phase === "final_answer" || message.phase === "unknown")
    && typeof message.text === "string" && message.text.trim().length > 0 && message.text.length <= MAX_BODY
    && !INTERNAL_WRAPPER.test(message.text);
}

export function buildConversationSnapshot({ threadKey, revision, messages = [], activeTurnId, title = "" } = {}) {
  const entries = [], seen = new Set(), omittedReasons = { filtered: 0, unstableIdentity: 0, unsafeWrapper: 0, bounds: 0, duplicate: 0 };
  let total = 0;
  const source = Array.isArray(messages) ? messages : [];
  omittedReasons.bounds += Math.max(0, source.length - MAX_MESSAGES);
  for (let index = 0; index < Math.min(source.length, MAX_MESSAGES); index++) {
    const message = source[index];
    if (!allowed(message)) {
      const reason = INTERNAL_WRAPPER.test(message?.text || "") ? "unsafeWrapper" : !message?.id || String(message.id).length > 512 ? "unstableIdentity" : typeof message.text === "string" && message.text.length > MAX_BODY ? "bounds" : "filtered";
      omittedReasons[reason]++; continue;
    }
    if (seen.has(String(message.id))) { omittedReasons.duplicate++; continue; }
    if (total + message.text.length > MAX_TOTAL) { omittedReasons.bounds += Math.min(source.length, MAX_MESSAGES) - index; break; }
    seen.add(String(message.id)); total += message.text.length;
    entries.push(Object.freeze({
      messageKey: String(message.id), role: message.role, text: message.text, ordinal: entries.length + 1,
      incomplete: message.role === "assistant" && Boolean(message.streamingReply || (activeTurnId && message.turnId === activeTurnId))
    }));
  }
  return Object.freeze({ threadKey: String(threadKey || ""), revision, title: String(title).slice(0, 500), loadedMessageCount: entries.length, messages: Object.freeze(entries),
    omittedMessageCount: Object.values(omittedReasons).reduce((sum, count) => sum + count, 0), omittedReasons: Object.freeze(omittedReasons) });
}

export function findConversationMatches(snapshot, query) {
  // Offsets are UTF-16 offsets, matching DOM Text/Range offsets. Do not split a
  // surrogate pair, and do not interpret punctuation as regular expressions.
  if (typeof query !== "string" || !query || query.length > 256 || !query.isWellFormed()) return [];
  const matches = [];
  for (const message of snapshot?.messages || []) {
    const text = String(message.text || "").slice(0, MAX_BODY);
    let start = 0;
    while ((start = text.indexOf(query, start)) !== -1) {
      matches.push({ messageKey: message.messageKey, start, end: start + query.length });
      if (matches.length >= MAX_MATCHES) return matches;
      start += query.length;
    }
  }
  return matches;
}

function codeBlocks(text) {
  const lines = text.match(/[^\n]*(?:\n|$)/g)?.filter(Boolean) || [];
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const opening = lines[i].match(/^ {0,3}(`{3,}|~{3,})([^\r\n]*)\r?\n?$/);
    if (opening && !(opening[1][0] === "`" && opening[2].includes("`"))) {
      const marker = opening[1], body = [];
      let closed = false;
      for (i++; i < lines.length; i++) {
        const close = lines[i].match(/^ {0,3}(`+|~+)[ \t]*\r?\n?$/);
        if (close && close[1][0] === marker[0] && close[1].length >= marker.length) { closed = true; break; }
        body.push(lines[i]);
      }
      blocks.push({ text: body.join(""), closed, marker });
    } else if (/^(?: {4}|\t)\S|^ {4}[^\r\n]/.test(lines[i]) && (i === 0 || !lines[i - 1].trim())) {
      const body = [];
      for (; i < lines.length && (/^(?: {4}|\t)/.test(lines[i]) || !lines[i].trim()); i++) body.push(lines[i].replace(/^(?: {4}|\t)/, ""));
      while (body.length && !body.at(-1).trim()) body.pop();
      blocks.push({ text: body.join(""), closed: true }); i--;
    }
  }
  return blocks;
}

function maskSecrets(source) {
  let count = 0;
  const redact = () => { count++; return "[REDACTED]"; };
  let text = String(source).replace(/https?:\/\/[^\s<>"'`]+/gi, url => {
    let decoded; try { decoded = decodeURIComponent(url); } catch { decoded = url; }
    if (/(?:[?&#;](?:[^=&#;]*(?:token|secret|password|passwd|api[_-]?key|authorization|credential|signature|sig)|key|auth)=)|https?:\/\/[^/]*@|\b(?:sk|ghp|github_pat)[_-][\w-]{8,}/i.test(decoded)) return redact();
    return url;
  });
  text = text.replace(/\b(?:authorization|proxy-authorization)\s*:[^\r\n]+/gi, redact);
  text = text.replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/gi, redact);
  text = text.replace(/(["']?(?:[A-Za-z][A-Za-z0-9_-]*[_-])?(?:api[_-]?key|access[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|client[_-]?secret|auth[_-]?token|secret[_-]?key|session[_-]?token|token|secret|authorization)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/gi, (_whole, label) => `${label}${redact()}`);
  text = text.replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{12,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, redact);
  text = text.replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\r\n]*PRIVATE KEY-----|$)/g, redact);
  return { text, count };
}

function closeOpenFence(text) {
  const last = codeBlocks(text).at(-1);
  return last && !last.closed ? `${text}${text.endsWith("\n") ? "" : "\n"}${last.marker}\n` : text;
}

export function prepareConversationText(snapshot, { purpose, messageKey, blockIndex } = {}) {
  if (!["message-copy", "code-copy", "markdown-export"].includes(purpose)) throw new Error("Unknown conversation text purpose");
  const exporting = purpose === "markdown-export";
  const result = { text: "", includedMessageCount: 0, omittedBlockCount: exporting ? snapshot?.omittedMessageCount || 0 : 0, redactedValueCount: 0 };
  const bodies = [];
  for (const message of snapshot?.messages || []) {
    if (!exporting && message.messageKey !== messageKey) continue;
    if (!["user", "assistant"].includes(message.role) || typeof message.messageKey !== "string" || typeof message.text !== "string" || message.text.length > MAX_BODY || message.delivery === "async" || message.questions != null || message.questionReplies != null || message.kind || message.pendingReply || (message.phase != null && message.phase !== "final" && message.phase !== "unknown") || INTERNAL_WRAPPER.test(message.text) || (exporting && message.incomplete)) { result.omittedBlockCount++; continue; }
    let text = message.text;
    if (purpose === "code-copy") {
      if (!Number.isInteger(blockIndex) || blockIndex < 0) continue;
      const block = codeBlocks(text)[blockIndex]; if (!block) continue;
      text = block.text;
    }
    const masked = maskSecrets(text);
    result.redactedValueCount += masked.count;
    bodies.push(exporting ? `## ${message.role === "user" ? "User" : "Assistant"}\n\n${closeOpenFence(masked.text)}` : masked.text);
    result.includedMessageCount++;
  }
  if (exporting) {
    const rawHeading = String(snapshot?.title || "Conversation").replace(/[\r\n]/g, " ");
    const heading = maskSecrets(INTERNAL_WRAPPER.test(rawHeading) ? "Conversation" : rawHeading);
    result.redactedValueCount += heading.count;
    result.text = `# ${heading.text}\n\n${bodies.join("\n\n")}\n`;
  } else result.text = bodies.join("\n\n");
  return result;
}

export function createBookmarkStore({ limit = 100 } = {}) {
  const entries = new Map(), maximum = Number.isInteger(limit) ? Math.max(0, Math.min(100, limit)) : 100;
  const keyFor = (threadKey, messageKey) => JSON.stringify([threadKey, messageKey]);
  return {
    add(entry) {
      if (!entry || typeof entry.threadKey !== "string" || !entry.threadKey || entry.threadKey.length > 512 || typeof entry.messageKey !== "string" || !entry.messageKey || entry.messageKey.length > 512 || !["user", "assistant"].includes(entry.role) || !Number.isInteger(entry.ordinal) || entry.ordinal < 1) return false;
      const key = keyFor(entry.threadKey, entry.messageKey);
      if (!entries.has(key) && entries.size >= maximum) return false;
      entries.set(key, { threadKey: entry.threadKey, messageKey: entry.messageKey, title: String(entry.title || "").slice(0, 500), role: entry.role, ordinal: entry.ordinal });
      return true;
    },
    list() { return [...entries.values()].map(entry => ({ ...entry })); },
    remove(threadKey, messageKey) { return entries.delete(keyFor(threadKey, messageKey)); },
    clear() { entries.clear(); }
  };
}

let viewSequence = 0;

export function createConversationTools({ document: doc = globalThis.document, host, dialogHost = host, getSnapshot, revealMessage,
  t, onFeedback = () => {}, copyText = text => globalThis.navigator.clipboard.writeText(text), downloadText, features = {}, now = Date.now } = {}) {
  if (!doc || !host || typeof getSnapshot !== "function" || typeof revealMessage !== "function") throw new Error("Conversation tools need document, host, getSnapshot and revealMessage");
  const id = ++viewSequence, bookmarks = createBookmarkStore(), articles = new Map(), owned = [], dialogs = new Map();
  let disposed = false, searchQuery = "", matches = [], matchIndex = -1, searchThread = null, searchJumpSequence = 0, preview = null, outlineKey = null;
  const label = (key, fallback, params) => { const translated = t?.(`wf.${key}`, params); return translated && translated !== `wf.${key}` ? translated : fallback; };
  const make = (tag, className, text) => { const node = doc.createElement(tag); node.className = className; if (text !== undefined) node.textContent = text; return node; };
  const button = (className, text, action) => { const node = make("button", className, text); node.type = "button"; node.addEventListener("click", action); return node; };
  const feedback = text => { if (!disposed) onFeedback(text); };
  const current = () => getSnapshot();
  const snapshotEntries = new WeakMap();
  const entryFor = (snapshot, key) => {
    if (!snapshot || !Object.isFrozen(snapshot) || !Object.isFrozen(snapshot.messages)) return snapshot?.messages?.find(message => message.messageKey === key);
    if (!snapshotEntries.has(snapshot)) snapshotEntries.set(snapshot, new Map(snapshot.messages.map(message => [message.messageKey, message])));
    return snapshotEntries.get(snapshot).get(key);
  };
  const scopeCurrent = (scope, key) => { const snapshot = current(); return !disposed && snapshot?.threadKey === scope && Boolean(entryFor(snapshot, key)); };
  const roleLabel = role => role === "user" ? label("user", "사용자") : label("assistant", "최종 답변");
  const outsideLabel = () => label("outsideLoaded", "현재 로드 범위 밖");
  const maskingNote = () => label("maskingNote", "알려진 비밀값 패턴을 마스킹합니다. 패턴 검사로 모든 비밀값을 식별할 수는 없습니다. 공유 전 내용을 확인하세요.");
  function own(node, target = host) { target.append(node); owned.push(node); return node; }

  function closeDialog(dialog, restore = true) {
    dialog.restoreFocus = restore;
    if (dialog.open) dialog.close();
  }
  function openDialog(name, title, opener = doc.activeElement) {
    for (const other of dialogs.values()) closeDialog(other, false);
    let dialog = dialogs.get(name);
    if (!dialog) {
      dialog = own(make("dialog", `wf-dialog wf-${name}`), dialogHost); dialogs.set(name, dialog);
      dialog.addEventListener("close", () => {
        // The native close event is queued. Ignore an old close if the same
        // dialog has already been explicitly reopened in this task.
        if (dialog.open) return;
        if (name === "export") preview = null;
        if (dialog.restoreFocus !== false && dialog.opener?.isConnected) dialog.opener.focus({ preventScroll: true });
      });
    }
    dialog.replaceChildren(); dialog.opener = opener; dialog.restoreFocus = true;
    const heading = make("h2", "wf-dialog-title", title); heading.id = `wf-dialog-${id}-${name}`;
    dialog.setAttribute("aria-labelledby", heading.id);
    const close = button("wf-dialog-close", label("close", "닫기"), () => closeDialog(dialog));
    dialog.append(heading, close); dialog.showModal(); return dialog;
  }

  const toolbar = own(make("div", "wf-conversation-toolbar")); toolbar.setAttribute("role", "toolbar"); toolbar.setAttribute("aria-label", label("tools", "대화 도구"));
  for (const [feature,css,key,fallback,run] of [["F01","wf-open-search","search","본문 검색",openSearch],["F06","wf-open-outline","outline","대화 개요",openOutline],["F05","wf-open-bookmarks","bookmarks","북마크",openBookmarks],["F04","wf-open-export","export","Markdown 내보내기",openExportPreview]]) if(features[feature]!==false)toolbar.append(button(css,label(key,fallback),run));
  const search = own(make("section", "wf-conversation-search")); search.hidden = true; search.setAttribute("role", "search"); search.setAttribute("aria-label", label("search", "본문 검색"));
  const searchInput = make("input", "wf-search-input"); searchInput.type = "search"; searchInput.maxLength = 256; searchInput.setAttribute("aria-label", label("searchQuery", "현재 로드된 대화 검색"));
  const loadedCount = make("p", "wf-search-loaded"), matchCount = make("output", "wf-search-count"); matchCount.setAttribute("aria-live", "polite");
  const previous = button("wf-search-prev", label("previous", "이전 일치"), () => jumpMatch(-1));
  const next = button("wf-search-next", label("next", "다음 일치"), () => jumpMatch(1));
  search.append(searchInput, loadedCount, matchCount, previous, next, button("wf-search-close", label("closeSearch", "검색 닫기"), () => { search.hidden = true; searchQuery = ""; searchInput.value = ""; clearHighlights(); toolbar.querySelector(".wf-open-search")?.focus(); }));
  if(features.F01!==false){
  searchInput.addEventListener("input", () => { searchQuery = searchInput.value; matches = []; matchIndex = -1; refreshSearch(); });
  searchInput.addEventListener("keydown", event => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); searchInput.value = ""; searchQuery = ""; matchIndex = -1; refreshSearch(); }
    if (event.key === "Enter") { event.preventDefault(); return jumpMatch(event.shiftKey ? -1 : 1); }
  });
  }

  function clearHighlights() {
    for (const { article } of articles.values()) {
      for (const mark of article.querySelectorAll("mark.wf-search-highlight")) { const parent = mark.parentNode; mark.replaceWith(...mark.childNodes); parent?.normalize(); }
    }
  }
  function renderedTextMap(article) {
    const bubble = article.querySelector(".bubble.markdown"), segments = [];
    const blocks = new Set(["ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DD", "DETAILS", "DIV", "DL", "DT", "FIGCAPTION", "FIGURE", "FOOTER", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HR", "LI", "MAIN", "NAV", "OL", "P", "PRE", "SECTION", "SUMMARY", "TABLE", "TBODY", "TD", "TFOOT", "TH", "THEAD", "TR", "UL"]);
    let text = "";
    const boundary = (lineBreak = false) => {
      if (text.length < MAX_BODY && (lineBreak || (text && !text.endsWith("\n")))) text += "\n";
    };
    const visit = node => {
      if (text.length >= MAX_BODY) return;
      if (node.nodeType === 3) {
        const value = node.data.slice(0, MAX_BODY - text.length), start = text.length;
        if (value) { text += value; segments.push({ node, start, end: text.length }); }
        return;
      }
      if (node.nodeType !== 1 || node.hidden || node.getAttribute("aria-hidden") === "true" || ["BUTTON", "SCRIPT", "STYLE", "TEXTAREA"].includes(node.tagName)) return;
      if (node.tagName === "BR") { boundary(true); return; }
      const block = blocks.has(node.tagName);
      if (block) boundary();
      for (const child of node.childNodes) { visit(child); if (text.length >= MAX_BODY) break; }
      if (block) boundary();
    };
    if (bubble) visit(bubble); return { text, segments };
  }
  function searchableSnapshot(snapshot) {
    return { ...snapshot, messages: snapshot.messages.map(message => {
      const view = articles.get(message.messageKey);
      // The rendered text is authoritative for UI matching: Markdown syntax,
      // link destinations and action labels are never counted as visible hits.
      return { ...message, text: view?.threadKey === snapshot.threadKey && view.article.isConnected ? renderedTextMap(view.article).text : "" };
    }) };
  }
  function applyHighlights() {
    const snapshot = current();
    for (const [key, view] of articles) {
      if (view.threadKey !== snapshot.threadKey || !view.article.isConnected) continue;
      const local = matches.map((match, index) => ({ ...match, index })).filter(match => match.messageKey === key);
      for (const { node, start: offset, end } of renderedTextMap(view.article).segments) {
        const ranges = local.filter(match => match.start < end && match.end > offset);
        if (ranges.length) {
          const parts = []; let cursor = 0;
          for (const match of ranges) {
            const from = Math.max(0, match.start - offset), to = Math.min(node.data.length, match.end - offset);
            if (from > cursor) parts.push(doc.createTextNode(node.data.slice(cursor, from)));
            const mark = make("mark", `wf-search-highlight${match.index === matchIndex ? " wf-search-current" : ""}`, node.data.slice(from, to));
            mark.dataset.matchIndex = String(match.index); parts.push(mark); cursor = to;
          }
          if (cursor < node.data.length) parts.push(doc.createTextNode(node.data.slice(cursor)));
          node.replaceWith(...parts);
        }
      }
    }
  }
  function refreshSearch() {
    if (disposed) return;
    clearHighlights(); const snapshot = current();
    let selected = matches[matchIndex];
    if (searchThread !== snapshot.threadKey) { searchThread = snapshot.threadKey; matchIndex = -1; selected = null; }
    loadedCount.textContent = label("loadedMessages", `현재 로드된 메시지 ${snapshot.loadedMessageCount}개`, { count: snapshot.loadedMessageCount });
    matches = search.hidden ? [] : findConversationMatches(searchableSnapshot(snapshot), searchQuery);
    if (selected) matchIndex = matches.findIndex(match => match.messageKey === selected.messageKey && match.start === selected.start && match.end === selected.end);
    if (matchIndex >= matches.length) matchIndex = -1;
    if (matches.length && matchIndex < 0) matchIndex = 0;
    matchCount.textContent = matches.length ? label("matchCount", `${matchIndex + 1} / ${matches.length}${matches.length === MAX_MATCHES ? "+" : ""}`, { current: matchIndex + 1, total: matches.length }) : label("noMatches", "0건");
    previous.disabled = next.disabled = !matches.length;
    if (matches.length) applyHighlights();
  }
  async function reveal(key, threadKey, { focusTarget = true } = {}) {
    if (!scopeCurrent(threadKey, key)) { feedback(outsideLabel()); return "not-loaded"; }
    let status;
    try { status = await revealMessage(key, { threadKey }); } catch { status = "stale"; }
    if (!scopeCurrent(threadKey, key)) return "stale";
    if (status !== "revealed") { feedback(status === "not-loaded" ? outsideLabel() : label("stale", "대화가 변경되었습니다. 다시 선택하세요.")); return status; }
    const article = articles.get(key)?.article;
    if (focusTarget && article?.isConnected) {
      for (const view of articles.values()) view.article.classList.toggle("wf-message-target", view.article === article);
      article.setAttribute("tabindex", "-1"); article.focus({ preventScroll: true });
    }
    return status;
  }
  async function jumpMatch(direction) {
    if (!matches.length) return;
    matchIndex = matchIndex < 0 ? (direction < 0 ? matches.length - 1 : 0) : (matchIndex + direction + matches.length) % matches.length;
    const match = matches[matchIndex], threadKey = current().threadKey, query = searchQuery, sequence = ++searchJumpSequence;
    const control = doc.activeElement;
    refreshSearch();
    // Revealing first applies the application's existing follow-live policy.
    // Search keeps its input/button focus so repeated Enter/Shift+Enter works.
    if (await reveal(match.messageKey, threadKey, { focusTarget: false }) !== "revealed") return;
    const selected = matches[matchIndex];
    if (disposed || search.hidden || sequence !== searchJumpSequence || query !== searchQuery || !scopeCurrent(threadKey, match.messageKey)
      || selected?.messageKey !== match.messageKey || selected.start !== match.start || selected.end !== match.end) return;
    const article = articles.get(match.messageKey)?.article;
    const mark = [...(article?.querySelectorAll("mark.wf-search-current") || [])].find(node => node.dataset.matchIndex === String(matchIndex));
    mark?.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
    let insideSearch = false;
    for (let node = control; node; node = node.parentNode) if (node === search) { insideSearch = true; break; }
    if (insideSearch && control.isConnected && (doc.activeElement === control || doc.activeElement === article)) control.focus({ preventScroll: true });
  }
  function openSearch() { if (disposed || features.F01===false) return; search.hidden = false; refreshSearch(); searchInput.focus(); }

  async function copy(purpose, key, threadKey, blockIndex, renderedCode) {
    if(features[purpose==="code-copy"?"F03":"F02"]===false)return;
    if (!scopeCurrent(threadKey, key)) { feedback(label("stale", "대화가 변경되었습니다. 다시 선택하세요.")); return; }
    // Capture synchronously, before awaiting the clipboard. Later stream deltas
    // cannot change what this explicit click copies.
    const snapshot = current();
    let prepared;
    if (purpose === "code-copy" && typeof renderedCode === "string") {
      if (renderedCode.length > MAX_BODY || INTERNAL_WRAPPER.test(renderedCode)) { feedback(label("copyUnavailable", "이 코드블록은 복사할 수 없습니다.")); return; }
      const masked = maskSecrets(renderedCode);
      prepared = { text: masked.text, includedMessageCount: 1, omittedBlockCount: 0, redactedValueCount: masked.count };
    } else prepared = prepareConversationText(snapshot, { purpose, messageKey: key, blockIndex });
    if (!prepared.includedMessageCount) { feedback(outsideLabel()); return; }
    try {
      await copyText(prepared.text);
      if (scopeCurrent(threadKey, key)) feedback(prepared.redactedValueCount ? label("copiedMasked", "복사됨 · 비밀값 마스킹으로 원문과 다릅니다. OS 클립보드는 되돌릴 수 없습니다.") : label("copied", "복사됨 · OS 클립보드는 되돌릴 수 없습니다."));
    } catch {
      if (!scopeCurrent(threadKey, key)) return;
      const dialog = openDialog("copy-fallback", label("manualCopy", "수동 복사"));
      dialog.append(make("p", "wf-copy-hint", label("clipboardDenied", "클립보드에 접근할 수 없습니다. 아래 내용을 선택해 직접 복사하세요.")), make("p", "wf-masking-note", maskingNote()));
      if (prepared.redactedValueCount) dialog.append(make("p", "wf-copy-masked", label("masked", "비밀값을 마스킹하여 원문과 다릅니다.")));
      const text = make("textarea", "wf-copy-fallback-text"); text.readOnly = true; text.value = prepared.text; text.rows = 12; text.setAttribute("aria-label", label("copyContents", "복사할 내용"));
      dialog.append(text); text.focus(); text.select();
    }
  }
  function decorateMessage(article, message) {
    if (disposed || !article || !allowed(message)) return;
    const snapshot = current(), key = String(message.id), entry = entryFor(snapshot, key);
    if (!entry) return;
    for (const old of article.querySelectorAll(".wf-message-actions,.wf-code-copy")) old.remove();
    const threadKey = snapshot.threadKey;
    articles.set(key, { article, threadKey });
    const actions = make("div", "wf-message-actions"); actions.setAttribute("aria-label", label("messageActions", "메시지 작업"));
    if(features.F02!==false)actions.append(button("wf-message-copy", label("copyMessage", "메시지 복사"), () => copy("message-copy", key, threadKey)));
    if(features.F05!==false)actions.append(button("wf-bookmark-add", label("addBookmark", "북마크 추가"), () => {
      if (!scopeCurrent(threadKey, key)) return;
      const latest = current(), target = entryFor(latest, key);
      feedback(bookmarks.add({ threadKey, messageKey: key, title: latest.title, role: target.role, ordinal: target.ordinal }) ? label("bookmarkAdded", "북마크 추가됨") : label("bookmarkLimit", "북마크는 최대 100개입니다."));
      renderBookmarks();
    }));
    if(features.F02!==false||features.F05!==false)article.append(actions);
    let index = 0;
    for (const pre of article.querySelectorAll("pre")) {
      if(features.F03===false)break;
      const code = pre.querySelector("code"); if (!code) continue;
      const blockIndex = index++;
      pre.append(button("wf-code-copy", label("copyCode", "코드 복사"), () => {
        if (!article.isConnected || articles.get(key)?.article !== article) return;
        return copy("code-copy", key, threadKey, blockIndex, code.textContent);
      }));
    }
  }

  function renderOutline() {
    const dialog = dialogs.get("outline"); if (!dialog?.open) return;
    let list = dialog.querySelector(".wf-outline-list");
    if (!list) { list = make("ol", "wf-outline-list"); dialog.append(list); }
    list.replaceChildren(); const snapshot = current();
    if (!entryFor(snapshot, outlineKey)) outlineKey = null;
    for (const message of snapshot.messages) {
      const item = make("li", "wf-outline-item");
      const view = articles.get(message.messageKey), text = view?.threadKey === snapshot.threadKey && view.article.isConnected ? renderedTextMap(view.article).text : message.text;
      const jump = button("wf-outline-jump", `${message.ordinal}. ${roleLabel(message.role)}${message.incomplete ? ` · ${label("inProgress", "진행 중")}` : ""} · ${text.replace(/\s+/g, " ").slice(0, 100)}`, async () => {
        const scope = snapshot.threadKey;
        if (!scopeCurrent(scope, message.messageKey)) { feedback(outsideLabel()); return; }
        closeDialog(dialog, false);
        if (await reveal(message.messageKey, scope) === "revealed") outlineKey = message.messageKey;
      });
      if (outlineKey === message.messageKey) jump.setAttribute("aria-current", "true");
      item.append(jump); list.append(item);
    }
    if (!snapshot.messages.length) list.append(make("li", "wf-list-empty", label("noMessages", "현재 로드된 메시지가 없습니다.")));
  }
  function openOutline() { if (disposed || features.F06===false) return; openDialog("outline", label("outline", "대화 개요")); renderOutline(); }

  function renderBookmarks() {
    const dialog = dialogs.get("bookmarks"); if (!dialog?.open) return;
    let list = dialog.querySelector(".wf-bookmark-list");
    if (!list) { list = make("ol", "wf-bookmark-list"); dialog.append(list); }
    list.replaceChildren(); const snapshot = current();
    for (const bookmark of bookmarks.list()) {
      const item = make("li", "wf-bookmark-item"), available = snapshot.threadKey === bookmark.threadKey && Boolean(entryFor(snapshot, bookmark.messageKey));
      const jump = button("wf-bookmark-jump", `${bookmark.title} · ${roleLabel(bookmark.role)} · ${bookmark.ordinal}${available ? "" : ` · ${outsideLabel()}`}`, async () => {
        if (!scopeCurrent(bookmark.threadKey, bookmark.messageKey)) { renderBookmarks(); return; }
        closeDialog(dialog, false); await reveal(bookmark.messageKey, bookmark.threadKey);
      }); jump.disabled = !available;
      const remove = button("wf-bookmark-remove", label("removeBookmark", "북마크 삭제"), () => { bookmarks.remove(bookmark.threadKey, bookmark.messageKey); renderBookmarks(); });
      item.append(jump, remove); list.append(item);
    }
    if (!bookmarks.list().length) list.append(make("li", "wf-list-empty", label("noBookmarks", "북마크가 없습니다. 새로고침하면 북마크는 비워집니다.")));
  }
  function openBookmarks() {
    if (disposed || features.F05===false) return; const dialog = openDialog("bookmarks", label("bookmarks", "북마크"));
    dialog.append(make("p", "wf-bookmark-memory-note", label("bookmarkMemory", "현재 탭의 메모리에만 보관됩니다. 북마크로 다른 대화나 기록을 불러오지 않습니다.")), button("wf-bookmark-clear", label("clearBookmarks", "전체 삭제"), () => { bookmarks.clear(); renderBookmarks(); }));
    renderBookmarks();
  }

  function samePreviewScope(snapshot) {
    return preview && preview.snapshot.threadKey === snapshot.threadKey && preview.snapshot.revision === snapshot.revision
      && preview.snapshot.title === snapshot.title
      && preview.snapshot.omittedMessageCount === snapshot.omittedMessageCount
      && preview.snapshot.messages.length === snapshot.messages.length
      && preview.snapshot.messages.every((message, index) => { const currentMessage = snapshot.messages[index]; return message.messageKey === currentMessage.messageKey && message.role === currentMessage.role && message.text === currentMessage.text && message.incomplete === currentMessage.incomplete; });
  }
  function invalidatePreview() {
    const dialog = dialogs.get("export"); if (!dialog?.open || !preview || samePreviewScope(current())) return;
    preview.invalid = true; const confirm = dialog.querySelector(".wf-export-confirm"); if (confirm) confirm.disabled = true;
    const status = dialog.querySelector(".wf-export-status"); if (status) status.textContent = label("exportInvalid", "대화 또는 로드 범위가 변경되었습니다. 준비 화면을 다시 여세요.");
  }
  function download(text, filename) {
    if (downloadText) return downloadText(text, filename);
    const url = globalThis.URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
    const anchor = make("a", "wf-download-link"); anchor.href = url; anchor.download = filename; anchor.hidden = true; host.append(anchor);
    try { anchor.click(); } finally { anchor.remove(); globalThis.setTimeout(() => globalThis.URL.revokeObjectURL(url), 0); }
  }
  function openExportPreview() {
    if (disposed || features.F04===false) return; const dialog = openDialog("export", label("exportReview", "Markdown 내보내기 검토"));
    const loaded = current(), snapshot = { ...loaded, messages: loaded.messages.map(message => ({ ...message })) }, prepared = prepareConversationText(snapshot, { purpose: "markdown-export" });
    preview = { snapshot, prepared, invalid: false, filename: `conversation-${new Date(now()).toISOString().replace(/[:.]/g,"-")}.md` };
    const safeTitle = maskSecrets(INTERNAL_WRAPPER.test(snapshot.title) ? "Conversation" : snapshot.title).text;
    dialog.append(make("p", "wf-export-title", safeTitle),
      make("p", "wf-export-summary", label("exportSummary", `현재 로드된 메시지 ${snapshot.loadedMessageCount}개 중 ${prepared.includedMessageCount}개를 내보냅니다.`, { loaded: snapshot.loadedMessageCount, included: prepared.includedMessageCount })),
      make("p", "wf-export-exclusions", label("exportExclusions", `현재 로드 범위만 포함합니다. 미완료 응답·비표시·검증 불가 메시지 ${prepared.omittedBlockCount}개를 제외합니다. native 질문·응답, tool·reasoning·activity, 내부 payload, 첨부파일은 포함하지 않습니다.`, { omitted: prepared.omittedBlockCount })),
      make("p", "wf-masking-note", `${maskingNote()} ${label("redactedCount", `마스킹 ${prepared.redactedValueCount}개`, { count: prepared.redactedValueCount })}`));
    const content = make("textarea", "wf-export-content"); content.readOnly = true; content.rows = 12; content.value = prepared.text; content.setAttribute("aria-label", label("exportContents", "내보낼 Markdown 내용"));
    const status = make("p", "wf-export-status"); status.setAttribute("role", "status");
    const confirm = button("wf-export-confirm", label("downloadMarkdown", "Markdown 다운로드"), async () => {
      invalidatePreview(); if (!preview || preview.invalid || !samePreviewScope(current())) return;
      const captured = preview; confirm.disabled = true;
      try { await download(captured.prepared.text, captured.filename); if (preview === captured) closeDialog(dialog); }
      catch { if (preview === captured) { status.textContent = label("downloadFailed", "다운로드를 시작하지 못했습니다. 다시 시도하세요."); confirm.disabled = false; } }
    }); confirm.disabled = !prepared.includedMessageCount;
    dialog.append(content, status, confirm, button("wf-export-cancel", label("cancel", "취소"), () => closeDialog(dialog)));
  }

  function update() {
    if (disposed) return;
    clearHighlights();
    const snapshot = current();
    for (const [key, view] of articles) if (!view.article.isConnected || view.threadKey !== snapshot.threadKey) articles.delete(key);
    invalidatePreview(); refreshSearch(); renderOutline(); renderBookmarks();
  }
  function dispose() {
    if (disposed) return;
    clearHighlights(); disposed = true; preview = null; bookmarks.clear();
    for (const dialog of dialogs.values()) closeDialog(dialog, false);
    for (const { article } of articles.values()) for (const control of article.querySelectorAll(".wf-message-actions,.wf-code-copy")) control.remove();
    for (const node of owned) node.remove(); articles.clear(); dialogs.clear();
  }
  update();
  return { update, openSearch, openOutline, openBookmarks, openExportPreview, decorateMessage, dispose };
}
