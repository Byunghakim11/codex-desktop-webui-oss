import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { resolveDataDir, usageStorePath } from "./token-store.js";

const USAGE_VERSION = 1;

export function readUsageStore(dataDir = resolveDataDir()) {
  const filePath = usageStorePath(dataDir);
  if (!existsSync(filePath)) return { version: USAGE_VERSION, updatedAt: null, tokens: {} };
  try {
    const store = JSON.parse(readFileSync(filePath, "utf8"));
    if (store?.version !== USAGE_VERSION || typeof store.tokens !== "object") throw new Error("unsupported format");
    return store;
  } catch (error) {
    throw new Error(`Cannot read usage store ${filePath}: ${error.message}`);
  }
}

export function writeUsageStore(store, dataDir = resolveDataDir()) {
  mkdirSync(dataDir, { recursive: true });
  const filePath = usageStorePath(dataDir);
  const tempPath = `${filePath}.${process.pid}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  renameSync(tempPath, filePath);
}

export class UsageTracker {
  constructor(dataDir = resolveDataDir()) {
    this.dataDir = dataDir;
    this.store = readUsageStore(dataDir);
    this.dirty = false;
    this.timer = null;
  }

  record(tokenId, event = {}) {
    if (!tokenId) return;
    const now = new Date().toISOString();
    const current = this.store.tokens[tokenId] || {
      firstUsedAt: now,
      lastUsedAt: now,
      httpRequests: 0,
      wsConnections: 0,
      rpcRequests: 0,
      rpcErrors: 0,
      bytesIn: 0,
      bytesOut: 0,
      methods: {}
    };
    current.lastUsedAt = now;
    for (const key of ["httpRequests", "wsConnections", "rpcRequests", "rpcErrors", "bytesIn", "bytesOut"]) {
      current[key] = Math.max(0, Number(current[key]) || 0) + Math.max(0, Number(event[key]) || 0);
    }
    if (event.method) {
      const method = String(event.method);
      current.methods[method] = (Number(current.methods[method]) || 0) + 1;
    }
    this.store.tokens[tokenId] = current;
    this.store.updatedAt = now;
    this.dirty = true;
    this.scheduleFlush();
  }

  scheduleFlush() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 1000);
    this.timer.unref?.();
  }

  flush() {
    if (!this.dirty) return;
    writeUsageStore(this.store, this.dataDir);
    this.dirty = false;
  }
}

export function resetUsage(dataDir = resolveDataDir(), tokenId = "") {
  const store = readUsageStore(dataDir);
  if (tokenId) delete store.tokens[tokenId];
  else store.tokens = {};
  store.updatedAt = new Date().toISOString();
  writeUsageStore(store, dataDir);
}
