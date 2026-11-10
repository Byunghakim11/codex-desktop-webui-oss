import test from "node:test";
import assert from "node:assert/strict";

import { formatResetTime, normalizeRateLimits, rateLimitWindowLabel } from "../public/rate-limits.js";

test("rate limit normalization accepts app-server camel and snake case windows", () => {
  const result = normalizeRateLimits({
    rateLimits: {
      planType: "plus",
      primary: { usedPercent: 28, windowDurationMins: 300, resetsAt: 1_800_000_000 },
      secondary: { used_percent: 61, window_minutes: 10080, resets_at: 1_800_604_800 }
    }
  });

  assert.equal(result.planType, "plus");
  assert.equal(result.windows.length, 2);
  assert.deepEqual(result.windows.map((window) => [window.usedPercent, window.remainingPercent, window.windowMinutes]), [
    [28, 72, 300],
    [61, 39, 10080]
  ]);
});

test("rate limit labels describe actual duration instead of inventing monthly quota", () => {
  assert.equal(rateLimitWindowLabel({ key: "primary", windowMinutes: 300 }), "5 hour");
  assert.equal(rateLimitWindowLabel({ key: "secondary", windowMinutes: 10080 }), "1 week");
  assert.equal(rateLimitWindowLabel({ key: "primary", windowMinutes: 0 }), "Primary");
});

test("reset formatting handles unix seconds and future relative hours", () => {
  const now = Date.UTC(2026, 7, 21, 8, 0, 0);
  assert.equal(formatResetTime((now + 90 * 60 * 1000) / 1000, "en-US", now), "2h");
});

test("missing rate limits degrade to an empty window list", () => {
  assert.deepEqual(normalizeRateLimits(null), { windows: [], planType: "", credits: null });
});

test("rate limit normalization includes model-specific limit groups without duplicating the default group", () => {
  const result = normalizeRateLimits({
    rateLimits: {
      limitId: "codex",
      primary: { usedPercent: 31, windowDurationMins: 10080 },
      planType: "pro"
    },
    rateLimitsByLimitId: {
      codex: {
        limitId: "codex",
        primary: { usedPercent: 31, windowDurationMins: 10080 },
        planType: "pro"
      },
      codex_fast: {
        limitId: "codex_fast",
        limitName: "Fast model",
        primary: { usedPercent: 5, windowDurationMins: 300 },
        secondary: { usedPercent: 10, windowDurationMins: 10080 }
      }
    }
  });

  assert.equal(result.windows.length, 3);
  assert.deepEqual(result.windows.map((window) => [window.limitId, window.limitName, window.slot]), [
    ["codex", "", "primary"],
    ["codex_fast", "Fast model", "primary"],
    ["codex_fast", "Fast model", "secondary"]
  ]);
});
