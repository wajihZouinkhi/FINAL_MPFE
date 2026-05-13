/**
 * Search/replace block parser + applier for the writer's revision mode.
 *
 * On a revision attempt the writer is asked to emit a sequence of
 * Aider-style search/replace blocks against the previous draft, instead
 * of regenerating the full lesson markdown:
 *
 *   <<<<<<< SEARCH
 *   <exact text from previous draft>
 *   =======
 *   <replacement text>
 *   >>>>>>> REPLACE
 *
 * Why blocks and not unified diffs: gemma / gpt-class models reliably
 * mangle line numbers, hunk headers, and `@@` markers in unified diffs,
 * so applying them produces silent corruption. Search/replace blocks are
 * self-contained — apply succeeds only when the SEARCH text is uniquely
 * located in the draft, so a malformed block fails loudly and cleanly
 * and we fall back to a full rewrite for that attempt.
 *
 * Matching is whitespace-tolerant: we try byte-exact first, then a
 * normalized-whitespace match (collapses runs of whitespace to a single
 * space and trims line edges) so a block whose indentation differs
 * trivially still applies. A block that matches in 0 places, or in >1
 * places, returns a failure — never a guess.
 *
 * This module has zero dependencies on the rest of the codebase so it
 * stays trivially testable.
 */

export interface SearchReplaceBlock {
  search: string;
  replace: string;
}

const FENCE_RE =
  /<{7}\s*SEARCH\s*\n([\s\S]*?)\n={7}\s*\n([\s\S]*?)\n>{7}\s*REPLACE/g;

/**
 * Extract every SEARCH/REPLACE block from the writer's raw output. The
 * writer is instructed to emit nothing else, but we tolerate prose
 * around the blocks (some models like to add a "Here are the changes:"
 * header) by ignoring everything outside the fence pairs.
 */
export function parseSearchReplaceBlocks(raw: string): SearchReplaceBlock[] {
  const blocks: SearchReplaceBlock[] = [];
  // Reset lastIndex defensively — FENCE_RE is module-level and stateful.
  FENCE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FENCE_RE.exec(raw)) !== null) {
    blocks.push({ search: m[1], replace: m[2] });
  }
  return blocks;
}

function normalize(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

type LocateResult =
  | { kind: "found"; start: number; end: number }
  | { kind: "no_match" }
  | { kind: "ambiguous_match" };

/**
 * Locate `needle` inside `haystack`. Tries byte-exact first (with
 * overlapping-occurrence detection), then a whitespace-normalized
 * match. Returns a tagged result so the caller can distinguish
 * "not found at all" from "found multiple times".
 *
 * Multiple matches are treated as failure rather than picking the first
 * — patching the wrong occurrence silently is worse than falling back
 * to a full rewrite. The writer can disambiguate by including more
 * surrounding context in the SEARCH block.
 */
function locate(haystack: string, needle: string): LocateResult {
  if (!needle) return { kind: "no_match" };
  const first = haystack.indexOf(needle);
  if (first !== -1) {
    // Detect a *second* match by stepping forward by one char so we catch
    // overlapping occurrences (e.g. needle "aa" in haystack "aaa"). The
    // earlier `first + needle.length` step missed those, which made the
    // caller misclassify the failure as "no_match" instead of "ambiguous".
    const second = haystack.indexOf(needle, first + 1);
    if (second !== -1) return { kind: "ambiguous_match" };
    return { kind: "found", start: first, end: first + needle.length };
  }
  // Whitespace-tolerant match. Walk the haystack character-by-character
  // and compare the normalized forms of equal-length-ish slices. This
  // is O(n*m) worst case but the inputs are <30k chars so it's fine.
  const normNeedle = normalize(needle);
  if (!normNeedle) return { kind: "no_match" };
  let foundStart = -1;
  let foundEnd = -1;
  let multipleMatches = false;
  // Slide a window over haystack. Only start at non-whitespace positions
  // so the matched range doesn't accidentally swallow leading newlines /
  // indentation belonging to the previous line — that destabilizes
  // formatting around the patched region.
  for (let i = 0; i < haystack.length; i++) {
    if (/\s/.test(haystack[i])) continue;
    if (i > 0 && !/\s/.test(haystack[i - 1])) continue;
    // Try expanding the window until its normalized form is at least
    // as long as the normalized needle.
    let j = i;
    let normSlice = "";
    while (j < haystack.length && normalize(haystack.slice(i, j + 1)).length < normNeedle.length) {
      j += 1;
    }
    if (j >= haystack.length) break;
    normSlice = normalize(haystack.slice(i, j + 1));
    if (normSlice === normNeedle) {
      if (foundStart !== -1) {
        multipleMatches = true;
        break;
      }
      foundStart = i;
      foundEnd = j + 1;
      // Skip past this match so we don't double-count overlapping starts.
      i = j;
    }
  }
  if (multipleMatches) return { kind: "ambiguous_match" };
  if (foundStart === -1) return { kind: "no_match" };
  return { kind: "found", start: foundStart, end: foundEnd };
}

export interface ApplyResult {
  ok: boolean;
  text: string;
  applied: number;
  /** Index of the first block that failed to apply, if any. */
  failedAt?: number;
  reason?: "no_match" | "ambiguous_match" | "no_blocks";
}

/**
 * Apply blocks in order to `draft`. Each block must locate its SEARCH
 * uniquely in the *current* draft state (so later blocks see edits made
 * by earlier ones). Returns `ok: false` on the first failure with
 * `failedAt` and `reason` so the caller can log + fall back.
 *
 * Empty `blocks` returns `ok: false` with `reason: "no_blocks"` — the
 * caller treats that as "writer didn't actually emit any patch" and
 * falls back to a full rewrite.
 */
export function applySearchReplaceBlocks(
  draft: string,
  blocks: SearchReplaceBlock[],
): ApplyResult {
  if (blocks.length === 0) {
    return { ok: false, text: draft, applied: 0, reason: "no_blocks" };
  }
  let text = draft;
  for (let i = 0; i < blocks.length; i++) {
    const { search, replace } = blocks[i];
    // Empty SEARCH means "append at end" — handy for adding a missing
    // section. Restricted to non-empty REPLACE so a malformed block
    // can't silently nuke trailing content.
    if (!search.trim()) {
      if (!replace.trim()) {
        return {
          ok: false,
          text,
          applied: i,
          failedAt: i,
          reason: "no_match",
        };
      }
      text = text.endsWith("\n") ? text + replace : text + "\n" + replace;
      continue;
    }
    const range = locate(text, search);
    if (range.kind !== "found") {
      // `locate` already tells us *which* failure mode — "no_match" vs
      // "ambiguous_match" — so we don't need a second pass with a
      // separate occurrence counter (whose semantics could drift from
      // `locate`'s overlapping/fuzzy detection and produce wrong reasons).
      return { ok: false, text, applied: i, failedAt: i, reason: range.kind };
    }
    text = text.slice(0, range.start) + replace + text.slice(range.end);
  }
  return { ok: true, text, applied: blocks.length };
}
