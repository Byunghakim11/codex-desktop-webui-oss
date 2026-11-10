import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";

export function workspaceRoots(scopeRoots = [], platform = process.platform) {
  const scoped = uniquePaths(scopeRoots);
  if (scoped.length) return scoped.filter(isExistingDirectory).map(resolveExistingPath);
  if (platform === "win32") {
    const roots = [];
    for (let code = 65; code <= 90; code += 1) {
      const root = `${String.fromCharCode(code)}:\\`;
      if (isExistingDirectory(root)) roots.push(resolveExistingPath(root));
    }
    return roots;
  }
  return [path.parse(path.resolve("/")).root];
}

export function listWorkspaceDirectories(requestedPath, { scopeRoots = [], platform = process.platform } = {}) {
  const roots = workspaceRoots(scopeRoots, platform);
  if (!requestedPath) {
    return {
      path: null,
      parent: null,
      roots: roots.map(workspaceEntry),
      directories: []
    };
  }

  const directory = resolveAllowedDirectory(requestedPath, roots, scopeRoots);
  const directories = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => workspaceEntry(path.join(directory, entry.name)))
    .sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
  const parentPath = path.dirname(directory);

  return {
    path: directory,
    parent: canUseWorkspacePath(parentPath, roots) && parentPath !== directory ? parentPath : null,
    roots: roots.map(workspaceEntry),
    directories
  };
}

export async function createWorkspaceDirectory(parentPath, name, options = {}) {
  const roots = workspaceRoots(options.scopeRoots || [], options.platform || process.platform);
  const parent = resolveAllowedDirectory(parentPath, roots, options.scopeRoots || []);
  const safeName = validateWorkspaceName(name, options.platform || process.platform);
  const target = path.resolve(parent, safeName);
  if (path.dirname(target) !== parent) throw new Error("Workspace name must be one directory segment.");
  if (!canUseWorkspacePath(target, roots)) {
    throw new Error("Workspace path is outside the allowed directory scope.");
  }
  if (existsSync(target)) throw new Error("A file or directory with this name already exists.");
  await mkdir(target);
  return workspaceEntry(target);
}

export function canUseWorkspacePath(value, roots) {
  if (!value || !path.isAbsolute(String(value))) return false;
  const target = path.resolve(String(value));
  return (roots || []).some((root) => isPathInside(root, target));
}

export function validateWorkspaceName(value, platform = process.platform) {
  const name = String(value || "").trim();
  if (!name || name === "." || name === ".." || name.length > 128) {
    throw new Error("Workspace name must contain 1 to 128 characters.");
  }
  if (/[\\/\0]/.test(name)) throw new Error("Workspace name cannot contain path separators.");
  if (platform === "win32") {
    if (/[<>:"|?*]/.test(name) || /[. ]$/.test(name)) {
      throw new Error("Workspace name contains characters Windows does not allow.");
    }
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(name)) {
      throw new Error("Workspace name is reserved by Windows.");
    }
  }
  return name;
}

function resolveAllowedDirectory(value, roots, scopeRoots) {
  if (!path.isAbsolute(String(value || ""))) throw new Error("Workspace path must be absolute.");
  const directory = resolveExistingPath(String(value));
  if (!canUseWorkspacePath(directory, roots)) {
    throw new Error("Workspace path is outside the allowed directory scope.");
  }
  if (!isExistingDirectory(directory)) throw new Error("Workspace directory does not exist.");
  return directory;
}

function uniquePaths(values) {
  return [...new Map(
    (values || [])
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .map((value) => [path.resolve(value).toLowerCase(), path.resolve(value)])
  ).values()];
}

function workspaceEntry(value) {
  const resolved = path.resolve(value);
  return {
    name: path.basename(resolved) || resolved,
    path: resolved
  };
}

function isExistingDirectory(value) {
  try {
    return existsSync(value) && statSync(value).isDirectory();
  } catch {
    return false;
  }
}

function resolveExistingPath(value) {
  return path.resolve(realpathSync(value));
}

function isPathInside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
