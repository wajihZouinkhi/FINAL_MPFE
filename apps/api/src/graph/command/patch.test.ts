/**
 * Standalone tests for the search/replace block parser + applier.
 *
 * Run via the Node built-in runner (no Jest/Vitest dep added):
 *
 *   pnpm --filter @mpfe/api exec tsx --test src/graph/command/patch.test.ts
 *
 * Pure functions, no Nest / DB / network — fast.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applySearchReplaceBlocks,
  parseSearchReplaceBlocks,
} from "./patch";

test("parses a single block", () => {
  const raw = [
    "<<<<<<< SEARCH",
    "old line",
    "=======",
    "new line",
    ">>>>>>> REPLACE",
  ].join("\n");
  const blocks = parseSearchReplaceBlocks(raw);
  assert.deepEqual(blocks, [{ search: "old line", replace: "new line" }]);
});

test("parses multiple blocks and ignores prose between them", () => {
  const raw = [
    "Here are the changes:",
    "<<<<<<< SEARCH",
    "foo",
    "=======",
    "bar",
    ">>>>>>> REPLACE",
    "Also:",
    "<<<<<<< SEARCH",
    "baz",
    "=======",
    "qux",
    ">>>>>>> REPLACE",
  ].join("\n");
  const blocks = parseSearchReplaceBlocks(raw);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].search, "foo");
  assert.equal(blocks[1].replace, "qux");
});

test("returns no_blocks when nothing parses", () => {
  const result = applySearchReplaceBlocks("hello world", []);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "no_blocks");
  assert.equal(result.text, "hello world");
});

test("applies a block in order", () => {
  const draft = "# Title\n\nBody one.\n\nBody two.";
  const result = applySearchReplaceBlocks(draft, [
    { search: "Body one.", replace: "Body uno." },
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.applied, 1);
  assert.equal(result.text, "# Title\n\nBody uno.\n\nBody two.");
});

test("applies multiple blocks sequentially over the running draft", () => {
  const draft = "alpha\nbeta\ngamma";
  const result = applySearchReplaceBlocks(draft, [
    { search: "alpha", replace: "ALPHA" },
    { search: "gamma", replace: "GAMMA" },
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.text, "ALPHA\nbeta\nGAMMA");
});

test("ambiguous match (>=2 occurrences) fails cleanly", () => {
  const draft = "x\nx\nx";
  const result = applySearchReplaceBlocks(draft, [
    { search: "x", replace: "y" },
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "ambiguous_match");
  assert.equal(result.failedAt, 0);
  // Draft is unchanged on failure.
  assert.equal(result.text, "x\nx\nx");
});

test("ambiguous match via *overlapping* occurrences is reported as ambiguous, not no_match", () => {
  // Regression: previously `locate` advanced by `first + needle.length`
  // which missed overlapping occurrences, AND the fallback occurrence
  // counter used non-overlapping search. Net effect: an overlapping
  // ambiguous match (e.g. "aa" in "aaa") was misreported as "no_match".
  const draft = "aaa";
  const result = applySearchReplaceBlocks(draft, [
    { search: "aa", replace: "X" },
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "ambiguous_match");
  assert.equal(result.failedAt, 0);
  assert.equal(result.text, "aaa");
});

test("ambiguous match via *fuzzy* occurrences is reported as ambiguous, not no_match", () => {
  // Regression: when the byte-exact path returned 0 hits but the
  // whitespace-normalized path found multiple matches, the failure
  // reason was misreported as "no_match" because the fallback counter
  // only knew about byte-exact occurrences.
  const draft = "alpha   beta\n--\nalpha\tbeta";
  const result = applySearchReplaceBlocks(draft, [
    { search: "alpha beta", replace: "Z" },
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "ambiguous_match");
  assert.equal(result.failedAt, 0);
});

test("no match anywhere fails with no_match", () => {
  const draft = "foo bar";
  const result = applySearchReplaceBlocks(draft, [
    { search: "zzz", replace: "yyy" },
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "no_match");
});

test("whitespace-tolerant match: extra indentation in haystack still hits", () => {
  const draft = "intro\n    foo bar baz\noutro";
  const result = applySearchReplaceBlocks(draft, [
    { search: "foo bar baz", replace: "FOO" },
  ]);
  assert.equal(result.ok, true);
  // Byte-exact path wins; leading indentation is preserved untouched.
  assert.equal(result.text, "intro\n    FOO\noutro");
});

test("whitespace-tolerant match: extra spaces in needle still hits", () => {
  const draft = "intro\nfoo bar baz\noutro";
  const result = applySearchReplaceBlocks(draft, [
    { search: "foo  bar   baz", replace: "FOO" },
  ]);
  assert.equal(result.ok, true);
  // Match starts at the 'f' of foo, leaving the preceding newline intact.
  assert.equal(result.text, "intro\nFOO\noutro");
});

test("empty SEARCH appends to end (add-section pattern)", () => {
  const draft = "# Title\n\nBody.";
  const result = applySearchReplaceBlocks(draft, [
    { search: "", replace: "## New section\n\nMore content." },
  ]);
  assert.equal(result.ok, true);
  assert.equal(
    result.text,
    "# Title\n\nBody.\n## New section\n\nMore content.",
  );
});

test("empty SEARCH with empty REPLACE is rejected (no silent nuke)", () => {
  const draft = "keep me";
  const result = applySearchReplaceBlocks(draft, [
    { search: "", replace: "" },
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "no_match");
  assert.equal(result.text, "keep me");
});

test("end-to-end: parse + apply a realistic revision", () => {
  const draft = [
    "# Photosynthesis",
    "",
    "## Learning objectives",
    "",
    "- Understand photosynthesis [understand]",
    "",
    "## Summary",
    "",
    "Plants make food.",
  ].join("\n");
  const writerOutput = [
    "<<<<<<< SEARCH",
    "- Understand photosynthesis [understand]",
    "=======",
    "- Explain how chlorophyll converts light into chemical energy [explain]",
    ">>>>>>> REPLACE",
    "",
    "<<<<<<< SEARCH",
    "Plants make food.",
    "=======",
    "Plants synthesize glucose from CO2 and water using light energy.",
    ">>>>>>> REPLACE",
  ].join("\n");
  const blocks = parseSearchReplaceBlocks(writerOutput);
  const result = applySearchReplaceBlocks(draft, blocks);
  assert.equal(result.ok, true);
  assert.equal(result.applied, 2);
  assert.match(result.text, /chlorophyll/);
  assert.match(result.text, /glucose/);
  assert.doesNotMatch(result.text, /Plants make food/);
});
