/**
 * Pure formatter for the **curriculum context** block that
 * `ScopedGenerateService` injects into the synthesised supervisor
 * prompt at the start of every `/generate` pass.
 *
 * The goal of this block is to give the deep-agent (supervisor +
 * subagents) a *deterministic*, pre-loaded view of "what already
 * exists in this syllabus" so it stays consistent with the existing
 * démarche pédagogique and does not duplicate sibling content. This
 * is **server-pushed context** — the agent does NOT need to call
 * `list_unities` / `find_related_*` to see siblings; the relevant
 * subset is already in its system prompt.
 *
 * Design constraints
 * ------------------
 *
 *   1. **No side effects.** This module never queries the DB; it
 *      only formats a pre-fetched outline. That makes it cheap to
 *      unit-test and trivial to reason about.
 *
 *   2. **Token budget.** The synthesised prompt + the supervisor
 *      system prompt + the user message must stay well under the
 *      LLM's context window. NVIDIA `mistralai/mistral-small-4-119b-2603`
 *      (the default supervisor model since the kimi-k2.6 → mistral
 *      swap) has a 128k window; we cap the curriculum context at
 *      ~6k tokens (~24000 chars at the standard 4-chars/token
 *      approximation) to leave headroom for the supervisor prompt,
 *      the writer's task description, retrieval results mid-pass,
 *      and the assistant turn itself.
 *
 *   3. **Trim policy.** When over budget, drop verbose fields in
 *      this order, oldest-first, before dropping entire entries:
 *
 *        - activity `key_terms` (least important, often noisy)
 *        - activity `learning_objectives` of activities NOT in
 *          the target's parent unity
 *        - unity `outcomes` / `prerequisites` for unities NOT
 *          adjacent to the target
 *        - entire activity entries (oldest first) outside the
 *          target's parent unity
 *        - entire unity entries (oldest first)
 *
 *      The target row's *adjacent siblings* (same parent) are
 *      never dropped — they are the most important for
 *      consistency.
 *
 *   4. **Skip-when-empty.** If the syllabus has zero non-empty
 *      siblings (every activity has `body_len === 0` AND every
 *      unity has no `outcomes`), the block returns an empty
 *      string and `ScopedGenerateService` skips the injection
 *      entirely. We don't manufacture context from empty
 *      placeholder rows.
 *
 *   5. **Target marker.** The row currently being filled is
 *      explicitly marked with `>>> THIS IS THE ROW YOU'RE
 *      FILLING <<<` so the agent doesn't mistake it for existing
 *      content to be consistent with.
 *
 * Shape of the `SyllabusOutline` input is defined alongside this
 * file in `entities.service.ts` (`getSyllabusOutline`).
 */

export interface OutlineActivity {
  id: string;
  title: string;
  order_index: number;
  body_len: number;
  learning_objectives: unknown;
  key_terms: unknown;
  bloom_level: unknown;
  duration_min: unknown;
}

export interface OutlineUnity {
  id: string;
  title: string;
  order_index: number;
  outcomes: unknown;
  prerequisites: unknown;
  activities: OutlineActivity[];
}

export interface SyllabusOutline {
  syllabus: {
    id: string;
    title: string;
    description: string;
    audience: unknown;
    scope: unknown;
    pedagogy: unknown;
  };
  unities: OutlineUnity[];
}

export type GenerationTarget =
  | { kind: "syllabus"; syllabus_id: string }
  | { kind: "unity"; unity_id: string }
  | { kind: "activity"; activity_id: string };

export interface BuildCurriculumContextOptions {
  /**
   * Approximate maximum character budget for the entire formatted
   * block. We use a char-based estimate rather than a real tokenizer
   * because (a) the LLM runs remotely so we'd have no tokenizer at
   * hand without a heavy dep, and (b) char/4 over-counts conservatively
   * for the Latin-script content this system handles. Default is
   * 24_000 (~6k tokens), matching the decision logged in
   * `/handoff/PEDAGOGICAL_CONTEXT_ANALYSIS.md` §6.
   */
  maxChars?: number;
}

const DEFAULT_MAX_CHARS = 24_000;

/**
 * Format the curriculum context block.
 *
 * Returns the empty string when there is nothing meaningful to
 * inject (empty syllabus, or every sibling row is a body_len=0
 * placeholder). Callers should treat empty-string as "skip the
 * block entirely" and not emit any header.
 */
export function buildCurriculumContext(
  outline: SyllabusOutline,
  target: GenerationTarget,
  options: BuildCurriculumContextOptions = {},
): string {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;

  if (!hasAnyNonEmptySibling(outline, target)) {
    return "";
  }

  // Step 1: render full-fidelity. Then iteratively trim if over
  // budget. Trim policy intentionally favours keeping target-
  // adjacent rows full and dropping verbose fields on faraway
  // rows first.
  const renderState: RenderState = {
    drop_key_terms_global: false,
    drop_los_non_adjacent: false,
    drop_outcomes_non_adjacent: false,
    dropped_activity_ids: new Set<string>(),
    dropped_unity_ids: new Set<string>(),
  };

  // Sort copies are taken inside `render` so trim mutations to
  // `renderState` don't reorder the source.
  let rendered = render(outline, target, renderState);
  if (rendered.length <= maxChars) return rendered;

  // 1. Drop key_terms everywhere.
  renderState.drop_key_terms_global = true;
  rendered = render(outline, target, renderState);
  if (rendered.length <= maxChars) return rendered;

  // 2. Drop learning_objectives on activities outside target's
  //    parent unity.
  renderState.drop_los_non_adjacent = true;
  rendered = render(outline, target, renderState);
  if (rendered.length <= maxChars) return rendered;

  // 3. Drop outcomes/prerequisites on unities not adjacent to
  //    the target. ("Adjacent" = same unity for a unity target,
  //    parent unity for an activity target, all unities for a
  //    syllabus target.)
  renderState.drop_outcomes_non_adjacent = true;
  rendered = render(outline, target, renderState);
  if (rendered.length <= maxChars) return rendered;

  // 4. Drop oldest activities outside the target's parent unity.
  for (const unity of orderedUnities(outline)) {
    if (isAdjacentUnity(unity, target, outline)) continue;
    for (const activity of orderedActivities(unity)) {
      if (renderState.dropped_activity_ids.has(activity.id)) continue;
      renderState.dropped_activity_ids.add(activity.id);
      rendered = render(outline, target, renderState);
      if (rendered.length <= maxChars) return rendered;
    }
  }

  // 5. Drop oldest unities outright.
  for (const unity of orderedUnities(outline)) {
    if (isAdjacentUnity(unity, target, outline)) continue;
    if (renderState.dropped_unity_ids.has(unity.id)) continue;
    renderState.dropped_unity_ids.add(unity.id);
    rendered = render(outline, target, renderState);
    if (rendered.length <= maxChars) return rendered;
  }

  // 6. Hard cap: even after all trimming, if still over budget,
  //    truncate with a visible marker so the agent knows context
  //    was clipped.
  if (rendered.length > maxChars) {
    const marker =
      "\n\n[...curriculum context truncated to fit token budget...]";
    rendered = rendered.slice(0, maxChars - marker.length) + marker;
  }
  return rendered;
}

// ─── render helpers ───────────────────────────────────────────────────────

interface RenderState {
  drop_key_terms_global: boolean;
  drop_los_non_adjacent: boolean;
  drop_outcomes_non_adjacent: boolean;
  dropped_activity_ids: Set<string>;
  dropped_unity_ids: Set<string>;
}

function render(
  outline: SyllabusOutline,
  target: GenerationTarget,
  state: RenderState,
): string {
  const lines: string[] = [];
  lines.push("## Curriculum context (existing work in this syllabus)");
  lines.push("");
  lines.push(`Syllabus: "${outline.syllabus.title}"`);
  if (outline.syllabus.description?.trim()) {
    lines.push(`Description: ${outline.syllabus.description.trim()}`);
  }
  if (isNonEmpty(outline.syllabus.audience)) {
    lines.push(`Audience: ${stringify(outline.syllabus.audience)}`);
  }
  if (isNonEmpty(outline.syllabus.scope)) {
    lines.push(`Scope: ${stringify(outline.syllabus.scope)}`);
  }
  if (isNonEmpty(outline.syllabus.pedagogy)) {
    lines.push(`Pedagogy: ${stringify(outline.syllabus.pedagogy)}`);
  }
  lines.push("");

  // Target callout: tell the agent which row it is filling so it
  // does not treat its own placeholder as "existing work".
  const targetLabel = describeTarget(target, outline);
  lines.push(`Your current generation target: ${targetLabel}`);
  lines.push("");

  lines.push("Existing unities (ordered by order_index):");
  lines.push("");

  const unities = orderedUnities(outline).filter(
    (u) => !state.dropped_unity_ids.has(u.id),
  );

  if (unities.length === 0) {
    lines.push("(no other unities yet)");
  }

  for (const unity of unities) {
    const isAdj = isAdjacentUnity(unity, target, outline);
    const isTargetUnity = target.kind === "unity" && target.unity_id === unity.id;
    const unityHeader =
      `${unity.order_index + 1}. ` +
      (isTargetUnity ? ">>> TARGET UNITY <<< " : "") +
      `"${unity.title}" [id=${unity.id}]`;
    lines.push(unityHeader);

    const includeUnityFields =
      isAdj || !state.drop_outcomes_non_adjacent;
    if (includeUnityFields && isNonEmpty(unity.outcomes)) {
      lines.push(`   outcomes: ${stringify(unity.outcomes)}`);
    }
    if (includeUnityFields && isNonEmpty(unity.prerequisites)) {
      lines.push(`   prerequisites: ${stringify(unity.prerequisites)}`);
    }

    const activities = orderedActivities(unity).filter(
      (a) => !state.dropped_activity_ids.has(a.id),
    );
    if (activities.length > 0) {
      lines.push(`   activities (${activities.length}):`);
      for (const activity of activities) {
        const isTargetActivity =
          target.kind === "activity" && target.activity_id === activity.id;
        const head =
          `   - ${activity.order_index + 1}. ` +
          (isTargetActivity ? ">>> TARGET ACTIVITY <<< " : "") +
          `"${activity.title}" [id=${activity.id}]`;
        lines.push(head);

        const losIncluded =
          isAdj || !state.drop_los_non_adjacent;
        if (losIncluded && isNonEmpty(activity.learning_objectives)) {
          lines.push(`     LOs: ${stringify(activity.learning_objectives)}`);
        }
        if (!state.drop_key_terms_global && isNonEmpty(activity.key_terms)) {
          lines.push(`     key_terms: ${stringify(activity.key_terms)}`);
        }

        const meta: string[] = [];
        if (isNonEmpty(activity.bloom_level)) {
          meta.push(`bloom: ${stringify(activity.bloom_level)}`);
        }
        if (isNonEmpty(activity.duration_min)) {
          meta.push(`duration: ${stringify(activity.duration_min)} min`);
        }
        if (typeof activity.body_len === "number") {
          meta.push(
            activity.body_len > 0
              ? `body_len: ${activity.body_len}`
              : "body: empty placeholder",
          );
        }
        if (meta.length > 0) {
          lines.push(`     ${meta.join(" · ")}`);
        }
      }
    }
    lines.push("");
  }

  lines.push("---");
  lines.push(
    "DO NOT duplicate any content listed above. Match the existing " +
      "*démarche pédagogique* (tone, vocabulary, Bloom progression, " +
      "section structure) of the existing unities and activities. The " +
      "row marked TARGET above is the only row you are allowed to " +
      "modify on this pass.",
  );

  return lines.join("\n");
}

function describeTarget(
  target: GenerationTarget,
  outline: SyllabusOutline,
): string {
  if (target.kind === "syllabus") {
    return `the syllabus itself (id=${target.syllabus_id})`;
  }
  if (target.kind === "unity") {
    const unity = outline.unities.find((u) => u.id === target.unity_id);
    if (unity) {
      return `unity "${unity.title}" (id=${unity.id})`;
    }
    return `unity id=${target.unity_id}`;
  }
  // activity
  for (const u of outline.unities) {
    const a = u.activities.find((x) => x.id === target.activity_id);
    if (a) {
      return `activity "${a.title}" (id=${a.id}) under unity "${u.title}" (id=${u.id})`;
    }
  }
  return `activity id=${target.activity_id}`;
}

function hasAnyNonEmptySibling(
  outline: SyllabusOutline,
  target: GenerationTarget,
): boolean {
  for (const unity of outline.unities) {
    // The target unity itself doesn't count as existing context —
    // we are about to fill it.
    if (target.kind === "unity" && target.unity_id === unity.id) {
      // …but its existing siblings (activities) might already
      // have content, e.g. when this is a re-generation. Fall
      // through to check activities.
    }
    if (isNonEmpty(unity.outcomes) || isNonEmpty(unity.prerequisites)) {
      // For a unity target, the target's own metadata doesn't count.
      if (!(target.kind === "unity" && target.unity_id === unity.id)) {
        return true;
      }
    }
    for (const activity of unity.activities) {
      if (
        target.kind === "activity" &&
        target.activity_id === activity.id
      ) {
        continue;
      }
      if (activity.body_len && activity.body_len > 0) return true;
      if (isNonEmpty(activity.learning_objectives)) return true;
    }
  }
  return false;
}

function isAdjacentUnity(
  unity: OutlineUnity,
  target: GenerationTarget,
  outline: SyllabusOutline,
): boolean {
  if (target.kind === "syllabus") return true;
  if (target.kind === "unity") return unity.id === target.unity_id;
  // activity
  const parent = outline.unities.find((u) =>
    u.activities.some((a) => a.id === target.activity_id),
  );
  return parent ? parent.id === unity.id : false;
}

function orderedUnities(outline: SyllabusOutline): OutlineUnity[] {
  return [...outline.unities].sort(
    (a, b) => a.order_index - b.order_index,
  );
}

function orderedActivities(unity: OutlineUnity): OutlineActivity[] {
  return [...unity.activities].sort(
    (a, b) => a.order_index - b.order_index,
  );
}

function isNonEmpty(value: unknown): boolean {
  if (value == null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") {
    return Object.keys(value as Record<string, unknown>).length > 0;
  }
  if (typeof value === "number") return true;
  if (typeof value === "boolean") return true;
  return false;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
