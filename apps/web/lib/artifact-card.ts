// Parses Deep Agent inline artifact tags out of streamed assistant
// text and returns a sequence of segments the chat-pane can render.
//
// The supervisor embeds clickable "deliverable" cards mid-prose with a
// self-closing XML-ish tag:
//
//     I've finished the syllabus.
//     <artifact kind="syllabus" id="abc-123" title="Database systems" />
//
// `parseArtifactSegments` returns a flat array of either text or
// artifact segments so the renderer can splice in a `DeepArtifactCard`
// component in place of each tag while still streaming the
// surrounding markdown through the existing `Markdown` component.
//
// Edge cases handled:
//   1. **Mid-stream partial tags**: during token-by-token streaming a
//      tag may arrive in pieces. The regex requires the closing `/>`
//      to commit; while the tag is half-typed, everything from `<`
//      onward is treated as plain text and re-parsed once the close
//      arrives. The user sees a brief flash of `<artifact kind="…`
//      becoming a card — acceptable trade-off for not having to teach
//      the parser a streaming state machine.
//
//   2. **Malformed attributes / unknown kinds**: any tag whose
//      attributes don't `safeParse` against the shared `ArtifactCard`
//      schema (e.g. typo'd kind, missing id) is rendered as plain
//      text rather than silently dropped, so the supervisor's mistake
//      is visible to the user instead of swallowed.
//
//   3. **Multiple tags in one bubble / tags adjacent to markdown**:
//      the regex is global, so any number of tags interleaved with
//      prose split correctly. Adjacent text segments are NOT merged —
//      the renderer happily handles consecutive text segments.
//
//   4. **Quoting**: only double-quoted attribute values are accepted
//      (`kind="syllabus"`). Single quotes / unquoted values are
//      treated as malformed and fall through to text. This mirrors
//      strict XML and keeps the parser short.

import { ArtifactCard } from "@mpfe/shared";

export type ArtifactSegment =
  | { type: "text"; text: string }
  | { type: "artifact"; card: ArtifactCard };

// Self-closing-only on purpose. The supervisor never wraps content
// inside an artifact tag, so `<artifact …></artifact>` would be a
// model hallucination and is left as text rather than parsed.
//
// The non-greedy `[^>]*?` body keeps the parser linear in input size
// and prevents a single unterminated `<artifact` from eating the rest
// of the bubble.
const ARTIFACT_TAG_RE = /<artifact\s+([^>]*?)\s*\/>/g;

// Matches `name="value"` pairs inside the tag body. Attribute names
// are restricted to ASCII letters / digits / underscores so noise
// like `<artifact !!="x" />` doesn't accidentally produce a key.
const ATTR_RE = /([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"([^"]*)"/g;

function parseAttributes(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of raw.matchAll(ATTR_RE)) {
    out[m[1]] = m[2];
  }
  return out;
}

export function parseArtifactSegments(source: string): ArtifactSegment[] {
  const segments: ArtifactSegment[] = [];
  let lastIndex = 0;
  for (const match of source.matchAll(ARTIFACT_TAG_RE)) {
    const matchIndex = match.index ?? 0;
    if (matchIndex > lastIndex) {
      segments.push({
        type: "text",
        text: source.slice(lastIndex, matchIndex),
      });
    }
    const attrs = parseAttributes(match[1]);
    const parsed = ArtifactCard.safeParse(attrs);
    if (parsed.success) {
      segments.push({ type: "artifact", card: parsed.data });
    } else {
      // Malformed → render the raw tag text so the user sees what the
      // supervisor wrote rather than a silent dropout.
      segments.push({ type: "text", text: match[0] });
    }
    lastIndex = matchIndex + match[0].length;
  }
  if (lastIndex < source.length) {
    segments.push({ type: "text", text: source.slice(lastIndex) });
  }
  // Empty source → return one empty text segment so callers can rely
  // on `.length >= 1` without a special-case.
  if (segments.length === 0) {
    segments.push({ type: "text", text: source });
  }
  return segments;
}

/**
 * Strip every artifact tag from a string, leaving only the prose.
 * Used by callers that need a plain-text fallback (e.g. `aria-label`,
 * preview snippets, the threads-list `last_user_message` summary
 * which shouldn't include cards).
 */
export function stripArtifactTags(source: string): string {
  return source.replace(ARTIFACT_TAG_RE, "").replace(/\s+\n/g, "\n");
}
