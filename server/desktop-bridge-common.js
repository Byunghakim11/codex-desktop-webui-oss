import { createHash, randomBytes } from "node:crypto";
import { mkdir, open, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveDataDir } from "./token-store.js";

export function desktopBridgePipePath() {
  const explicit = String(process.env.CODEX_DESKTOP_BRIDGE_PIPE || "").trim();
  if (explicit) return explicit;
  const userKey = createHash("sha256")
    .update(`${os.homedir()}\0${os.hostname()}`.toLowerCase())
    .digest("hex")
    .slice(0, 16);
  return process.platform === "win32"
    ? `\\\\.\\pipe\\codex-webui-desktop-${userKey}`
    : path.join(resolveDataDir(), `desktop-bridge-${userKey}.sock`);
}

export function desktopBridgeSecretPath() {
  return path.join(resolveDataDir(), "desktop-bridge", "secret");
}

export async function ensureDesktopBridgeSecret() {
  const secretPath = desktopBridgeSecretPath();
  await mkdir(path.dirname(secretPath), { recursive: true });
  try {
    return (await readFile(secretPath, "utf8")).trim();
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const secret = randomBytes(32).toString("base64url");
  try {
    const handle = await open(secretPath, "wx", 0o600);
    try {
      await handle.writeFile(`${secret}\n`, "utf8");
    } finally {
      await handle.close();
    }
    return secret;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    return (await readFile(secretPath, "utf8")).trim();
  }
}
