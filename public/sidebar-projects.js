import { activityPriority, createThreadActivity } from "./thread-activity.js";

export function sortProjectGroupsByActivity(groups, activityByThread = new Map()) {
  return [...(groups || [])].sort((left, right) => {
    const leftRank = projectGroupRank(left, activityByThread);
    const rightRank = projectGroupRank(right, activityByThread);
    if (leftRank.attention !== rightRank.attention) return leftRank.attention - rightRank.attention;
    if (leftRank.updatedAt !== rightRank.updatedAt) return rightRank.updatedAt - leftRank.updatedAt;
    return String(left?.name || "").localeCompare(String(right?.name || ""));
  });
}

export function projectGroupRank(group, activityByThread = new Map()) {
  const threads = group?.threads || [];
  return {
    attention: Math.min(4, ...threads.map((thread) =>
      activityPriority(activityByThread.get(thread?.id) || createThreadActivity())
    )),
    updatedAt: Math.max(0, ...threads.map(threadTimestampMs))
  };
}

export function projectOverflowAction({ collapsed, totalCount, visibleCount, expanded }) {
  if (collapsed) return "none";
  if (Number(totalCount) > Number(visibleCount)) return "expand";
  if (expanded && Number(totalCount) > 6) return "collapse";
  return "none";
}

// Group keys keep the exact cwd alongside the folded comparison form so two
// paths that differ only by case/Unicode never collapse into one target.
export function projectGroupKey(cwd) {
  const trimmed = String(cwd ?? "").trim();
  const exact = trimmed.replace(/[\\/]+$/, "");
  const folded = exact.replaceAll("\\", "/").toLowerCase();
  return `${folded}\u0000${exact}`;
}

// The per-project "+" must use THAT group's own authoritative cwd. The current
// project selection is never consulted, and an exact scoped root wins so the
// server-side scoped authority string is preserved byte for byte.
export function authoritativeProjectCwd({ group, scopedCwds = [] } = {}) {
  const candidates = [];
  const push = (value) => {
    const text = String(value ?? "").trim();
    if (text && !candidates.includes(text)) candidates.push(text);
  };
  push(group?.cwd);
  for (const thread of group?.threads || []) push(thread?.cwd);
  if (!candidates.length) return "";
  const scoped = (Array.isArray(scopedCwds) ? scopedCwds : [])
    .map((value) => String(value ?? "").trim())
    .filter(Boolean);
  for (const candidate of candidates) {
    if (scoped.includes(candidate)) return candidate;
  }
  for (const candidate of candidates) {
    const folded = candidate.replaceAll("\\", "/").toLowerCase();
    const match = scoped.find((root) => root.replaceAll("\\", "/").toLowerCase() === folded);
    if (match) return match;
  }
  return candidates[0];
}

function threadTimestampMs(thread) {
  const value = thread?.recencyAt || thread?.updatedAt || thread?.createdAt || 0;
  if (typeof value === "number") return value < 100000000000 ? value * 1000 : value;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric < 100000000000 ? numeric * 1000 : numeric;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}
