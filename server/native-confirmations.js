import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { canonicalJson, NativeActionError, nativeFail } from "./native-capabilities.js";

export const DEFAULT_CONFIRMATION_TTL_MS = 5 * 60 * 1000;
const MAX_CONFIRMATION_TTL_MS = 60 * 60 * 1000;
const RECEIPT_ID = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const RECEIPT_VERSION = 1;

export class NativeConfirmationError extends NativeActionError {
  constructor(status, code) {
    super(status, code);
    this.name = "NativeConfirmationError";
  }
}

const failConfirmation = (status, code) => new NativeConfirmationError(status, code);

// Server-scope derived principal. Scope objects are created by the authenticated server request
// path (server/index.js); no client credentials or ids are consulted here.
export function principalFromScope(scope) {
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) throw nativeFail(403, "AUTH_PRINCIPAL_REQUIRED");
  const parts = [];
  for (const key of ["authMode", "tokenHash", "id", "accessEmail"]) {
    const value = scope[key];
    if (typeof value === "string" && value.length > 0 && value.length <= 512) parts.push(`${key}=${value}`);
  }
  if (!parts.length) throw nativeFail(403, "AUTH_PRINCIPAL_REQUIRED");
  return createHash("sha256").update(parts.join("\u0000")).digest("hex");
}

export function digestParams(params) {
  return createHash("sha256").update(canonicalJson(params ?? {})).digest("hex");
}

export function digestState(state) {
  if (typeof state === "string" && HEX64.test(state)) return state;
  return createHash("sha256").update(canonicalJson(state ?? null)).digest("hex");
}

function resolveNow(now) {
  const value = typeof now === "function" ? now() : Date.now();
  if (!Number.isFinite(value) || value < 0) throw nativeFail(500, "CLOCK_UNAVAILABLE");
  return value;
}

function confirmationDir(dataDir) {
  if (typeof dataDir !== "string" || !dataDir) throw nativeFail(500, "DATA_DIR_REQUIRED");
  return path.join(dataDir, "native-confirmations");
}

function receiptPath(dataDir, id) {
  if (typeof id !== "string" || !RECEIPT_ID.test(id)) throw failConfirmation(400, "INVALID_CONFIRMATION_ID");
  return path.join(confirmationDir(dataDir), `${id}.json`);
}

function requireBoundString(value, code) {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) throw failConfirmation(400, code);
  return value;
}

export function createConfirmationStore({ dataDir, now = () => Date.now(), ttlMs = DEFAULT_CONFIRMATION_TTL_MS } = {}) {
  if (typeof dataDir !== "string" || !dataDir) throw nativeFail(500, "DATA_DIR_REQUIRED");
  if (typeof ttlMs !== "number" || !Number.isInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_CONFIRMATION_TTL_MS) {
    throw nativeFail(500, "INVALID_CONFIRMATION_TTL");
  }

  async function issue({ principal, action, threadId, paramsDigest, stateDigest }) {
    requireBoundString(principal, "INVALID_CONFIRMATION_BINDING");
    requireBoundString(action, "INVALID_CONFIRMATION_BINDING");
    requireBoundString(threadId, "INVALID_CONFIRMATION_BINDING");
    if (typeof paramsDigest !== "string" || !HEX64.test(paramsDigest)) throw failConfirmation(400, "INVALID_CONFIRMATION_BINDING");
    if (typeof stateDigest !== "string" || !HEX64.test(stateDigest)) throw failConfirmation(400, "INVALID_CONFIRMATION_BINDING");
    const createdAt = resolveNow(now);
    const id = randomBytes(16).toString("hex");
    const receipt = {
      version: RECEIPT_VERSION,
      id,
      principal,
      action,
      threadId,
      paramsDigest,
      stateDigest,
      createdAt,
      expiresAt: createdAt + ttlMs
    };
    const dir = confirmationDir(dataDir);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `${id}.json`);
    await fs.writeFile(file, `${JSON.stringify(receipt)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return Object.freeze({ id, action, threadId, expiresAt: receipt.expiresAt });
  }

  async function consume({ id, principal, action, threadId, paramsDigest, stateDigest }) {
    const file = receiptPath(dataDir, id);
    let raw;
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw failConfirmation(409, "CONFIRMATION_INVALID");
      raw = await fs.readFile(file, "utf8");
    } catch (error) {
      if (error instanceof NativeActionError) throw error;
      if (error?.code === "ENOENT") throw failConfirmation(409, "CONFIRMATION_REPLAY");
      throw failConfirmation(409, "CONFIRMATION_INVALID");
    }

    let receipt;
    try {
      receipt = JSON.parse(raw);
    } catch {
      throw failConfirmation(409, "CONFIRMATION_INVALID");
    }
    if (!receipt || receipt.version !== RECEIPT_VERSION || receipt.id !== id) throw failConfirmation(409, "CONFIRMATION_INVALID");

    if (resolveNow(now) >= Number(receipt.expiresAt)) {
      await fs.unlink(file).catch(() => {});
      throw failConfirmation(410, "CONFIRMATION_EXPIRED");
    }
    if (receipt.principal !== principal) throw failConfirmation(403, "CONFIRMATION_PRINCIPAL_MISMATCH");
    if (receipt.action !== action) throw failConfirmation(409, "CONFIRMATION_ACTION_MISMATCH");
    if (receipt.threadId !== threadId) throw failConfirmation(409, "CONFIRMATION_TARGET_MISMATCH");
    if (receipt.paramsDigest !== paramsDigest) throw failConfirmation(409, "CONFIRMATION_PARAMS_MISMATCH");
    if (receipt.stateDigest !== stateDigest) throw failConfirmation(409, "CONFIRMATION_STALE");

    try {
      await fs.unlink(file);
    } catch (error) {
      if (error?.code === "ENOENT") throw failConfirmation(409, "CONFIRMATION_REPLAY");
      throw failConfirmation(409, "CONFIRMATION_INVALID");
    }
    return Object.freeze({ id, action: receipt.action, threadId: receipt.threadId, expiresAt: receipt.expiresAt });
  }

  return Object.freeze({ issue, consume });
}
