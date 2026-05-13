import { test } from "node:test";
import assert from "node:assert/strict";
import type { ResearchPlan } from "@mpfe/shared";
import { mergeResearchPlan, replaceResearchPlan } from "./state";

test("research_plan reducer merges parallel single-step updates without dropping siblings", () => {
  const base: ResearchPlan = {
    goal: "graph algorithms",
    steps: [
      {
        id: "s0",
        title: "BFS",
        queries: ["BFS"],
        status: "pending",
        picked_count: 0,
        scraped_count: 0,
        picked: [],
      },
      {
        id: "s1",
        title: "DFS",
        queries: ["DFS"],
        status: "pending",
        picked_count: 0,
        scraped_count: 0,
        picked: [],
      },
      {
        id: "s2",
        title: "Dijkstra",
        queries: ["Dijkstra"],
        status: "pending",
        picked_count: 0,
        scraped_count: 0,
        picked: [],
      },
    ],
  };

  const next = mergeResearchPlan(base, {
    goal: "graph algorithms",
    steps: [{ ...base.steps[1], status: "searching_urls" }],
  });

  assert.deepEqual(
    next?.steps.map((s) => [s.id, s.status]),
    [
      ["s0", "pending"],
      ["s1", "searching_urls"],
      ["s2", "pending"],
    ],
  );
});

test("research_plan reducer only wipes steps for explicit replacement", () => {
  const base: ResearchPlan = {
    goal: "old goal",
    steps: [
      {
        id: "s0",
        title: "old topic",
        queries: ["old topic"],
        status: "done",
        picked_count: 2,
        scraped_count: 2,
        picked: [],
      },
    ],
  };

  const mergedEmpty = mergeResearchPlan(base, { goal: "same cycle", steps: [] });
  assert.equal(mergedEmpty?.steps.length, 1);

  const replaced = mergeResearchPlan(
    base,
    replaceResearchPlan({ goal: "new goal", steps: [] }),
  );
  assert.equal(replaced?.goal, "new goal");
  assert.deepEqual(replaced?.steps, []);
});
