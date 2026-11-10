import os from "node:os";

export function getLanUrls(port, networkInterfaces = os.networkInterfaces()) {
  const candidates = [];
  let order = 0;

  for (const entries of Object.values(networkInterfaces || {})) {
    for (const entry of entries || []) {
      const address = String(entry?.address || "");
      if ((entry?.family !== "IPv4" && entry?.family !== 4) || entry?.internal || !isUsableLanIpv4(address)) {
        continue;
      }
      candidates.push({
        url: `http://${address}:${port}`,
        priority: isPrivateIpv4(address) ? 0 : 1,
        order: order++
      });
    }
  }

  const urls = candidates
    .sort((left, right) => left.priority - right.priority || left.order - right.order)
    .map((candidate) => candidate.url);
  return urls.length ? [...new Set(urls)] : [`http://localhost:${port}`];
}

export function getPrimaryLanUrl(port, networkInterfaces = os.networkInterfaces()) {
  return getLanUrls(port, networkInterfaces)[0];
}

function isUsableLanIpv4(address) {
  const octets = ipv4Octets(address);
  if (!octets) return false;
  const [first, second] = octets;
  if (first === 0 || first === 127 || first >= 224) return false;
  if (first === 169 && second === 254) return false;
  if (first === 198 && (second === 18 || second === 19)) return false;
  return true;
}

function isPrivateIpv4(address) {
  const octets = ipv4Octets(address);
  if (!octets) return false;
  const [first, second] = octets;
  return first === 10
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168);
}

function ipv4Octets(address) {
  const parts = String(address).split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => Number(part));
  if (octets.some((part, index) => !Number.isInteger(part) || part < 0 || part > 255 || String(part) !== parts[index])) {
    return null;
  }
  return octets;
}
