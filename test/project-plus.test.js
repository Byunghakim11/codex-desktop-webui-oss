import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { authoritativeProjectCwd, projectGroupKey } from "../public/sidebar-projects.js";
import { createDirtyGuard, createTransitionController, snapshotPendingState } from "../public/ui/dirty-guard.js";

const appSource = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

function appFunctionSource(name) {
  const start = appSource.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing app function ${name}`);
  const end = appSource.indexOf("\n}", start) + 2;
  return appSource.slice(start, end);
}

test("project group keys stay distinct for case/Unicode-different cwds", () => {
  const upper = projectGroupKey("C:\\Repo\\Alpha");
  const lower = projectGroupKey("c:\\repo\\alpha");
  const same = projectGroupKey("C:\\Repo\\Alpha");
  assert.notEqual(upper, lower, "case-different cwds must not merge into one group target");
  assert.equal(upper, same);
  assert.equal(projectGroupKey("C:\\Repo\\Alpha\\"), upper, "trailing separators fold but exact bytes stay");
});

test("the plus target is the group's own authoritative cwd, never the selected project", () => {
  const group = { cwd: "C:\\Work\\Zeta", name: "Zeta", threads: [{ id: "t1", cwd: "C:\\Work\\Zeta" }] };
  assert.equal(authoritativeProjectCwd({ group, scopedCwds: ["C:\\Work\\Zeta"] }), "C:\\Work\\Zeta");

  // A different current selection is not part of the decision at all.
  assert.equal(
    authoritativeProjectCwd({ group, scopedCwds: ["C:\\Work\\Other"], selectedCwd: "C:\\Work\\Other" }),
    "C:\\Work\\Zeta"
  );

  // Exact scoped root spellings win over case-folded matches.
  assert.equal(
    authoritativeProjectCwd({ group: { cwd: "C:\\Repo\\Alpha", threads: [] }, scopedCwds: ["c:\\repo\\alpha"] }),
    "c:\\repo\\alpha"
  );

  // Two groups differing only by case keep their own targets.
  const other = { cwd: "c:\\repo\\alpha", threads: [] };
  assert.equal(authoritativeProjectCwd({ group: other }), "c:\\repo\\alpha");
  assert.notEqual(authoritativeProjectCwd({ group: other }), authoritativeProjectCwd({ group: { cwd: "C:\\Repo\\Alpha" } }));

  assert.equal(authoritativeProjectCwd({ group: { threads: [] } }), "");
});

test("pending attachments, sends and unsaved files block a context transition", async () => {
  const probes = {
    attachmentDraft: () => true,
    pendingCommit: () => false,
    fileEditorDirty: false
  };
  assert.deepEqual(snapshotPendingState(probes).reasons, ["attachmentDraft"]);

  const blocked = [];
  const guard = createDirtyGuard({ probes, onBlocked: (reason) => blocked.push(reason) });
  assert.equal(await guard.requestTransition("project-plus"), false);
  assert.deepEqual(blocked, ["project-plus"]);

  // Composer text alone is preserved by the drafts controller, not blocked here.
  const composerOnly = createDirtyGuard({ probes: { composerDraft: () => true } });
  assert.equal(await composerOnly.requestTransition("thread-open", { confirm: () => true }), true);

  const confirmations = [];
  const confirming = createDirtyGuard({
    probes: { fileEditorDirty: true },
    confirm: ({ reasons }) => {
      confirmations.push(reasons);
      return true;
    }
  });
  assert.equal(await confirming.requestTransition("files-target"), true);
  assert.deepEqual(confirmations, [["fileEditorDirty"]]);
});

test("beforeContextChange is awaited and false blocks the real switch", async () => {
  const order = [];
  let hookResolve;
  const hook = () => new Promise((resolve) => {
    order.push("hook-start");
    hookResolve = resolve;
  });
  const controller = createTransitionController({ getBeforeContextChange: () => hook });
  const pending = controller.run("thread-open", () => order.push("action"));
  assert.deepEqual(order, ["hook-start"]);
  hookResolve(false);
  const result = await pending;
  assert.deepEqual(result.ok, false);
  assert.deepEqual(result.blocked, true);
  assert.deepEqual(order, ["hook-start"], "action never ran while the panel hook rejected");

  const allowing = createTransitionController({ getBeforeContextChange: async () => true });
  const allowed = await allowing.run("thread-open", () => "switched");
  assert.equal(allowed.ok, true);
  assert.equal(allowed.value, "switched");

  const throwing = createTransitionController({
    getBeforeContextChange: () => { throw new Error("panel busy"); },
    onError: () => {}
  });
  const failed = await throwing.run("thread-open", () => "should-not-run");
  assert.equal(failed.ok, false);
  assert.equal(failed.blocked, true);
  assert.equal(failed.value, undefined, "a failing hook getter never runs the action");
});

test("a newer navigation invalidates a transition that finished its async guard late", async () => {
  let release;
  let calls = 0;
  const controller = createTransitionController({
    getBeforeContextChange: () => new Promise((resolve) => {
      calls += 1;
      if (calls === 1) release = () => resolve(true);
      else resolve(true);
    })
  });

  const first = controller.run("thread-open", () => "first");
  const second = controller.run("project-plus", () => "second");
  release();
  const firstResult = await first;
  assert.equal(firstResult.ok, false);
  assert.equal(firstResult.stale, true);
  assert.equal(firstResult.value, undefined, "late navigation never applies its action");
  assert.equal((await second).value, "second");
});

test("app wires project +, requested cwd and the transition guard for real", () => {
  const renderGroup = appFunctionSource("renderProjectGroup");
  assert.match(renderGroup, /project-heading-row/);
  assert.match(renderGroup, /project-new-thread/);
  // The + is a separate sibling button, not nested inside the disclosure button.
  assert.equal(/project-new-thread[^`]*<\/button>\s*<\/button>/.test(renderGroup), false);
  assert.match(renderGroup, /authoritativeProjectCwd\(\{ group, scopedCwds: state\.threadFilterCwds \}\)/);
  assert.match(renderGroup, /startProjectThread\(projectCwd\)/);
  assert.equal(/startProjectThread\(els\.projectSelect\.value/.test(renderGroup), false);

  const createThread = appFunctionSource("createThread");
  assert.match(createThread, /requestedCwd/);
  assert.match(createThread, /const cwd = requestedCwd \|\| els\.projectSelect\.value \|\| preferredScopedCwd\(\)/);

  const startProjectThread = appFunctionSource("startProjectThread");
  assert.match(startProjectThread, /transitionController\.run\(\"project-plus\"/);
  assert.match(startProjectThread, /createThread\(\{ cwd: targetCwd \}\)/);
  assert.match(startProjectThread, /state\.currentThread\?\.cwd === targetCwd/);

  const openThread = appFunctionSource("openThread");
  assert.match(openThread, /transitionController\.prepare\(\"thread-open\"\)/);
  assert.match(openThread, /isCurrent\(prepared\.token\)/);

  assert.match(appSource, /projectGroupKey\(cwd\)/);
  assert.match(appSource, /contextMenu\?\.close\(\{ restoreFocus: false \}\)/);
});
