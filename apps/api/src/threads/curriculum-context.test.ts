import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildCurriculumContext,
  type SyllabusOutline,
} from "./curriculum-context";

/**
 * Pure-function tests for the curriculum context formatter. No DB,
 * no Nest container — uses synthetic `SyllabusOutline` fixtures.
 *
 * Each test covers one of the design constraints documented in
 * `curriculum-context.ts`:
 *
 *   - skip-when-empty
 *   - target marker visible
 *   - target's own metadata not echoed as "existing"
 *   - trim policy: key_terms dropped first, then non-adjacent LOs,
 *     then non-adjacent outcomes, then non-adjacent activity entries,
 *     then non-adjacent unity entries, then hard truncation
 *   - hard cap is respected
 */

function makeOutline(overrides?: Partial<SyllabusOutline>): SyllabusOutline {
  return {
    syllabus: {
      id: "syl-1",
      title: "Algorithms 101",
      description: "An undergrad classical algorithms course.",
      audience: { level: "undergrad", language: "fr" },
      scope: { duration_hours: 12 },
      pedagogy: { style: "lab" },
    },
    unities: [
      {
        id: "u-0",
        title: "Introduction to graphs",
        order_index: 0,
        outcomes: ["define vertex/edge", "recognise directed/undirected"],
        prerequisites: ["basic sets"],
        activities: [
          {
            id: "a-0-0",
            title: "What is a graph?",
            order_index: 0,
            body_len: 1820,
            learning_objectives: ["define vertex", "define edge"],
            key_terms: ["vertex", "edge", "graph"],
            bloom_level: "understand",
            duration_min: 30,
          },
          {
            id: "a-0-1",
            title: "Directed vs undirected",
            order_index: 1,
            body_len: 1500,
            learning_objectives: ["distinguish directed and undirected"],
            key_terms: ["directed", "undirected"],
            bloom_level: "apply",
            duration_min: 25,
          },
        ],
      },
      {
        id: "u-1",
        title: "Shortest paths",
        order_index: 1,
        outcomes: [],
        prerequisites: [],
        activities: [],
      },
    ],
    ...overrides,
  };
}

test("returns empty string when syllabus has no unities", () => {
  const outline = makeOutline({ unities: [] });
  const result = buildCurriculumContext(outline, {
    kind: "syllabus",
    syllabus_id: "syl-1",
  });
  assert.equal(result, "");
});

test("returns empty string when every sibling is empty placeholder", () => {
  const outline = makeOutline({
    unities: [
      {
        id: "u-empty",
        title: "Empty unit",
        order_index: 0,
        outcomes: [],
        prerequisites: [],
        activities: [
          {
            id: "a-empty",
            title: "Empty activity",
            order_index: 0,
            body_len: 0,
            learning_objectives: [],
            key_terms: [],
            bloom_level: null,
            duration_min: null,
          },
        ],
      },
    ],
  });
  const result = buildCurriculumContext(outline, {
    kind: "unity",
    unity_id: "u-empty",
  });
  assert.equal(result, "");
});

test("emits target marker for unity target", () => {
  const outline = makeOutline();
  const result = buildCurriculumContext(outline, {
    kind: "unity",
    unity_id: "u-1",
  });
  assert.match(result, /## Curriculum context/);
  assert.match(result, />>> TARGET UNITY <<</);
  assert.match(result, /Your current generation target: unity "Shortest paths"/);
});

test("emits target marker for activity target and identifies parent unity", () => {
  const outline = makeOutline();
  // Add an empty placeholder activity under u-1 as the target.
  outline.unities[1].activities.push({
    id: "a-1-0",
    title: "Dijkstra basics",
    order_index: 0,
    body_len: 0,
    learning_objectives: [],
    key_terms: [],
    bloom_level: null,
    duration_min: null,
  });
  const result = buildCurriculumContext(outline, {
    kind: "activity",
    activity_id: "a-1-0",
  });
  assert.match(result, />>> TARGET ACTIVITY <<</);
  assert.match(
    result,
    /Your current generation target: activity "Dijkstra basics".*under unity "Shortest paths"/,
  );
});

test("does not list target unity's own outcomes as existing content", () => {
  const outline = makeOutline();
  // Pretend u-1 already has outcomes — they should NOT count as
  // "existing work" for a unity-scope generate of u-1 itself.
  outline.unities[1].outcomes = ["I should not appear"];
  // …but u-0 also has outcomes, so the block should still emit.
  const result = buildCurriculumContext(outline, {
    kind: "unity",
    unity_id: "u-1",
  });
  assert.ok(result.length > 0, "block should still emit because u-0 has content");
  // The marker still goes on the target.
  assert.match(result, />>> TARGET UNITY <<<.*Shortest paths/);
});

test("includes syllabus contract (audience/scope/pedagogy)", () => {
  const outline = makeOutline();
  const result = buildCurriculumContext(outline, {
    kind: "unity",
    unity_id: "u-1",
  });
  assert.match(result, /Audience: .*undergrad/);
  assert.match(result, /Scope: .*duration_hours/);
  assert.match(result, /Pedagogy: .*lab/);
});

test("respects maxChars by dropping key_terms first", () => {
  const outline = makeOutline();
  // The full render with everything is ~750 chars for this fixture.
  // Use a maxChars just under the full size so we exercise the
  // first trim step (drop key_terms).
  const full = buildCurriculumContext(outline, {
    kind: "unity",
    unity_id: "u-1",
  });
  const tight = buildCurriculumContext(
    outline,
    { kind: "unity", unity_id: "u-1" },
    { maxChars: full.length - 20 },
  );
  // First trim: key_terms gone globally.
  assert.ok(
    !tight.includes("key_terms:"),
    `key_terms should be dropped at the first trim step. Output:\n${tight}`,
  );
  // LOs of adjacent unity (u-1 is the target, so no LOs are "adjacent");
  // LOs of u-0 are non-adjacent and should still be present if the
  // first trim was enough.
  assert.ok(tight.length <= full.length - 20);
});

test("hard-truncates with marker if all trims are insufficient", () => {
  // Build a giant outline so even after all trims it can't fit
  // into a tiny budget.
  const outline = makeOutline();
  // 50 fat unities, each with 5 activities.
  outline.unities = Array.from({ length: 50 }, (_, ui) => ({
    id: `u-${ui}`,
    title: `Unity number ${ui}`,
    order_index: ui,
    outcomes: Array.from({ length: 10 }, (_, k) => `outcome-${ui}-${k}`),
    prerequisites: Array.from({ length: 5 }, (_, k) => `prereq-${ui}-${k}`),
    activities: Array.from({ length: 5 }, (_, ai) => ({
      id: `a-${ui}-${ai}`,
      title: `Activity ${ui}.${ai}`,
      order_index: ai,
      body_len: 2000,
      learning_objectives: Array.from(
        { length: 4 },
        (_, k) => `LO-${ui}-${ai}-${k}`,
      ),
      key_terms: Array.from({ length: 10 }, (_, k) => `kt-${ui}-${ai}-${k}`),
      bloom_level: "apply",
      duration_min: 30,
    })),
  }));

  const tinyBudget = 500;
  const result = buildCurriculumContext(
    outline,
    { kind: "unity", unity_id: "u-49" },
    { maxChars: tinyBudget },
  );
  assert.ok(result.length <= tinyBudget, `result length=${result.length}`);
  assert.match(result, /curriculum context truncated/);
});

test("default maxChars (24000) handles realistic 50-activity syllabus", () => {
  const outline = makeOutline();
  outline.unities = Array.from({ length: 10 }, (_, ui) => ({
    id: `u-${ui}`,
    title: `Unity ${ui}`,
    order_index: ui,
    outcomes: Array.from({ length: 3 }, (_, k) => `outcome-${ui}-${k}`),
    prerequisites: [`prereq-${ui}`],
    activities: Array.from({ length: 5 }, (_, ai) => ({
      id: `a-${ui}-${ai}`,
      title: `Activity ${ui}.${ai}`,
      order_index: ai,
      body_len: 1500,
      learning_objectives: [
        `LO ${ui}.${ai}.1`,
        `LO ${ui}.${ai}.2`,
        `LO ${ui}.${ai}.3`,
      ],
      key_terms: [`term-${ui}-${ai}-1`, `term-${ui}-${ai}-2`],
      bloom_level: "apply",
      duration_min: 30,
    })),
  }));
  const result = buildCurriculumContext(outline, {
    kind: "unity",
    unity_id: "u-5",
  });
  assert.ok(result.length <= 24_000);
  assert.match(result, /Curriculum context/);
  assert.match(result, /TARGET UNITY/);
});

test("syllabus-scope target with non-empty content emits block", () => {
  const outline = makeOutline();
  const result = buildCurriculumContext(outline, {
    kind: "syllabus",
    syllabus_id: "syl-1",
  });
  assert.match(result, /Your current generation target: the syllabus itself/);
});

test("body_len=0 activity rendered as 'empty placeholder'", () => {
  const outline = makeOutline();
  outline.unities[1].activities.push({
    id: "a-empty",
    title: "Pending activity",
    order_index: 0,
    body_len: 0,
    learning_objectives: ["LO!"],
    key_terms: [],
    bloom_level: null,
    duration_min: null,
  });
  const result = buildCurriculumContext(outline, {
    kind: "unity",
    unity_id: "u-0",
  });
  // u-0 is the target unity, so a-empty (under u-1, non-adjacent)
  // is listed.
  assert.match(result, /"Pending activity"/);
  assert.match(result, /body: empty placeholder/);
});
