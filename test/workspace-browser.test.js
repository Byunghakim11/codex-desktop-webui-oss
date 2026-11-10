import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createWorkspaceDirectory,
  listWorkspaceDirectories,
  validateWorkspaceName
} from "../server/workspace-browser.js";

test("scoped workspace browsing and creation stay inside the allowed root", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-webui-workspace-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "existing"));

  const listing = listWorkspaceDirectories(root, { scopeRoots: [root] });
  assert.deepEqual(listing.directories.map((entry) => entry.name), ["existing"]);
  assert.equal(listing.parent, null);

  const created = await createWorkspaceDirectory(root, "new-project", { scopeRoots: [root] });
  assert.equal(created.path, path.join(root, "new-project"));
  assert.throws(
    () => listWorkspaceDirectories(path.dirname(root), { scopeRoots: [root] }),
    /outside the allowed directory scope/
  );
});

test("workspace names reject traversal and Windows reserved names", () => {
  assert.throws(() => validateWorkspaceName("../escape", "win32"), /path separators/);
  assert.throws(() => validateWorkspaceName("CON", "win32"), /reserved/);
  assert.equal(validateWorkspaceName("codex-project", "win32"), "codex-project");
});
