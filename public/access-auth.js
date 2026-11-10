export function authenticatedUrl(input, token, base = globalThis.location?.origin || "http://localhost") {
  const url = new URL(input, base);
  const normalizedToken = String(token || "").trim();
  if (normalizedToken) url.searchParams.set("token", normalizedToken);
  return url.origin === new URL(base).origin
    ? `${url.pathname}${url.search}${url.hash}`
    : url.toString();
}

export function webSocketUrl(locationLike, token) {
  const protocol = locationLike.protocol === "https:" ? "wss:" : "ws:";
  const url = new URL(`${protocol}//${locationLike.host}/ws`);
  const normalizedToken = String(token || "").trim();
  if (normalizedToken) url.searchParams.set("token", normalizedToken);
  return url.toString();
}

export function authenticationAccepted(info) {
  return Boolean(info?.authenticated && ["token", "cloudflare-access"].includes(info?.authMode));
}

// Browsers hide the HTTP status of a failed WebSocket upgrade. Verify the
// same-origin HTTP session before asking the user to sign in again.
export async function probeAccessSession(fetchInfo) {
  try {
    const response = await fetchInfo();
    if (response.type === "opaqueredirect" || [401, 403].includes(response.status)) return "auth-required";
    if (!response.ok) return "unavailable";
    const info = await response.json();
    if (authenticationAccepted(info)) return "valid";
    return info?.authenticated === false ? "auth-required" : "unavailable";
  } catch { return "unavailable"; }
}
