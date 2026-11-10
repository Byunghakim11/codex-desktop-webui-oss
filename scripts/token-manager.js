#!/usr/bin/env node
import path from "node:path";
import { mkdir } from "node:fs/promises";
import QRCode from "qrcode";
import {
  createTokenRecord,
  findTokenRecord,
  generateAccessToken,
  normalizeScopePaths,
  normalizeTokenId,
  publicTokenRecord,
  readTokenStore,
  resolveDataDir,
  tokenStorePath,
  writeTokenStore
} from "../server/token-store.js";
import { readUsageStore, resetUsage } from "../server/usage-store.js";
import { getPrimaryLanUrl } from "../server/network-urls.js";

const args = process.argv.slice(2);
const command = args.shift() || "help";
const commandName = String(process.env.CODEX_WEBUI_COMMAND || "node scripts/token-manager.js");
const dataDir = resolveDataDir();

try {
  await run(command, args);
} catch (error) {
  console.error(`Error: ${error.message}`);
  process.exitCode = 1;
}

async function run(name, values) {
  if (["help", "-h", "--help"].includes(name)) return printHelp();
  if (name === "list") return listTokens(values);
  if (name === "add") return addToken(values);
  if (name === "remove") return removeToken(values);
  if (name === "rotate") return rotateToken(values);
  if (name === "enable" || name === "disable") return setEnabled(name, values);
  if (name === "show") return showToken(values, false);
  if (name === "qr") return showToken(values, true);
  if (name === "stats") return showStats(values);
  if (name === "reset-stats") return clearStats(values);
  throw new Error(`Unknown command: ${name}. Run \"${commandName} help\".`);
}

function listTokens(values) {
  const store = readTokenStore(dataDir);
  const rows = store.tokens.map(publicTokenRecord);
  if (values.includes("--json")) return console.log(JSON.stringify(rows, null, 2));
  console.table(rows.map((row) => ({
    id: row.id,
    label: row.label,
    fingerprint: row.fingerprint,
    status: row.disabled ? "disabled" : "enabled",
    folders: row.threadFilterCwds.join(" | ") || "all"
  })));
  console.log(`Store: ${tokenStorePath(dataDir)}`);
}

function addToken(values) {
  const id = requiredPosition(values, "token id");
  const options = parseOptions(values);
  const store = readTokenStore(dataDir);
  if (findTokenRecord(store, id)) throw new Error(`Token id already exists: ${normalizeTokenId(id)}`);
  const record = createTokenRecord({
    id,
    label: options.label || id,
    threadFilterCwds: optionList(options, "cwd")
  });
  store.tokens.push(record);
  writeTokenStore(store, dataDir);
  printSecretResult("Created", record);
}

function removeToken(values) {
  const id = requiredPosition(values, "token id");
  requireConfirmation(values);
  const store = readTokenStore(dataDir);
  const record = findTokenRecord(store, id);
  if (!record) throw new Error(`Unknown token id: ${id}`);
  store.tokens = store.tokens.filter((entry) => entry.id !== record.id);
  if (!store.tokens.some((entry) => !entry.disabled)) {
    throw new Error("Cannot remove the last enabled token. Add or enable another token first.");
  }
  writeTokenStore(store, dataDir);
  console.log(`Removed token ${record.id}.`);
}

function rotateToken(values) {
  const id = requiredPosition(values, "token id");
  const store = readTokenStore(dataDir);
  const record = findTokenRecord(store, id);
  if (!record) throw new Error(`Unknown token id: ${id}`);
  record.token = generateAccessToken();
  record.updatedAt = new Date().toISOString();
  writeTokenStore(store, dataDir);
  printSecretResult("Rotated", record);
}

function setEnabled(action, values) {
  const id = requiredPosition(values, "token id");
  const store = readTokenStore(dataDir);
  const record = findTokenRecord(store, id);
  if (!record) throw new Error(`Unknown token id: ${id}`);
  record.disabled = action === "disable";
  record.updatedAt = new Date().toISOString();
  if (record.disabled && !store.tokens.some((entry) => entry.id !== record.id && !entry.disabled)) {
    throw new Error("Cannot disable the last enabled token.");
  }
  writeTokenStore(store, dataDir);
  console.log(`${record.id} is now ${record.disabled ? "disabled" : "enabled"}.`);
}

async function showToken(values, includeQr) {
  const id = requiredPosition(values, "token id");
  const options = parseOptions(values);
  const store = readTokenStore(dataDir);
  const record = findTokenRecord(store, id);
  if (!record) throw new Error(`Unknown token id: ${id}`);
  const url = accessUrl(record, options.host);
  console.log(url);
  if (!includeQr) return;
  const qrDir = path.join(dataDir, "qr");
  await mkdir(qrDir, { recursive: true });
  const outputPath = path.join(qrDir, `${record.id}.svg`);
  await QRCode.toFile(outputPath, url, { type: "svg", errorCorrectionLevel: "M", margin: 2 });
  console.log(await QRCode.toString(url, { type: "terminal", small: true, errorCorrectionLevel: "M" }));
  console.log(`QR file: ${outputPath}`);
}

function showStats(values) {
  const positions = values.filter((value) => !value.startsWith("--"));
  const requestedId = positions[0] ? normalizeTokenId(positions[0]) : "";
  const store = readTokenStore(dataDir);
  const usage = readUsageStore(dataDir);
  const rows = store.tokens
    .filter((record) => !requestedId || record.id === requestedId)
    .map((record) => ({
      id: record.id,
      label: record.label,
      fingerprint: publicTokenRecord(record).fingerprint,
      ...(usage.tokens[record.id] || emptyStats())
    }));
  if (requestedId && !rows.length) throw new Error(`Unknown token id: ${requestedId}`);
  if (values.includes("--json")) return console.log(JSON.stringify(rows, null, 2));
  console.table(rows.map((row) => ({
    id: row.id,
    requests: Number(row.httpRequests || 0) + Number(row.rpcRequests || 0),
    rpcErrors: row.rpcErrors || 0,
    ws: row.wsConnections || 0,
    down: formatBytes(row.bytesOut),
    up: formatBytes(row.bytesIn),
    lastUsed: row.lastUsedAt || "never"
  })));
  if (requestedId && rows[0]?.methods && Object.keys(rows[0].methods).length) {
    console.table(Object.entries(rows[0].methods).sort((a, b) => b[1] - a[1]).map(([method, count]) => ({ method, count })));
  }
}

function clearStats(values) {
  requireConfirmation(values);
  const id = values.find((value) => !value.startsWith("--")) || "";
  if (id) {
    const store = readTokenStore(dataDir);
    const record = findTokenRecord(store, id);
    if (!record) throw new Error(`Unknown token id: ${id}`);
    resetUsage(dataDir, record.id);
    console.log(`Reset usage statistics for ${record.id}.`);
  } else {
    resetUsage(dataDir);
    console.log("Reset all usage statistics.");
  }
}

function printSecretResult(action, record) {
  console.log(`${action} token ${record.id}. Save this URL securely:`);
  console.log(accessUrl(record));
  console.log("The running server reloads token changes automatically.");
}

function accessUrl(record, explicitHost = "") {
  const base = String(explicitHost || firstLanUrl()).replace(/\/$/, "");
  return `${base}/?token=${encodeURIComponent(record.token)}`;
}

function firstLanUrl() {
  const port = Number(process.env.PORT || 9526);
  return getPrimaryLanUrl(port);
}

function requiredPosition(values, label) {
  const value = values.find((entry) => !entry.startsWith("--"));
  if (!value) throw new Error(`Missing ${label}.`);
  values.splice(values.indexOf(value), 1);
  return value;
}

function parseOptions(values) {
  const options = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const [rawKey, inlineValue] = value.slice(2).split("=", 2);
    const optionValue = inlineValue ?? values[index + 1];
    if (inlineValue === undefined && optionValue && !optionValue.startsWith("--")) index += 1;
    if (options[rawKey] === undefined) options[rawKey] = optionValue ?? true;
    else options[rawKey] = [].concat(options[rawKey], optionValue ?? true);
  }
  return options;
}

function optionList(options, key) {
  if (!options[key] || options[key] === true) return [];
  return normalizeScopePaths([].concat(options[key]));
}

function requireConfirmation(values) {
  if (!values.includes("--yes")) throw new Error("This action is destructive. Re-run with --yes.");
}

function emptyStats() {
  return { firstUsedAt: null, lastUsedAt: null, httpRequests: 0, wsConnections: 0, rpcRequests: 0, rpcErrors: 0, bytesIn: 0, bytesOut: 0, methods: {} };
}

function formatBytes(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function printHelp() {
  console.log(`Codex WebUI token manager

Usage:
  ${commandName} list [--json]
  ${commandName} add <id> [--label <text>] [--cwd <path>]...
  ${commandName} rotate <id>
  ${commandName} remove <id> --yes
  ${commandName} enable|disable <id>
  ${commandName} show <id> [--host http://host:port]
  ${commandName} qr <id> [--host http://host:port]
  ${commandName} stats [id] [--json]
  ${commandName} reset-stats [id] --yes

Token secrets live only in: ${tokenStorePath(dataDir)}`);
}
