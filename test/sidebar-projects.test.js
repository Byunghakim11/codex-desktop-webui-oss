import test from "node:test";
import assert from "node:assert/strict";

import { projectOverflowAction, sortProjectGroupsByActivity } from "../public/sidebar-projects.js";
import { THREAD_ACTIVITY, createThreadActivity } from "../public/thread-activity.js";

test("projects sort by attention first and recency second without alphabetical pinning", () => {
  const groups = [
    { key: "alpha", name: "Alpha", threads: [{ id: "old", updatedAt: 100 }] },
    { key: "zulu", name: "Zulu", threads: [{ id: "recent", updatedAt: 300 }] },
    { key: "middle", name: "Middle", threads: [{ id: "running", updatedAt: 50 }] }
  ];
  const activity = new Map([
    ["running", createThreadActivity({ state: THREAD_ACTIVITY.RUNNING })]
  ]);

  assert.deepEqual(
    sortProjectGroupsByActivity(groups, activity).map((group) => group.key),
    ["middle", "zulu", "alpha"]
  );
});

test("recent project order changes automatically when conversation activity changes", () => {
  const groups = [
    { key: "first", name: "First", threads: [{ id: "a", recencyAt: 500 }] },
    { key: "second", name: "Second", threads: [{ id: "b", recencyAt: 800 }] }
  ];
  assert.deepEqual(sortProjectGroupsByActivity(groups).map((group) => group.key), ["second", "first"]);
});

test("collapsed projects rely on the heading chevron without a redundant helper row", () => {
  assert.equal(projectOverflowAction({ collapsed: true, totalCount: 2, visibleCount: 0, expanded: false }), "none");
  assert.equal(projectOverflowAction({ collapsed: false, totalCount: 8, visibleCount: 6, expanded: false }), "expand");
  assert.equal(projectOverflowAction({ collapsed: false, totalCount: 8, visibleCount: 8, expanded: true }), "collapse");
});
