import { createPublicKey, verify as verifySignature } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const CONFIG_FILE_NAME = "cloudflare-access.json";
const DEFAULT_JWKS_TTL_MS = 5 * 60 * 1000;
const CLOCK_SKEW_SECONDS = 60;

export function cloudflareAccessConfigPath(dataDir) {
  return path.join(dataDir, CONFIG_FILE_NAME);
}

export function readCloudflareAccessConfig(dataDir) {
  const filePath = cloudflareAccessConfigPath(dataDir);
  if (!existsSync(filePath)) return null;
  const parsed = JSON.parse(readFileSync(filePath, "utf8"));
  return normalizeCloudflareAccessConfig(parsed);
}

export function normalizeCloudflareAccessConfig(value = {}) {
  const teamDomain = String(value.teamDomain || "").trim().toLowerCase();
  const audience = String(value.audience || "").trim();
  const allowedEmails = Array.from(new Set(
    (Array.isArray(value.allowedEmails) ? value.allowedEmails : [value.allowedEmail])
      .map((entry) => String(entry || "").trim().toLowerCase())
      .filter(Boolean)
  ));
  const tokenScopeId = String(value.tokenScopeId || "").trim();

  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(teamDomain)) {
    throw new Error("Cloudflare Access teamDomain must be a cloudflareaccess.com hostname.");
  }
  if (!audience || audience.length > 256) {
    throw new Error("Cloudflare Access audience is required.");
  }
  if (!allowedEmails.length || allowedEmails.some((email) => !email.includes("@"))) {
    throw new Error("Cloudflare Access allowedEmails must contain at least one email address.");
  }

  return { teamDomain, audience, allowedEmails, tokenScopeId };
}

export class CloudflareAccessAuthenticator {
  constructor(config, { fetchImpl = globalThis.fetch, now = () => Date.now() } = {}) {
    this.config = config ? normalizeCloudflareAccessConfig(config) : null;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.jwks = null;
    this.jwksExpiresAt = 0;
  }

  async authenticateRequest(req) {
    if (!this.config) return null;
    const assertion = firstHeaderValue(req?.headers?.["cf-access-jwt-assertion"]);
    if (!assertion) return null;
    const jwks = await this.getJwks();
    return verifyCloudflareAccessJwt(assertion, this.config, { jwks, now: this.now() });
  }

  async getJwks() {
    if (this.jwks && this.jwksExpiresAt > this.now()) return this.jwks;
    if (typeof this.fetchImpl !== "function") throw new Error("Cloudflare Access certificate fetch is unavailable.");
    const response = await this.fetchImpl(`https://${this.config.teamDomain}/cdn-cgi/access/certs`, {
      headers: { accept: "application/json" }
    });
    if (!response.ok) throw new Error(`Cloudflare Access certificate request failed (${response.status}).`);
    const body = await response.json();
    if (!Array.isArray(body?.keys) || !body.keys.length) {
      throw new Error("Cloudflare Access returned no signing keys.");
    }
    this.jwks = body.keys;
    this.jwksExpiresAt = this.now() + cacheTtlMs(response.headers?.get?.("cache-control"));
    return this.jwks;
  }
}

export function verifyCloudflareAccessJwt(token, config, { jwks, now = Date.now() } = {}) {
  const normalizedConfig = normalizeCloudflareAccessConfig(config);
  const parts = String(token || "").split(".");
  if (parts.length !== 3 || parts.some((part) => !part)) throw new Error("Invalid Cloudflare Access JWT.");

  const header = parseJwtPart(parts[0]);
  const payload = parseJwtPart(parts[1]);
  if (header.alg !== "RS256" || !header.kid) throw new Error("Unsupported Cloudflare Access JWT algorithm.");
  const jwk = (Array.isArray(jwks) ? jwks : []).find((entry) => entry?.kid === header.kid);
  if (!jwk) throw new Error("Cloudflare Access signing key was not found.");

  const signatureValid = verifySignature(
    "RSA-SHA256",
    Buffer.from(`${parts[0]}.${parts[1]}`),
    createPublicKey({ key: jwk, format: "jwk" }),
    decodeBase64Url(parts[2])
  );
  if (!signatureValid) throw new Error("Cloudflare Access JWT signature is invalid.");

  const nowSeconds = Math.floor(Number(now) / 1000);
  const expectedIssuer = `https://${normalizedConfig.teamDomain}`;
  if (payload.iss !== expectedIssuer) throw new Error("Cloudflare Access JWT issuer is invalid.");
  const audiences = Array.isArray(payload.aud) ? payload.aud.map(String) : [String(payload.aud || "")];
  if (!audiences.includes(normalizedConfig.audience)) throw new Error("Cloudflare Access JWT audience is invalid.");
  if (!Number.isFinite(Number(payload.exp)) || Number(payload.exp) <= nowSeconds - CLOCK_SKEW_SECONDS) {
    throw new Error("Cloudflare Access JWT has expired.");
  }
  if (Number.isFinite(Number(payload.nbf)) && Number(payload.nbf) > nowSeconds + CLOCK_SKEW_SECONDS) {
    throw new Error("Cloudflare Access JWT is not active yet.");
  }

  const email = String(payload.email || "").trim().toLowerCase();
  if (!normalizedConfig.allowedEmails.includes(email)) {
    throw new Error(`Cloudflare Access identity is not allowed for this WebUI (signed in as ${email || "unknown email"}).`);
  }
  return {
    email,
    subject: String(payload.sub || ""),
    expiresAt: Number(payload.exp)
  };
}

function parseJwtPart(value) {
  try {
    return JSON.parse(decodeBase64Url(value).toString("utf8"));
  } catch {
    throw new Error("Cloudflare Access JWT contains invalid JSON.");
  }
}

function decodeBase64Url(value) {
  return Buffer.from(String(value || ""), "base64url");
}

function firstHeaderValue(value) {
  return Array.isArray(value) ? String(value[0] || "") : String(value || "");
}

function cacheTtlMs(cacheControl) {
  const match = /(?:^|,)\s*max-age=(\d+)/i.exec(String(cacheControl || ""));
  if (!match) return DEFAULT_JWKS_TTL_MS;
  return Math.max(30_000, Math.min(Number(match[1]) * 1000, 24 * 60 * 60 * 1000));
}
