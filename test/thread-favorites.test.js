import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  createThreadFavorites,
  deriveFavoriteNamespace,
  safeThreadLink
} from "../public/ui/thread-favorites.js";

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem(key) { return data.has(key) ? data.get(key) : null; },
    setItem(key, value) { data.set(key, String(value)); },
    removeItem(key) { data.delete(key); }
  };
}

function brokenStorage({ failRead = false, failWrite = false } = {}) {
  return {
    getItem() {
      if (failRead) throw new Error("read denied");
      return null;
    },
    setItem() {
      if (failWrite) throw new Error("quota exceeded");
    }
  };
}

test("favorites store only thread ids under an opaque namespace", () => {
  const storage = memoryStorage();
  const favorites = createThreadFavorites({ storage, namespace: "ns-abc" });

  assert.equal(favorites.toggle("thread-1").changed, true);
  assert.equal(favorites.toggle("thread-2").changed, true);
  assert.equal(favorites.has("thread-1"), true);
  assert.deepEqual(favorites.listIds(), ["thread-1", "thread-2"]);

  const raw = [...storage.data.entries()];
  assert.equal(raw.length, 1);
  const [key, value] = raw[0];
  assert.equal(key, "codex-webui.favorites.v1:ns-abc");
  const parsed = JSON.parse(value);
  assert.deepEqual(parsed.ids, ["thread-1", "thread-2"]);
  // Only ids: no titles, previews, bodies, paths, cwd or tokens.
  assert.equal(JSON.stringify(parsed).includes("token"), false);
  assert.deepEqual(Object.keys(parsed).sort(), ["ids", "version"]);

  // Invalid ids are rejected without touching storage.
  const before = storage.data.get(key);
  assert.equal(favorites.toggle("").changed, false);
  assert.equal(favorites.toggle(null).changed, false);
  assert.equal(favorites.toggle("x".repeat(500)).changed, false);
  assert.equal(storage.data.get(key), before);
});

test("favorites cap additions without deleting existing entries", () => {
  const storage = memoryStorage();
  const favorites = createThreadFavorites({ storage, namespace: "cap", limit: 3 });
  assert.equal(favorites.toggle("a").changed, true);
  assert.equal(favorites.toggle("b").changed, true);
  assert.equal(favorites.toggle("c").changed, true);

  const overflow = favorites.toggle("d");
  assert.equal(overflow.changed, false);
  assert.equal(overflow.reason, "limit");
  assert.deepEqual(favorites.listIds(), ["a", "b", "c"]);

  // Removing then adding is still possible.
  assert.equal(favorites.remove("b").removed, true);
  assert.equal(favorites.toggle("d").changed, true);
  assert.deepEqual(favorites.listIds(), ["a", "c", "d"]);

  const events = [];
  favorites.subscribe((event) => events.push(event));
  favorites.toggle("e");
  assert.equal(events.at(-1).reason, "limit");
  assert.equal(events.at(-1).type, "error");
});

test("corrupt, unavailable and failing storage stay bounded and never silently delete", () => {
  const corrupt = memoryStorage({ "codex-webui.favorites.v1:ns": "{not json" });
  const corruptStore = createThreadFavorites({ storage: corrupt, namespace: "ns" });
  assert.deepEqual(corruptStore.listIds(), []);
  assert.equal(corruptStore.status().error.type, "corrupt");
  assert.equal(corrupt.data.get("codex-webui.favorites.v1:ns"), "{not json", "corrupt payload is preserved");

  const missing = createThreadFavorites({ storage: null, namespace: "ns-missing" });
  assert.deepEqual(missing.listIds(), []);
  assert.equal(missing.toggle("thread-1").changed, false);
  assert.equal(missing.toggle("thread-1").reason, "storage");
  assert.equal(missing.status().available, false);

  const failing = createThreadFavorites({ storage: brokenStorage({ failWrite: true }), namespace: "ns-fail" });
  const events = [];
  failing.subscribe((event) => events.push(event));
  const result = failing.toggle("thread-1");
  assert.equal(result.changed, false);
  assert.equal(result.persisted, false);
  assert.equal(result.reason, "storage");
  assert.deepEqual(failing.listIds(), [], "in-memory list is not advanced on a failed write");
  assert.equal(events.at(-1).type, "error");

  // Removal of a stored favorite must fail loudly rather than pretend success.
  const seeded = memoryStorage({ "codex-webui.favorites.v1:ns-rm": JSON.stringify({ version: 1, ids: ["keep"] }) });
  const storage = { getItem: (key) => seeded.getItem(key), setItem() { throw new Error("denied"); } };
  const removal = createThreadFavorites({ storage, namespace: "ns-rm" });
  const removeResult = removal.remove("keep");
  assert.equal(removeResult.removed, false);
  assert.equal(removeResult.reason, "storage");
  assert.deepEqual(removal.listIds(), ["keep"], "a failed delete keeps the favorite");

  const throwing = createThreadFavorites({ storage: brokenStorage({ failRead: true }), namespace: "ns-read" });
  assert.deepEqual(throwing.listIds(), []);
  assert.equal(throwing.status().error.type, "unavailable");
});

test("subscribe notifications can be unsubscribed and report ids only", () => {
  const storage = memoryStorage();
  const favorites = createThreadFavorites({ storage, namespace: "ns-sub" });
  const events = [];
  const unsubscribe = favorites.subscribe((event) => events.push(event));
  favorites.toggle("thread-9");
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "change");
  assert.deepEqual(events[0].ids, ["thread-9"]);
  unsubscribe();
  favorites.toggle("thread-10");
  assert.equal(events.length, 1);
});

test("namespace derivation is opaque, stable and token dependent", async () => {
  const fakeCrypto = {
    subtle: {
      async digest(_algorithm, bytes) {
        // Deterministic stand-in for SHA-256 over the delivered bytes.
        let hash = 0;
        for (const byte of bytes) hash = (hash * 31 + byte) >>> 0;
        return new Uint8Array([hash & 0xff, (hash >> 8) & 0xff, (hash >> 16) & 0xff, (hash >> 24) & 0xff]).buffer;
      }
    }
  };
  const first = await deriveFavoriteNamespace({ token: "secret-token", scope: "scope-a", cryptoImpl: fakeCrypto });
  const again = await deriveFavoriteNamespace({ token: "secret-token", scope: "scope-a", cryptoImpl: fakeCrypto });
  const otherToken = await deriveFavoriteNamespace({ token: "other-token", scope: "scope-a", cryptoImpl: fakeCrypto });
  const otherScope = await deriveFavoriteNamespace({ token: "secret-token", scope: "scope-b", cryptoImpl: fakeCrypto });

  assert.equal(first, again);
  assert.notEqual(first, otherToken);
  assert.notEqual(first, otherScope);
  assert.equal(/secret-token|other-token|scope-a/.test(first), false, "raw token and scope never leak");
  assert.match(first, /^[0-9a-f]+$/);

  const fallbackA = await deriveFavoriteNamespace({ token: "secret-token", scope: "scope-a", cryptoImpl: {} });
  const fallbackB = await deriveFavoriteNamespace({ token: "secret-token", scope: "scope-a", cryptoImpl: {} });
  assert.equal(fallbackA, fallbackB);
  assert.notEqual(fallbackA, await deriveFavoriteNamespace({ token: "other", scope: "scope-a", cryptoImpl: {} }));
});

test("share and open links discard current query, hash and credentials", () => {
  const href = "https://example.test/chat?thread=old&token=secret-token&x=1#frag";

  const link = safeThreadLink({ href, threadId: "thread-123" });
  const url = new URL(link);
  assert.equal(url.searchParams.get("thread"), "thread-123");
  assert.equal(url.searchParams.has("token"), false);
  assert.equal(url.searchParams.has("x"), false);
  assert.equal(url.hash, "");
  assert.equal(link.includes("secret-token"), false);
  assert.match(url.pathname, /\/chat$/);

  const credential = safeThreadLink({ href: "https://user:pass@example.test/ui?token=abc", threadId: "T1" });
  assert.equal(credential.includes("user:"), false);
  assert.equal(credential.includes("pass"), false);
  assert.equal(credential.includes("abc"), false);

  assert.equal(safeThreadLink({ href, threadId: "" }), null);
  assert.equal(safeThreadLink({ href: "not a url", threadId: "T1" }), null);
});

test("the favorites module never stores titles or paths and app code reselects only loaded threads", () => {
  const source = readFileSync(new URL("../public/ui/thread-favorites.js", import.meta.url), "utf8");
  assert.equal(/\.title\b/.test(source), false);
  assert.equal(/thread\.preview/.test(source), false);

  const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  // Favorite rendering filters the loaded thread list; it never fetches by id.
  assert.match(app, /favoriteThreads = filtered\.filter\(\(thread\) => threadFavorites\?\.has\(thread\.id\)\)/);
  assert.equal(/favoriteThreads[^\n]*loadThread\(/.test(app), false);
});
