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

function threadTimestampMs(thread) {
  const value = thread?.recencyAt || thread?.updatedAt || thread?.createdAt || 0;
  if (typeof value === "number") return value < 100000000000 ? value * 1000 : value;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric < 100000000000 ? numeric * 1000 : numeric;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}
