import path from "node:path";

export function canReceiveThreadContext(scope, context) {
  const roots = scopeRoots(scope);
  if (!context?.threadId || !roots.length) return true;
  if (scope?.visibleThreadIds?.has(context.threadId)) return true;
  const cwd = normalizeLocalPath(context.thread?.cwd || "");
  if (!cwd || !roots.some((root) => isPathInside(root, cwd))) return false;
  scope?.visibleThreadIds?.add(context.threadId);
  return true;
}

function scopeRoots(scope) {
  const values = Array.isArray(scope?.threadFilterCwds) && scope.threadFilterCwds.length
    ? scope.threadFilterCwds
    : scope?.threadFilterCwd
      ? [scope.threadFilterCwd]
      : [];
  return values.map(normalizeLocalPath).filter(Boolean);
}

function normalizeLocalPath(value) {
  if (!value) return "";
  let next = String(value);
  if (/^\/[a-zA-Z]:\//.test(next)) next = next.slice(1);
  return path.resolve(next);
}

function isPathInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
