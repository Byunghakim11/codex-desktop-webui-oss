export function normalizeRateLimits(result) {
  const source = result?.rateLimits || result?.rate_limits || result || {};
  const groups = new Map();
  addGroup(groups, source, source.limitId || source.limit_id || "codex");
  const byLimitId = result?.rateLimitsByLimitId || result?.rate_limits_by_limit_id || source.rateLimitsByLimitId || {};
  if (byLimitId && typeof byLimitId === "object" && !Array.isArray(byLimitId)) {
    for (const [key, value] of Object.entries(byLimitId)) addGroup(groups, value, key);
  }

  const windows = [];
  for (const [limitId, group] of groups) {
    const limitName = String(group.limitName || group.limit_name || "");
    const named = [["primary", group.primary], ["secondary", group.secondary]];
    for (const [slot, value] of named) {
      const normalized = normalizeWindow(value, `${limitId}:${slot}`);
      if (normalized) windows.push({ ...normalized, limitId, limitName, slot });
    }

    const extra = group.windows || group.limits || [];
    if (Array.isArray(extra)) {
      for (const [index, value] of extra.entries()) {
        const slot = String(value?.id || value?.name || `window-${index + 1}`);
        const normalized = normalizeWindow(value, `${limitId}:${slot}`);
        if (normalized && !windows.some((window) => sameWindow(window, normalized))) {
          windows.push({ ...normalized, limitId, limitName, slot });
        }
      }
    }
  }

  return {
    windows,
    planType: String(source.planType || source.plan_type || result?.planType || result?.plan_type || ""),
    credits: normalizeCredits(source.credits)
  };
}

export function rateLimitWindowLabel(window, translate = (key, params) => fallbackLabel(key, params)) {
  const minutes = window?.windowMinutes || 0;
  if (minutes >= 40320 && minutes % 43200 === 0) {
    return translate("usage.months", { count: Math.round(minutes / 43200) });
  }
  if (minutes >= 10080 && minutes % 10080 === 0) {
    return translate("usage.weeks", { count: Math.round(minutes / 10080) });
  }
  if (minutes >= 1440 && minutes % 1440 === 0) {
    return translate("usage.days", { count: Math.round(minutes / 1440) });
  }
  if (minutes >= 60 && minutes % 60 === 0) {
    return translate("usage.hours", { count: Math.round(minutes / 60) });
  }
  if (minutes > 0) return translate("usage.minutes", { count: minutes });
  return translate(window?.slot === "secondary" || window?.key === "secondary" ? "usage.secondary" : "usage.primary", {});
}

export function formatResetTime(value, locale = "zh-CN", now = Date.now()) {
  const resetAt = normalizeResetAt(value);
  if (!resetAt) return "";
  const delta = resetAt - now;
  if (delta <= 0) return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(resetAt);
  const minutes = Math.ceil(delta / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(resetAt);
}

function normalizeWindow(value, key) {
  if (!value || typeof value !== "object") return null;
  const used = numberFrom(value.usedPercent, value.used_percent, value.utilization, value.percentUsed);
  const remaining = numberFrom(value.remainingPercent, value.remaining_percent, value.percentRemaining);
  if (used === null && remaining === null) return null;
  const usedPercent = clampPercent(used ?? 100 - remaining);
  return {
    key: String(key || value.id || "usage"),
    usedPercent,
    remainingPercent: clampPercent(100 - usedPercent),
    windowMinutes: Math.max(0, Math.round(numberFrom(
      value.windowMinutes,
      value.window_minutes,
      value.windowDurationMins,
      value.window_duration_mins,
      value.limitWindowSeconds ? Number(value.limitWindowSeconds) / 60 : null
    ) || 0)),
    resetsAt: normalizeResetAt(value.resetsAt || value.resets_at || value.resetAt || value.reset_at)
  };
}

function normalizeCredits(value) {
  if (!value || typeof value !== "object") return null;
  return {
    hasCredits: Boolean(value.hasCredits ?? value.has_credits),
    unlimited: Boolean(value.unlimited),
    balance: numberFrom(value.balance, value.remaining)
  };
}

function normalizeResetAt(value) {
  if (!value) return 0;
  if (typeof value === "number") return value < 100000000000 ? value * 1000 : value;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric < 100000000000 ? numeric * 1000 : numeric;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function numberFrom(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function clampPercent(value) {
  return Math.min(100, Math.max(0, Number(value) || 0));
}

function sameWindow(left, right) {
  return left.key === right.key;
}

function addGroup(groups, value, fallbackId) {
  if (!value || typeof value !== "object") return;
  const hasWindow = Boolean(value.primary || value.secondary || value.windows || value.limits);
  if (!hasWindow) return;
  const limitId = String(value.limitId || value.limit_id || fallbackId || "codex");
  groups.set(limitId, value);
}

function fallbackLabel(key, params = {}) {
  const count = params.count || 1;
  const labels = {
    "usage.months": `${count} month`,
    "usage.weeks": `${count} week`,
    "usage.days": `${count} day`,
    "usage.hours": `${count} hour`,
    "usage.minutes": `${count} minute`,
    "usage.primary": "Primary",
    "usage.secondary": "Secondary"
  };
  return labels[key] || key;
}
