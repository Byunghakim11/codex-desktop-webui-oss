import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  CODEX_APP_TOOLS,
  HEARTBEAT_STATUSES,
  MAX_AUTOMATION_ID_CHARS,
  MAX_HEARTBEAT_INTERVAL_MINUTES,
  MIN_HEARTBEAT_INTERVAL_MINUTES,
  NativeActionError,
  authorizeThreadTarget,
  callCodexAppTool,
  digest,
  nativeFail,
  nativeFailure,
  parseToolResult,
  requireFunction,
  validateHeartbeatCreateParams,
  validateHeartbeatIdParams,
  validateHeartbeatUpdateParams,
  validateRequestId
} from "./native-capabilities.js";

const INDEX_MAX_BYTES = 262144;
const INDEX_MAX_RECORDS = 2000;
const STATE_VERSION = 1;
const MAX_STORED_REQUESTS = 500;
const SAFE_TOOL_ID = /^[A-Za-z0-9._:-]{1,200}$/;

export class HeartbeatError extends NativeActionError {
  constructor(status, code, options) {
    super(status, code, options);
    this.name = "HeartbeatError";
  }
}

export class HeartbeatIndexError extends NativeActionError {
  constructor(code = "HEARTBEAT_INDEX_UNAVAILABLE") {
    super(500, code);
    this.name = "HeartbeatIndexError";
  }
}

// Human interval (minutes) -> RRULE. Never expose this string to the user; it is internal/native.
export function buildHeartbeatRrule(intervalMinutes) {
  if (typeof intervalMinutes !== "number" || !Number.isInteger(intervalMinutes)) throw nativeFail(400, "INVALID_INTERVAL");
  if (intervalMinutes < MIN_HEARTBEAT_INTERVAL_MINUTES || intervalMinutes > MAX_HEARTBEAT_INTERVAL_MINUTES) throw nativeFail(400, "INVALID_INTERVAL");
  if (intervalMinutes === 1440) return "FREQ=DAILY";
  if (intervalMinutes % 60 === 0) return `FREQ=HOURLY;INTERVAL=${intervalMinutes / 60}`;
  return `FREQ=MINUTELY;INTERVAL=${intervalMinutes}`;
}

export function intervalMinutesFromRrule(rrule) {
  if (typeof rrule !== "string") return null;
  let match = /^FREQ=MINUTELY;INTERVAL=(\d{1,4})$/.exec(rrule);
  if (match) {
    const value = Number(match[1]);
    return value >= MIN_HEARTBEAT_INTERVAL_MINUTES && value <= MAX_HEARTBEAT_INTERVAL_MINUTES ? value : null;
  }
  match = /^FREQ=HOURLY;INTERVAL=(\d{1,2})$/.exec(rrule);
  if (match) {
    const value = Number(match[1]) * 60;
    return value >= MIN_HEARTBEAT_INTERVAL_MINUTES && value <= MAX_HEARTBEAT_INTERVAL_MINUTES ? value : null;
  }
  if (rrule === "FREQ=DAILY" || rrule === "FREQ=DAILY;INTERVAL=1") return 1440;
  return null;
}

// ---------------------------------------------------------------------------------------------
// Strict bounded TOML subset parser (no new dependency). Unsupported syntax fails closed instead
// of guessing; it is only used to read documented CODEX_HOME/automations/*/automation.toml
// metadata and never writes anything.
// ---------------------------------------------------------------------------------------------

class TomlUnsupported extends Error {}
const unsupported = () => { throw new TomlUnsupported("unsupported"); };
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function isTomlObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function skipInlineSpace(state) {
  const { src } = state;
  while (state.i < src.length) {
    const c = src[state.i];
    if (c === " " || c === "\t") state.i += 1;
    else break;
  }
}

function skipComment(state) {
  if (state.src[state.i] !== "#") return;
  while (state.i < state.src.length && state.src[state.i] !== "\n") state.i += 1;
}

function skipAllSpace(state) {
  const { src } = state;
  while (state.i < src.length) {
    const c = src[state.i];
    if (c === " " || c === "\t" || c === "\n") state.i += 1;
    else if (c === "#") skipComment(state);
    else break;
  }
}

function expectEndOfLine(state) {
  skipInlineSpace(state);
  skipComment(state);
  if (state.i < state.src.length && state.src[state.i] !== "\n") unsupported();
}

function readHex(state, count) {
  const chunk = state.src.slice(state.i, state.i + count);
  if (chunk.length !== count || !/^[0-9a-fA-F]+$/.test(chunk)) unsupported();
  state.i += count;
  return Number.parseInt(chunk, 16);
}

function readEscape(state) {
  state.i += 1;
  const c = state.src[state.i];
  const map = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" };
  if (c in map) {
    state.i += 1;
    return map[c];
  }
  if (c === "u") {
    state.i += 1;
    return String.fromCodePoint(readHex(state, 4));
  }
  if (c === "U") {
    state.i += 1;
    const code = readHex(state, 8);
    if (code > 0x10ffff) unsupported();
    return String.fromCodePoint(code);
  }
  return unsupported();
}

function readBasicString(state) {
  state.i += 1;
  let out = "";
  while (state.i < state.src.length) {
    const c = state.src[state.i];
    if (c === '"') {
      state.i += 1;
      return out;
    }
    if (c === "\n") unsupported();
    if (c === "\\") {
      out += readEscape(state);
      continue;
    }
    out += c;
    state.i += 1;
  }
  return unsupported();
}

function readMultilineBasic(state) {
  state.i += 3;
  if (state.src[state.i] === "\n") state.i += 1;
  let out = "";
  while (state.i < state.src.length) {
    if (state.src.startsWith('"""', state.i)) {
      state.i += 3;
      return out;
    }
    const c = state.src[state.i];
    if (c === "\\") {
      if (state.src[state.i + 1] === "\n") {
        state.i += 2;
        while (state.i < state.src.length && /[ \t\n]/.test(state.src[state.i])) state.i += 1;
        continue;
      }
      out += readEscape(state);
      continue;
    }
    out += c;
    state.i += 1;
  }
  return unsupported();
}

function readLiteral(state) {
  state.i += 1;
  const end = state.src.indexOf("'", state.i);
  if (end < 0) unsupported();
  const value = state.src.slice(state.i, end);
  if (value.includes("\n")) unsupported();
  state.i = end + 1;
  return value;
}

function readMultilineLiteral(state) {
  state.i += 3;
  if (state.src[state.i] === "\n") state.i += 1;
  const end = state.src.indexOf("'''", state.i);
  if (end < 0) unsupported();
  const value = state.src.slice(state.i, end);
  state.i = end + 3;
  return value;
}

function parseTomlValue(state) {
  const c = state.src[state.i];
  if (c === undefined) unsupported();
  if (c === '"') return state.src.startsWith('"""', state.i) ? readMultilineBasic(state) : readBasicString(state);
  if (c === "'") return state.src.startsWith("'''", state.i) ? readMultilineLiteral(state) : readLiteral(state);
  if (c === "[") return parseTomlArray(state);
  if (state.src.startsWith("true", state.i) && /^true(?![A-Za-z0-9_-])/.test(state.src.slice(state.i))) {
    state.i += 4;
    return true;
  }
  if (state.src.startsWith("false", state.i) && /^false(?![A-Za-z0-9_-])/.test(state.src.slice(state.i))) {
    state.i += 5;
    return false;
  }
  if (/[+-]?\d/.test(c)) {
    const match = /^[+-]?[0-9](?:_?[0-9])*/.exec(state.src.slice(state.i));
    if (!match) unsupported();
    const raw = match[0];
    const next = state.src[state.i + raw.length];
    if (next && /[.eExXoObB_]/.test(next)) unsupported();
    const value = Number(raw.replace(/_/g, ""));
    if (!Number.isSafeInteger(value)) unsupported();
    state.i += raw.length;
    return value;
  }
  return unsupported();
}

function parseTomlArray(state) {
  state.i += 1;
  const out = [];
  for (;;) {
    skipAllSpace(state);
    if (state.src[state.i] === "]") {
      state.i += 1;
      return out;
    }
    out.push(parseTomlValue(state));
    if (out.length > 10000) unsupported();
    skipAllSpace(state);
    if (state.src[state.i] === ",") {
      state.i += 1;
      continue;
    }
    if (state.src[state.i] === "]") {
      state.i += 1;
      return out;
    }
    return unsupported();
  }
}

function readKeySegment(state) {
  const c = state.src[state.i];
  if (c === '"') return readBasicString(state);
  if (c === "'") return readLiteral(state);
  const match = /^[A-Za-z0-9_-]+/.exec(state.src.slice(state.i));
  if (!match) return unsupported();
  state.i += match[0].length;
  return match[0];
}

function readKeyPath(state) {
  const segments = [];
  for (;;) {
    skipInlineSpace(state);
    const segment = readKeySegment(state);
    if (FORBIDDEN_KEYS.has(segment) || segment.length === 0) unsupported();
    segments.push(segment);
    if (segments.length > 16) unsupported();
    skipInlineSpace(state);
    if (state.src[state.i] === ".") {
      state.i += 1;
      continue;
    }
    return segments;
  }
}

function ensureTable(root, segments) {
  let table = root;
  for (const segment of segments) {
    if (!Object.hasOwn(table, segment)) table[segment] = Object.create(null);
    const next = table[segment];
    if (!isTomlObject(next)) unsupported();
    table = next;
  }
  return table;
}

function assignValue(table, segments, value) {
  let target = table;
  for (const segment of segments.slice(0, -1)) {
    if (!Object.hasOwn(target, segment)) target[segment] = Object.create(null);
    const next = target[segment];
    if (!isTomlObject(next)) unsupported();
    target = next;
  }
  const leaf = segments[segments.length - 1];
  if (Object.hasOwn(target, leaf)) unsupported();
  target[leaf] = value;
}

export function parseAutomationToml(text, { maxBytes = INDEX_MAX_BYTES } = {}) {
  if (typeof text !== "string") throw new HeartbeatIndexError("HEARTBEAT_INDEX_UNSUPPORTED");
  if (Buffer.byteLength(text, "utf8") > maxBytes) throw new HeartbeatIndexError("HEARTBEAT_INDEX_UNSUPPORTED");
  let src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  src = src.replace(/\r\n/g, "\n");
  if (src.includes("\r") || src.includes("\u0000")) throw new HeartbeatIndexError("HEARTBEAT_INDEX_UNSUPPORTED");
  const state = { src, i: 0 };
  const root = Object.create(null);
  let table = root;
  try {
    while (state.i < src.length) {
      skipAllSpace(state);
      if (state.i >= src.length) break;
      if (src[state.i] === "[") {
        if (src[state.i + 1] === "[") unsupported();
        state.i += 1;
        const segments = readKeyPath(state);
        if (src[state.i] !== "]") unsupported();
        state.i += 1;
        table = ensureTable(root, segments);
        expectEndOfLine(state);
        continue;
      }
      const segments = readKeyPath(state);
      skipInlineSpace(state);
      if (src[state.i] !== "=") unsupported();
      state.i += 1;
      skipInlineSpace(state);
      const value = parseTomlValue(state);
      assignValue(table, segments, value);
      expectEndOfLine(state);
    }
  } catch (error) {
    if (error instanceof HeartbeatIndexError) throw error;
    throw new HeartbeatIndexError("HEARTBEAT_INDEX_UNSUPPORTED");
  }
  return root;
}

const METADATA_KEYS = [
  "id",
  "name",
  "prompt",
  "rrule",
  "status",
  "kind",
  "targetThreadId",
  "destination",
  "executionEnvironment",
  "notificationPolicy",
  "projectId",
  "model",
  "reasoningEffort",
  "mode",
  "createdAt",
  "updatedAt"
];

export function extractAutomationMetadata(parsed, directoryName) {
  if (!isTomlObject(parsed)) throw new HeartbeatIndexError("HEARTBEAT_INDEX_UNSUPPORTED");
  const source = isTomlObject(parsed.automation) ? parsed.automation : parsed;
  const meta = {};
  for (const key of METADATA_KEYS) {
    if (!Object.hasOwn(source, key)) continue;
    const value = source[key];
    if (typeof value === "string") meta[key] = value;
    else if (typeof value === "number" && Number.isSafeInteger(value)) meta[key] = value;
    else if (typeof value === "boolean") meta[key] = value;
    else if (value === null) meta[key] = null;
  }
  if (typeof meta.id !== "string" || !meta.id) meta.id = directoryName;
  return meta;
}

export async function readAutomationIndex({ codexHome, maxBytes = INDEX_MAX_BYTES, maxRecords = INDEX_MAX_RECORDS } = {}) {
  if (!codexHome || typeof codexHome !== "string") return [];
  const root = path.join(codexHome, "automations");
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return [];
    throw new HeartbeatIndexError("HEARTBEAT_INDEX_UNAVAILABLE");
  }
  const records = [];
  for (const entry of entries) {
    if (records.length >= maxRecords) break;
    if (!entry.isDirectory()) continue;
    const file = path.join(root, entry.name, "automation.toml");
    let text;
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      text = await fs.readFile(file, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw new HeartbeatIndexError("HEARTBEAT_INDEX_UNAVAILABLE");
    }
    const parsed = parseAutomationToml(text, { maxBytes });
    records.push(extractAutomationMetadata(parsed, entry.name));
  }
  return records;
}

// ---------------------------------------------------------------------------------------------
// Heartbeat service. Native automation_update remains the authority for every mutation; the local
// index is read-only metadata, and the private id registry only remembers ids this WebUI created.
// ---------------------------------------------------------------------------------------------

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function nowIso(now) {
  const value = typeof now === "function" ? now() : Date.now();
  if (!Number.isFinite(value) || value < 0) throw nativeFail(500, "CLOCK_UNAVAILABLE");
  return new Date(value).toISOString();
}

function heartbeatStateDir(dataDir) {
  if (typeof dataDir !== "string" || !dataDir) throw nativeFail(500, "DATA_DIR_REQUIRED");
  return path.join(dataDir, "native-heartbeats");
}

async function readJsonState(file, fallback, key) {
  let raw;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw new HeartbeatError(500, "HEARTBEAT_STATE_UNAVAILABLE");
  }
  try {
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed) || parsed.version !== STATE_VERSION || !isPlainObject(parsed[key])) throw new Error("bad state");
    return parsed;
  } catch {
    throw new HeartbeatError(500, "HEARTBEAT_STATE_UNAVAILABLE");
  }
}

async function writeJsonState(file, value) {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const temp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  await fs.writeFile(temp, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temp, file);
}

function normalizeAutomationResult(parsed, threadId) {
  if (!parsed || !isPlainObject(parsed.json)) throw nativeFail(502, "INVALID_NATIVE_RESULT");
  const raw = isPlainObject(parsed.json.automation) ? parsed.json.automation : parsed.json;
  if (!isPlainObject(raw)) throw nativeFail(502, "INVALID_NATIVE_RESULT");
  if (raw.kind !== "heartbeat") throw nativeFail(403, "NOT_HEARTBEAT");
  if (raw.targetThreadId !== threadId) throw nativeFail(403, "TARGET_MISMATCH");
  if (typeof raw.id !== "string" || !SAFE_TOOL_ID.test(raw.id)) throw nativeFail(502, "INVALID_NATIVE_RESULT");
  if (!HEARTBEAT_STATUSES.includes(raw.status)) throw nativeFail(502, "INVALID_NATIVE_RESULT");
  if (typeof raw.name !== "string" || !raw.name || raw.name.length > 200) throw nativeFail(502, "INVALID_NATIVE_RESULT");
  if (typeof raw.prompt !== "string" || !raw.prompt || raw.prompt.length > 8000) throw nativeFail(502, "INVALID_NATIVE_RESULT");
  if (typeof raw.rrule !== "string" || !raw.rrule) throw nativeFail(502, "INVALID_NATIVE_RESULT");
  let notificationPolicy;
  if (Object.hasOwn(raw, "notificationPolicy")) {
    if (raw.notificationPolicy !== null && raw.notificationPolicy !== "failed_runs_only") throw nativeFail(502, "INVALID_NATIVE_RESULT");
    notificationPolicy = raw.notificationPolicy;
  }
  let destination;
  if (Object.hasOwn(raw, "destination")) {
    if (raw.destination !== "thread" && raw.destination !== "local") throw nativeFail(502, "INVALID_NATIVE_RESULT");
    destination = raw.destination;
  }
  return {
    id: raw.id,
    name: raw.name,
    prompt: raw.prompt,
    rrule: raw.rrule,
    status: raw.status,
    kind: "heartbeat",
    targetThreadId: threadId,
    notificationPolicy,
    destination
  };
}

function publicHeartbeat(record) {
  return {
    id: record.id,
    name: record.name,
    status: record.status,
    kind: "heartbeat",
    intervalMinutes: intervalMinutesFromRrule(record.rrule),
    notificationPolicy: record.notificationPolicy ?? null,
    targetThreadId: record.targetThreadId,
    source: "native"
  };
}

function sanitizeIndexRecord(raw, threadId) {
  if (!isPlainObject(raw)) return null;
  if (raw.targetThreadId !== threadId) return null;
  if (raw.kind !== undefined && raw.kind !== "heartbeat") return null;
  if (typeof raw.id !== "string" || !raw.id || raw.id.length > MAX_AUTOMATION_ID_CHARS) return null;
  const status = HEARTBEAT_STATUSES.includes(raw.status) ? raw.status : null;
  const name = typeof raw.name === "string" && raw.name ? raw.name.slice(0, 200) : null;
  const intervalMinutes = typeof raw.intervalMinutes === "number"
    ? (Number.isInteger(raw.intervalMinutes) && raw.intervalMinutes > 0 && raw.intervalMinutes <= MAX_HEARTBEAT_INTERVAL_MINUTES ? raw.intervalMinutes : null)
    : intervalMinutesFromRrule(raw.rrule);
  return { id: raw.id, name, status, kind: "heartbeat", intervalMinutes, targetThreadId: threadId, source: "index" };
}

function extractCreatedId(parsed) {
  if (!parsed || !isPlainObject(parsed.json)) return null;
  const container = isPlainObject(parsed.json.automation) ? parsed.json.automation : parsed.json;
  const id = container.id;
  return typeof id === "string" && SAFE_TOOL_ID.test(id) ? id : null;
}

export function createHeartbeatService({
  callNative,
  authorizeThread,
  dataDir,
  now = () => Date.now(),
  codexHome = process.env.CODEX_HOME || "",
  listHeartbeatRecords = null,
  maxIndexBytes = INDEX_MAX_BYTES
} = {}) {
  requireFunction(callNative, "NATIVE_UNAVAILABLE");
  requireFunction(authorizeThread, "AUTHORIZATION_REQUIRED", 403);
  const dir = heartbeatStateDir(dataDir);
  const requestsFile = path.join(dir, "requests.json");
  const idsFile = path.join(dir, "ids.json");
  const inflight = new Map();
  const createReservations = new Set();
  let creationTurn=Promise.resolve();
  function reserveCreationTurn(){
    let release;const previous=creationTurn;
    creationTurn=new Promise(resolve=>{release=resolve;});
    return previous.then(()=>release);
  }

  const authorize = (scope, threadId) => authorizeThreadTarget({ authorizeThread, scope, threadId });

  // Fresh authorization issued immediately before an actual native mutation. Reads (index, native
  // view, disk state) happen after the initial authorization, so the scope may be revoked and the
  // authorized thread record may change while those awaits are in flight. Never mutate a stale
  // loop context: the id must be identical and the cwd must be stable.
  async function authorizeMutation(scope, threadId, expectedThread) {
    const fresh = await authorize(scope, threadId);
    if (!fresh || fresh.id !== expectedThread.id) throw nativeFail(403, "THREAD_CONTEXT_CHANGED");
    if (fresh.cwd !== expectedThread.cwd) throw nativeFail(409, "THREAD_CONTEXT_CHANGED");
    return fresh;
  }

  async function callTool(threadId, tool, args) {
    let result;
    try {
      result = await callCodexAppTool({ callNative, threadId, tool, arguments: args });
    } catch (error) {
      throw nativeFailure(error);
    }
    return parseToolResult(result);
  }

  async function fetchRaw(thread, id) {
    const parsed = await callTool(thread.id, CODEX_APP_TOOLS.automationUpdate, { mode: "view", id });
    return normalizeAutomationResult(parsed, thread.id);
  }

  async function readRequests() {
    return readJsonState(requestsFile, { version: STATE_VERSION, requests: {} }, "requests");
  }

  async function writeRequests(state) {
    const entries = Object.entries(state.requests).sort((a, b) => String(a[1]?.at || "").localeCompare(String(b[1]?.at || "")));
    if (entries.length > MAX_STORED_REQUESTS) {
      state.requests = Object.fromEntries(entries.slice(entries.length - MAX_STORED_REQUESTS));
    }
    await writeJsonState(requestsFile, state);
  }

  async function readIds() {
    return readJsonState(idsFile, { version: STATE_VERSION, ids: {} }, "ids");
  }

  async function registerId(threadId, id, name) {
    const state = await readIds();
    state.ids[id] = { threadId, name: typeof name === "string" ? name.slice(0, 200) : null, createdAt: nowIso(now) };
    state.ids[id].threadId = threadId;
    await writeJsonState(idsFile, state);
  }

  async function unregisterId(id) {
    const release=await reserveCreationTurn();
    try{
    const state = await readIds();
    if (!Object.hasOwn(state.ids, id)) return;
    delete state.ids[id];
    await writeJsonState(idsFile, state);
    }finally{release();}
  }

  async function markUnknown(requestId, threadId, id = null) {
    try {
      const state = await readRequests();
      state.requests[requestId] = { status: "unknown", threadId, id, at: nowIso(now) };
      await writeRequests(state);
    } catch {
      // The in-memory caller still gets the unknown-outcome failure below.
    }
  }

  async function view(scope, { threadId, params }) {
    const { id } = validateHeartbeatIdParams(params);
    const thread = await authorize(scope, threadId);
    const record = await fetchRaw(thread, id);
    return { heartbeat: { ...publicHeartbeat(record), prompt: record.prompt } };
  }

  async function sortRecords(records) {
    return records.sort((a, b) => String(a.id).localeCompare(String(b.id)));
  }

  async function list(scope, { threadId }) {
    const thread = await authorize(scope, threadId);
    let records = [];
    if (listHeartbeatRecords) {
      let raw;
      try {
        raw = await listHeartbeatRecords({ threadId: thread.id });
      } catch {
        throw new HeartbeatError(500, "HEARTBEAT_INDEX_UNAVAILABLE");
      }
      if (!Array.isArray(raw) || raw.length > INDEX_MAX_RECORDS) throw new HeartbeatError(500, "HEARTBEAT_INDEX_UNAVAILABLE");
      records = raw.map(entry => sanitizeIndexRecord(entry, thread.id)).filter(Boolean);
    } else {
      const indexed = await readAutomationIndex({ codexHome, maxBytes: maxIndexBytes });
      records = indexed.map(entry => sanitizeIndexRecord(entry, thread.id)).filter(Boolean);
    }
    const seen = new Set(records.map(record => record.id));
    const ids = await readIds();
    for (const [id, entry] of Object.entries(ids.ids)) {
      if (seen.has(id) || !isPlainObject(entry) || entry.threadId !== thread.id) continue;
      records.push({ id, name: typeof entry.name === "string" ? entry.name : null, status: null, kind: "heartbeat", intervalMinutes: null, targetThreadId: thread.id, source: "webui-registry" });
    }
    return { heartbeats: await sortRecords(records), complete: false };
  }

  async function create(scope, { threadId, params, requestId }) {
    const normalized = validateHeartbeatCreateParams(params);
    const requestKey = validateRequestId(requestId);
    const thread = await authorize(scope, threadId);
    if (inflight.has(requestKey)||createReservations.has(requestKey)) throw new HeartbeatError(409, "REQUEST_IN_FLIGHT");
    if(createReservations.size>=16)throw new HeartbeatError(429,"HEARTBEAT_BUSY");
    // Reserve synchronously before disk reads: concurrent identical intents
    // must not both pass the durable-record check and create native loops.
    createReservations.add(requestKey);
    let releaseCreation;
    try {
    // Requests and the created-id registry are read/modify/write JSON files.
    // Serialize distinct creates as well, so one intent cannot erase another's
    // durable receipt and make a later retry create a duplicate automation.
    releaseCreation=await reserveCreationTurn();

    const requests = await readRequests();
    const existing = requests.requests[requestKey];
    if (existing) {
      if (existing.threadId !== thread.id) throw new HeartbeatError(409, "REQUEST_ID_CONFLICT");
      if (existing.status === "created" && existing.heartbeat) return { heartbeat: existing.heartbeat, replayed: true };
      throw new HeartbeatError(503, "NATIVE_OUTCOME_UNKNOWN");
    }

    const args = {
      name: normalized.name,
      prompt: normalized.prompt,
      rrule: buildHeartbeatRrule(normalized.intervalMinutes),
      status: normalized.status ?? "ACTIVE",
      kind: "heartbeat",
      mode: "create",
      destination: "thread",
      targetThreadId: thread.id
    };
    if (Object.hasOwn(normalized, "notificationPolicy")) args.notificationPolicy = normalized.notificationPolicy;

    requests.requests[requestKey] = { status: "pending", threadId: thread.id, at: nowIso(now) };
    await writeRequests(requests);

    const work = (async () => {
      try {
        await authorizeMutation(scope, threadId, thread);
      } catch (error) {
        // The create intent was already persisted; the scope was revoked before any native call,
        // so record the conservative unknown outcome and never auto-retry or claim completion.
        await markUnknown(requestKey, thread.id);
        throw error;
      }
      let parsed;
      try {
        parsed = await callTool(thread.id, CODEX_APP_TOOLS.automationUpdate, args);
      } catch {
        await markUnknown(requestKey, thread.id);
        throw new HeartbeatError(503, "NATIVE_OUTCOME_UNKNOWN");
      }
      const id = extractCreatedId(parsed);
      if (!id) {
        await markUnknown(requestKey, thread.id);
        throw new HeartbeatError(503, "NATIVE_OUTCOME_UNKNOWN");
      }
      let record;
      try {
        record = await fetchRaw(thread, id);
      } catch {
        await markUnknown(requestKey, thread.id, id);
        throw new HeartbeatError(503, "NATIVE_OUTCOME_UNKNOWN");
      }
      await registerId(thread.id, id, record.name);
      const heartbeat = publicHeartbeat(record);
      const latest = await readRequests();
      latest.requests[requestKey] = { status: "created", threadId: thread.id, id, heartbeat, at: nowIso(now) };
      await writeRequests(latest);
      return { heartbeat, replayed: false };
    })();
    inflight.set(requestKey, work);
    try {
      return await work;
    } finally {
      inflight.delete(requestKey);
    }
    } finally { releaseCreation?.();createReservations.delete(requestKey); }
  }

  function updateArgs(current, overrides = {}) {
    const args = {
      name: overrides.name ?? current.name,
      prompt: overrides.prompt ?? current.prompt,
      rrule: overrides.rrule ?? current.rrule,
      status: overrides.status ?? current.status,
      kind: "heartbeat",
      mode: "update",
      id: current.id,
      destination: current.destination ?? "thread",
      targetThreadId: current.targetThreadId
    };
    if (overrides.notificationPolicy !== undefined) args.notificationPolicy = overrides.notificationPolicy;
    else if (current.notificationPolicy !== undefined) args.notificationPolicy = current.notificationPolicy;
    return args;
  }

  async function update(scope, { threadId, params }) {
    const normalized = validateHeartbeatUpdateParams(params);
    const thread = await authorize(scope, threadId);
    const current = await fetchRaw(thread, normalized.id);
    const overrides = { ...normalized };
    delete overrides.id;
    if (overrides.intervalMinutes !== undefined) {
      overrides.rrule = buildHeartbeatRrule(overrides.intervalMinutes);
      delete overrides.intervalMinutes;
    }
    const args = updateArgs(current, overrides);
    await authorizeMutation(scope, threadId, thread);
    await callTool(thread.id, CODEX_APP_TOOLS.automationUpdate, args);
    const after = await fetchRaw(thread, current.id);
    return { heartbeat: publicHeartbeat(after) };
  }

  async function setStatus(scope, { threadId, params, status }) {
    if (!HEARTBEAT_STATUSES.includes(status)) throw new HeartbeatError(400, "INVALID_HEARTBEAT_STATUS");
    const { id } = validateHeartbeatIdParams(params);
    const thread = await authorize(scope, threadId);
    const current = await fetchRaw(thread, id);
    if (current.status === status) return { heartbeat: publicHeartbeat(current), unchanged: true };
    const args = updateArgs(current, { status });
    await authorizeMutation(scope, threadId, thread);
    await callTool(thread.id, CODEX_APP_TOOLS.automationUpdate, args);
    const after = await fetchRaw(thread, id);
    return { heartbeat: publicHeartbeat(after), unchanged: false };
  }

  async function remove(scope, { threadId, params, expectedState }) {
    const { id } = validateHeartbeatIdParams(params);
    const thread = await authorize(scope, threadId);
    const current = await fetchRaw(thread, id);
    if (typeof expectedState === "string" && expectedState) {
      const currentState = digest({
        id: current.id,
        name: current.name,
        prompt: current.prompt,
        rrule: current.rrule,
        status: current.status,
        kind: current.kind,
        targetThreadId: current.targetThreadId
      });
      if (currentState !== expectedState) throw new HeartbeatError(409, "CONFIRMATION_STALE");
    }
    await authorizeMutation(scope, threadId, thread);
    await callTool(thread.id, CODEX_APP_TOOLS.automationUpdate, { mode: "delete", id: current.id });
    await unregisterId(id);
    return { deleted: true, id };
  }

  async function confirmationState(scope, { threadId, params }) {
    const { id } = validateHeartbeatIdParams(params);
    const thread = await authorize(scope, threadId);
    const current = await fetchRaw(thread, id);
    return digest({
      id: current.id,
      name: current.name,
      prompt: current.prompt,
      rrule: current.rrule,
      status: current.status,
      kind: current.kind,
      targetThreadId: current.targetThreadId
    });
  }

  return Object.freeze({ view, list, create, update, setStatus, remove, confirmationState });
}
