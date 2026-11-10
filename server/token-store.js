import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const TOKEN_STORE_VERSION = 1;

export function resolveDataDir(env = process.env, platform = process.platform) {
  const explicit = String(env.CODEX_WEBUI_DATA_DIR || "").trim();
  if (explicit) return path.resolve(explicit);
  if (platform === "win32") {
    return path.join(env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "CodexWebUI");
  }
  return path.join(env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "codex-webui");
}

export function tokenStorePath(dataDir = resolveDataDir()) {
  return path.join(dataDir, "tokens.json");
}

export function usageStorePath(dataDir = resolveDataDir()) {
  return path.join(dataDir, "usage.json");
}

export function generateAccessToken() {
  return `cw_${randomBytes(24).toString("base64url")}`;
}

export function hashToken(token) {
  return createHash("sha256").update(String(token || "")).digest("hex");
}

export function tokenFingerprint(token) {
  return hashToken(token).slice(0, 12);
}

export function createTokenRecord({ id, label, token, threadFilterCwds = [] } = {}) {
  const accessToken = String(token || generateAccessToken()).trim();
  if (!accessToken) throw new Error("Token cannot be empty.");
  const createdAt = new Date().toISOString();
  return {
    id: normalizeTokenId(id || label || "default"),
    label: String(label || id || "Default access").trim(),
    token: accessToken,
    threadFilterCwds: normalizeScopePaths(threadFilterCwds),
    createdAt,
    updatedAt: createdAt,
    disabled: false
  };
}

export function normalizeTokenId(value) {
  const id = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  if (!id) throw new Error("Token id must contain letters or numbers.");
  return id;
}

export function normalizeScopePaths(value) {
  const entries = Array.isArray(value) ? value : String(value || "").split("|");
  return [...new Set(
    entries
      .map((entry) => String(entry || "").trim())
      .filter(Boolean)
      .map((entry) => path.resolve(entry))
  )];
}

export function readTokenStore(dataDir = resolveDataDir(), { create = true } = {}) {
  const filePath = tokenStorePath(dataDir);
  if (!existsSync(filePath)) {
    if (!create) return { version: TOKEN_STORE_VERSION, tokens: [] };
    const initial = { version: TOKEN_STORE_VERSION, tokens: [createTokenRecord()] };
    writeTokenStore(initial, dataDir);
    return initial;
  }

  let store;
  try {
    store = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read token store ${filePath}: ${error.message}`);
  }
  validateTokenStore(store);
  return store;
}

export function writeTokenStore(store, dataDir = resolveDataDir()) {
  validateTokenStore(store);
  mkdirSync(dataDir, { recursive: true });
  const filePath = tokenStorePath(dataDir);
  const tempPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(tempPath, 0o600);
  } catch {
    // Best effort on platforms where POSIX modes are unavailable.
  }
  renameSync(tempPath, filePath);
  return filePath;
}

export function validateTokenStore(store) {
  if (!store || store.version !== TOKEN_STORE_VERSION || !Array.isArray(store.tokens)) {
    throw new Error(`Unsupported token store. Expected version ${TOKEN_STORE_VERSION}.`);
  }
  const ids = new Set();
  const values = new Set();
  for (const token of store.tokens) {
    token.id = normalizeTokenId(token.id);
    token.label = String(token.label || token.id);
    token.token = String(token.token || "").trim();
    token.threadFilterCwds = normalizeScopePaths(token.threadFilterCwds || token.threadFilterCwd || []);
    token.disabled = Boolean(token.disabled);
    if (!token.token) throw new Error(`Token ${token.id} has no secret value.`);
    if (ids.has(token.id)) throw new Error(`Duplicate token id: ${token.id}`);
    if (values.has(token.token)) throw new Error(`Duplicate token value for: ${token.id}`);
    ids.add(token.id);
    values.add(token.token);
  }
  return store;
}

export function publicTokenRecord(record) {
  return {
    id: record.id,
    label: record.label,
    fingerprint: tokenFingerprint(record.token),
    threadFilterCwds: [...(record.threadFilterCwds || [])],
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    disabled: Boolean(record.disabled)
  };
}

export function findTokenRecord(store, id) {
  const normalized = normalizeTokenId(id);
  return store.tokens.find((entry) => entry.id === normalized) || null;
}
