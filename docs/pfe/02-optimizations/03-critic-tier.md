# Optimisation 3 — Dedicated `critic` LLM tier

> Audit cross-reference: §2.4 (P1) and §6.1 (P1).
> PR: `devin/<ts>-critic-tier` → `main`.

## Problem statement

The writer/critic loop in the command subgraph runs the critic on the
`supervisor` LLM tier — the most expensive model in the deployment.
Concretely, in the audited prod config:

```
Tier supervisor: nvidia/nemotron-3-super-120b-a12b   (~13 ¢ / Mtok)
Tier writer:     google/gemma-4-31b-it               (~0.3 ¢ / Mtok)
Tier utility:    google/gemma-4-31b-it               (~0.3 ¢ / Mtok)
```

Every revision pass sends the full lesson body (~2–4 KB), the research
summary (≤6 KB), the pedagogical contract, and the 14-point JSON
schema to the critic. Each lesson gets up to `MAX_REVISIONS = 2`
critic calls, plus the initial pass — so a 6-lesson syllabus is up to
**18 critic invocations** at the highest tier price. Per-revision cost
is 3–5× higher than necessary.

The critic is structurally a classification task. It reads a draft +
research brief and returns
`{ pass: bool, issues: [{path, severity, message}, …] }` against a
fixed checklist. The supervisor tier's reasoning headroom does not
help on a JSON-output task with a strict schema — it just adds
latency and cost.

## Root-cause analysis

The critic's tier is a single string passed to `LlmConfigService.get`
inside `command.subgraph.ts:generate()`:

```ts
const critic = this.llm.get("supervisor", { temperature: 0 });
```

The previous `LlmConfigService` exposed only three tiers
(`supervisor` / `writer` / `utility`), and the critic was put on
`supervisor` as a defensive default when the v2 critic prompt landed.
There was no tier whose budget shape matched the critic's workload
(medium-cost, high-volume, JSON-only, deterministic), so picking
`supervisor` was the conservative choice.

## Design alternatives considered

1. **Move the critic to the existing `utility` tier.** Reject as the
   *sole* fix. It is the cheapest path to the §2.4 win, but it
   over-loads the utility provider with both the picker (a single-shot
   structured pick) and the critic (long-form draft + brief +
   contract). Operators that want to pin the picker to a
   sub-100M-token-cost model can no longer do that without dropping
   critic quality. Also, the audit's P1 §6.1 explicitly recommends a
   *dedicated* tier for the critic + follow-up classifier so the
   spend lever is the same as the call mix.
2. **Add a 4th `critic` tier and keep `utility` as the fallback when
   the new env vars are not set.** ← chosen. This gives operators
   both knobs at once: zero-config deployments transparently get the
   §2.4 win (critic on utility), and operators who set
   `CRITIC_LLM_*` get the §6.1 win (dedicated medium-tier model)
   without any further code change.
3. **Inline a per-call cost-router that picks utility / critic based
   on draft length.** Reject: another moving part on the hot path,
   and the critic's cost shape is monotonic in draft length anyway —
   the operator can pick the right model once and forget it.

## Chosen design

```
LlmTier = "supervisor" | "writer" | "critic" | "utility"

CRITIC_LLM_API_KEY?   ┐
CRITIC_LLM_BASE_URL?  ├─ all three set ─→  critic = own provider
CRITIC_LLM_MODEL?     ┘
                      │
                      └─ any missing  ─→  critic = utility (§2.4 fallback)
```

The `LlmConfigService` schema makes `CRITIC_LLM_*` optional. At boot
the service decides whether to use the configured critic provider or
alias the critic tier to the existing utility tier, and logs which
path it took:

```
[LlmConfigService] Tier supervisor: nvidia/…
[LlmConfigService] Tier writer:     google/…
[LlmConfigService] Tier critic:     google/… (fallback → utility — set CRITIC_LLM_* to override)
[LlmConfigService] Tier utility:    google/…
```

The critic call site in `command.subgraph.ts` switches from
`llm.get("supervisor", …)` to `llm.get("critic", …)`. No other
behavioural change: the prompt, the JSON schema, the deadlock
fingerprint, and the force-pass logic are unchanged.

## Code

- `apps/api/src/config/llm-config.service.ts` — `LlmTier` adds
  `"critic"`; Zod schema accepts optional `CRITIC_LLM_*`; the
  constructor aliases `critic → utility` when env is partial.
- `apps/api/src/graph/command/command.subgraph.ts:421` — critic call
  switches from `supervisor` tier to `critic` tier.
- `.env.example` — documents the new optional tier and the fallback.

## Measurement methodology

The headline metric is **per-revision LLM spend on the critic**.
Two scenarios:

```
A. CRITIC_LLM_* unset (default) — critic aliased to utility
B. CRITIC_LLM_* set to a medium-tier model
```

For each, run the same 6-lesson syllabus build (same seed, same intake
form) and record:

- `critic_tokens_in[]`, `critic_tokens_out[]` per lesson
- `critic_wall_clock[]` per lesson
- `critic_pass_rate` — fraction of attempts where `pass: true`
- `block_issue_recurrence_rate` — fraction where the block fingerprint
  repeated between attempts (force-pass trigger)
- end-to-end build wall-clock time

The pre-fix baseline is the same script with the critic call still
pinned to `"supervisor"`.

```
Build:        Introduction to graph algorithms (5 chapters, 6 lessons)
Repetitions:  10 runs per scenario
```

### Cost projection

Per the audit's observed token counts (~6 K input / ~600 output per
critic call) and 18 critic invocations per build:

| Tier        | $ / 1K input | $ / 1K output | $ / build (critic only) |
|-------------|-------------:|--------------:|------------------------:|
| supervisor  |        0.013 |          0.05 |                  ≈ $1.95 |
| critic→utility (default after PR) | 0.0003 | 0.001 | ≈ $0.04 |
| critic→medium (e.g. mistral-medium-3) | 0.002 | 0.006 | ≈ $0.28 |

Even the medium-tier scenario is ~7× cheaper than supervisor; the
default fallback path is ~50× cheaper. Quality risk is the entire
reason this is gated on the eval below.

### Quality eval

The critic is the failure mode that matters: a too-cheap model can
miss block-severity issues, force-passing a bad draft. The eval is
therefore *not* "does the new tier produce the same `pass` rate" —
that would just measure the writer's quality. It is:

- **Recall on synthetic block issues.** Inject 20 lesson drafts that
  each violate exactly one of the 14 critic checklist items
  (LO-not-exercised, hallucinated claim, English fragment in a
  French lesson, missing worked example, etc.). Score the critic on
  how many of the 20 it correctly flags as `block` severity.
- **False-positive rate on clean drafts.** Run the critic on 20
  clean drafts (audited by the previous-tier critic + a human pass).
  Score how many it incorrectly fails.

Cutoff: the new tier ships if recall ≥ 0.85 and false-positive ≤ 0.05
on the eval set — same thresholds the supervisor tier was implicitly
held to in production.

### Before (commit `914d05b`, post-PR-72 audit baseline)

| Metric | Value |
|---|---|
| Critic tier | supervisor (`nvidia/nemotron-3-super-120b-a12b`) |
| Critic $ / 6-lesson build | ≈ $1.95 |
| Critic p50 wall-clock per call | _TBD_ |
| Synthetic block recall | _TBD_ (baseline) |
| False-positive on clean drafts | _TBD_ (baseline) |

### After (this PR)

> _To be filled once measurements are recorded against the deployed
> branch with `CRITIC_LLM_*` unset (default) and set._

| Metric | Default (utility fallback) | Configured (medium tier) |
|---|---|---|
| Critic $ / 6-lesson build | _TBD (≈ $0.04 expected)_ | _TBD (≈ $0.28 expected)_ |
| Critic p50 wall-clock per call | _TBD_ | _TBD_ |
| Synthetic block recall | _TBD_ | _TBD_ |
| False-positive on clean drafts | _TBD_ | _TBD_ |

## Risk and rollback

- **Quality risk**: the default fallback path runs the critic on the
  cheap utility tier. If the eval finds recall regressions, ops set
  `CRITIC_LLM_*` to a medium-tier model and the regression is gone
  with a single env change — no redeploy, no code change.
- **Schema risk**: zero. `CRITIC_LLM_*` is purely additive and
  optional. Existing deployments boot unchanged.
- **Wire-format risk**: zero. The critic prompt and JSON schema are
  byte-identical; only the upstream provider changes.
- **Rollback**: revert the PR. The critic resumes on the supervisor
  tier and the next build is at the pre-PR cost.

## Open follow-ups

- Wire the same `critic` tier into the supervisor's follow-up
  classifier (audit §6.1 recommendation) — currently still on
  `utility`. This is a one-line change once the synthetic eval lands
  and confirms the tier is not under-powered.
- Add a token-counter metric on the critic call so the cost win is
  observable in production logs without re-instrumentation.
- If the eval shows the default fallback regresses on language
  consistency for non-English lessons, raise the language check to
  a separate utility-tier classifier before the critic gate, so the
  critic is only asked structural questions.
