# Development history (PR #1 — PR #69)

This document distills the 69 PRs that built the audited system into the seven phases that make up its architectural arc. Each phase ends with the *invariant* it added — the property the system gained that all subsequent work could rely on.

The phases are not arbitrary: each one corresponds to a chapter section in the PFE book. They tell a real engineering story — supervisor-first, then streaming, then per-step granularity, then anchored UX, then a curriculum of pedagogical contracts, then activities, then the polish phase that revealed what the audit then targeted.

Inline PR references use the form `#NN`. Full subject lines and SHAs are at the bottom for citation.

---

## Phase 0 — Bootstrap (PR #1 — #6)

The minimum viable substrate for an agent platform: a monorepo, a database, a streaming protocol, and a typed agent state.

- **#1 bootstrap-foundation** — pnpm monorepo with `apps/api` (NestJS), `apps/web` (Next.js 15), `packages/shared` (Zod). DB migration `0001_init.sql` provisions threads, syllabuses, chapters, lessons, activities. `LlmConfigService` enforces three Zod-validated tiers (supervisor / writer / utility). PostgresSaver checkpointer with MemorySaver fallback. Phase-0 graph echoes input.
- **#2 pr2-agent** — first real agent. Supervisor (Grok, JSON-mode) routes between **search** and **command** subgraphs. Search: planner → per-topic Serper → picker → scraper → summarizer. Command: writer + critic with `MAX_REVISIONS=2` force-pass. Idempotent UPSERT to Supabase. Vercel AI SDK Data Stream Protocol v1 with allow-list streaming. *(Replaced wire-end-to-end by AI SDK v5 UI Message Stream in PR #91 — see Phase 7.)*
- **#3 pr2-review-fixes** — singleton race fix, scraper regex hardening, REPLICA IDENTITY FULL for Realtime DELETE.
- **#4 pr4-redesign** — **the typed-state revolution.** Monolithic `ui_state` is partitioned into five typed slices (phase, research_plan, todo_plan, manifest, interrupt) with patch helpers (`patchResearchStep`, `patchTodoStep`, `patchManifestItem`). `DataPart` becomes a discriminated union over `kind`. The `ask_user` action lands; the supervisor can now halt for clarification instead of guessing.
- **#6 mpfe-style** — three-pane FE landing (file tree | chat | viewer) styled to match MPFE.

> **Invariant after Phase 0:** every UI state slice is a known Zod schema. The graph cannot emit ad-hoc UI fields. The frontend cannot consume what it doesn't typecheck.

## Phase 1 — Streaming pipeline maturity (PR #7 — #22)

Making the wire fast, replayable, and recoverable. This is where the system stops feeling like a demo.

- **#7 responsive-ux**, **#8 fix-home-overflow** — first responsive pass on the 3-pane layout.
- **#9 ask-shape-prompts** — supervisor's "ask" path stops blocking on a single suggested response and offers structured shapes.
- **#10 deploy-infra** — Railway monorepo deploy targets (api + web).
- **#12 fix-interrupt-history-hydration** — interrupt history survives reload; the typed-slice contract is now reload-safe.
- **#13 resumable-streams-phase0** — first cut at SSE replay. The FE persists `lastId` and the API backfills from a buffer.
- **#16 add-railway-toml**, **#17 web-dockerfile**, **#18 fix-railway-cache-mount**, **#19 drop-pnpm-cache-mount**, **#20 split-railway-config**, **#21 deploy-docs-and-skill**, **#22 arg-cache-position** — production deploy hardening (the long tail of "your dev container ≠ Railway's").
- **#23 llm-noise-and-language** — `stripContentLength` fetch shim + the supervisor language detector.

> **Invariant after Phase 1:** a tab-close + reopen mid-run resumes the stream from the exact entry id, and the production target builds reproducibly.

## Phase 2 — Per-step granularity & realtime (PR #24 — #34)

Coarse "the agent is doing something" is replaced by *exactly* what stage of which sub-task is running.

- **#24 inline-ask** — clarifying questions render inline as a chat bubble instead of a sidebar modal.
- **#25 threads-index** — `/threads` page with cursor pagination + status filter.
- **#26 search-per-step**, **#27 search-parent-checkpoint** — the search subgraph emits per-topic substep transitions (`searching_urls → picking_candidates → scraping → summarizing → done`). The parent checkpoint is updated *between* substeps so reload mid-search hydrates the latest cursor.
- **#28 agent-run-realtime** — the `agent_runs` table + Supabase Realtime broadcast. The FE knows whether the server is still working even when the local SSE socket has dropped.
- **#29 failed-card-gating** — failed runs render an inline retry card; the input is gated until the user dismisses or retries.
- **#30 writer-per-lesson-stream** — the command subgraph emits per-lesson `writing → critiquing → accepted/rejected/failed` events.
- **#31 command-subgraph-inlining** — the command subgraph is restructured for granular per-lesson event emission.
- **#32 heartbeat-decoupled-timer** — `agent_runs.last_heartbeat` is updated on a wall-clock timer rather than tied to LLM token cadence; the reaper can now distinguish a slow LLM call from a crashed worker.
- **#33 supervisor-history-and-listeners** — `compactHistory(messages, 8)` lands. The first version of the audit's §2.5 finding.
- **#34 redis-stream-channel** — Redis Streams replace the in-process buffer for SSE replay; multi-instance deploys are unblocked.

> **Invariant after Phase 2:** every long-running node emits intermediate state, every reload re-anchors to that state, and the run lifecycle is observable from a separate process.

## Phase 3 — Stream correctness & abort decoupling (PR #35 — #40)

The bugs that only show up at the edge of the network — Cloudflare buffering, request abort vs run abort, tab-close-mid-stream — get squashed.

- **#35 redis-stream-terminal-ordering** — the terminal `d:` finish frame is guaranteed to arrive *after* all preceding text/data frames.
- **#36 decouple-agent-from-request** — the agent run no longer dies when the originating HTTP request closes. `AbortController` is owned by the run registry.
- **#37 post-loop-abort-check** — the writer checks the abort signal between revisions, not just before/after.
- **#38 fix-stream-edge-buffering** — Vary/Content-Type/X-Accel headers force edge proxies to flush.
- **#39 fix-stream-cycle-wrapup** — the wrap-up bubble (the final assistant message) is always emitted, even when the supervisor decides "ask".
- **#40 fastly-no-buffer-stream** — `X-Accel-Buffering: no` for Fastly + Cloudflare.

> **Invariant after Phase 3:** the user can see the stream in real time on every tested edge, the agent run survives the user closing the tab, and the user can reliably stop it from another tab.

## Phase 4 — Anchored UX & pedagogical contracts (PR #41 — #50)

The single most consequential UX change in the codebase. Before this phase, cards (research, todo, worksheet, ask) lived in a side panel. After this phase they are *pinned to the chat message that triggered them*.

- **#41 card-anchor-indices** — the supervisor records `research_anchor_msg_index` and `todo_anchor_msg_index` at the moment it decides to fan out. The FE renders cards inline under the AI bubble at that index. Reload places them in the same place.
- **#42 split-wrapup-bubble** — the wrap-up assistant turn becomes a separate message after the last card so cards can never push the wrap-up off-anchor.
- **#43 pedagogical-overhaul** — the `Pedagogy` / `LearningObjective` / `BloomLevel` schemas land. The writer's prompt becomes *contract-driven*: every lesson must satisfy a schema-defined set of objectives, prerequisites, key terms, worked example, assessment idea.
- **#44 picker-other-dedup-fix** — picker v2 diversity filter (one per `source_type` when possible).
- **#45 viewer-contract-chips** — the lesson detail viewer renders `Pedagogy` chips above the body so a teacher can see at a glance what the lesson promises.
- **#46 intake-form** — the intake card replaces freeform clarifying-question replies with a typed `IntakeFormSpec` (audience level, prior knowledge tags, duration, language, target outcome).
- **#48 writer-critic-deadlock** — writer/critic v2 with deterministic deadlock detection via `blockFingerprint`. After two passes with the same block-issues the loop force-passes early. Surfaced in audit §2.7 as a candidate for explicit user notification.
- **#49 mark-reviewed**, **#50 review-fixes** — review state on lessons.

> **Invariant after Phase 4:** every visible artifact in the chat is anchored to a server-authoritative message index, and every generated lesson satisfies a typed pedagogical contract.

## Phase 5 — Critic v2 & search/replace patches (PR #51 — #54)

The writer-critic loop graduates from "rewrite the whole thing" to "Aider-style surgical patches".

- **#51 critic-context-and-patches** — critic v2's 14-point checklist + severity rules (block / warn / nit). The writer accepts patches in `<<<<<<< SEARCH / ======= / >>>>>>> REPLACE` fences with a fallback to full rewrite.
- **#53 agent-docs-page** — public `/docs` page for the agent contract.
- **#54 patch-locate-reason** — failed-patch errors now report *why* the SEARCH block didn't match.

> **Invariant after Phase 5:** revisions are surgical, drafts are cached for 30 min and rehydrate on reload, and unmatched patches surface a teachable error rather than a silent fail.

## Phase 6 — Activity agents & MCP (PR #55 — #69)

The system goes from one agent (syllabus) to three (syllabus + activity-tooled + activity-toolless), introduces MCP grounding, and finishes with a polish pass that reveals what the audit then attacked.

- **#55 activity-agents** — `apps/mcp-supabase` (Python FastMCP) + `activity-generator-tooled` and `activity-generator-toolless` agents. Threads can now be bound to a syllabus.
- **#56 mcp-deploy-fix**, **#58 mcp-tool-zod-schema**, **#59 mcp-tool-zod-build-fix**, **#60 mcp-tool-call-fix**, **#61 mcp-content-collapse** — MCP integration hardening.
- **#62 threads-pagination**, **#63 fix-new-thread-modal-pagination** — agent tabs + cursor pagination on the threads index.
- **#65 stream-mcp-tool-calls** — typed `activity_tool_calls` stream slice; the FE shows a live timeline of MCP tool calls.
- **#66 activity-tooled-bugfixes** — bug fixes for the activity-tooled flow.
- **#67 interactive-activity-agents** — follow-up classifier (emit / ask / reset_intake / reply) with `intake_overrides` and topic pivot detection.
- **#68 fix-intake-topic-loss** — fixes a class of intake topic-loss bugs.
- **#69 tool-call-chip-workbench** — the final pre-audit feature: the chat renders an `EMIT_WORKSHEET` chip per worksheet and the right-pane workbench opens the worksheet when the chip is clicked.

> **Invariant after Phase 6:** the platform supports three coordinated agents, grounded generation via MCP, and a workbench-style UI for the resulting artifacts.

## Phase 7 — Post-audit polish, real-time UX, AI SDK v5 (PR #70 — #91)

The audit (`01-audit.md`) was performed against the post-#69 state.
PRs #70 — #79 are the audit-driven optimisations whose individual
write-ups live under `02-optimizations/`. PRs #80 — #91 are the polish
+ wire-format work that landed on top — they don't have one-file
optimisation write-ups (the changes are smaller and read better as a
phase summary), so they're documented here.

- **#70 pfe-docs-scaffold** — this very directory: `00-history.md`, the audit, the per-optimisation skeleton, the LaTeX chapter shell.
- **#71 hydration-from-events** — `01-audit.md` §2.2: completed-thread reload no longer loses history. `/state` rebuilds messages + interrupts from the Redis event log when the checkpointer has nothing to say.
- **#72 fix-listforthread-doc** — minor doc fix.
- **#73 parallel-research-send** — `01-audit.md` §2.1: research subgraph fanout via LangGraph `Send`, replacing the per-topic state-machine. Single slow scrape no longer stalls the whole syllabus build.
- **#74 critic-tier** — `01-audit.md` §2.4: critic moves off the supervisor tier onto its own `CRITIC_LLM_*` (with `UTILITY_LLM_*` fallback). 3-5× cost reduction on revision-heavy threads.
- **#75 intake-dedup** — `01-audit.md` §2.3: synthesised "[Intake] …" message stops double-rendering as both card + bubble. Activity intake substitutes lesson titles for raw UUIDs.
- **#76 research-sources** — `01-audit.md` §3.5: `ResearchStep` schema gains `sources[]`. The Research card now renders titles + URLs + favicons per topic.
- **#77 quick-wins** — `01-audit.md` §3 polish bundle: empty-state copy fixes, accessibility on IntakeCard radios, loading-state cosmetics.
- **#78 writer-recovery** — `01-audit.md` §2.7 / §5.4: critic_issues persisted as structured rows (not just embedded in lesson markdown), `MAX_REVISIONS` bumped 2 → 3.
- **#79 fe-perf** — `01-audit.md` §3.2 / §3.6: ETag/304 on threads list polling, length-keyed `useMemo` deps in chat-pane to stop re-evaluating anchor maps every streamed token.
- **#80 fix-etag-signature** — review-fix on #79: ETag signature tracks `agent_runs` + `syllabuses` not just `threads`; load-more preserves the etag.
- **#81 threads-scroll-area**, **#83 modal-and-link-polish**, **#84 agent-status-pill** — UX polish: pin `/threads` chrome, scroll only the list; clearer new-thread modal + semantic agent icons + SPA links; persistent agent-presence indicator above the chat input.
- **#82 update-skills** — testing skill update.
- **#85 activity-progress-streaming** — activity-tooled streams worksheet generation progress via the new `activity_progress` typed slice.
- **#86 activity-cold-start-chat** — activity threads greet the user and chat *before* opening the intake form, instead of jumping straight to a setup card.
- **#87 real-token-streaming** — supervisor + activity decide nodes now stream LLM tokens live token-by-token (replacing the `PartialJsonFieldExtractor` byte-walker for live UX). Includes a fix for the `\u`-escape edge case where the partial-json buffer disambiguates a half-emitted unicode escape.
- **#88 stream-user-message-first** — supervisor JSON envelope reordered so `user_message` / `reply` is emitted first, allowing the chat reply to start streaming the moment the model finishes its plan rather than after the full envelope closes.
- **#89 fe-render-stream-deltas-live** — `useDeferredValue` is removed from the Markdown renderer in the chat. Streamed deltas now render on every keystroke instead of being throttled to React's idle scheduling.
- **#91 ai-sdk-v5-migration** — Vercel AI SDK v4 (Data Stream Protocol v1, line-prefixed `0:` / `2:` / `3:` / `d:`) is replaced wire-end-to-end by **AI SDK v5 UI Message Stream** (SSE with typed JSON frames). `apps/api/src/chat/data-stream.ts` is rewritten; `apps/web/components/chat/chat-pane.tsx` flips to v5 `useChat` from `@ai-sdk/react` via `DefaultChatTransport`; `apps/web/lib/agent-run-realtime.ts` re-targets the SSE event-boundary parser. Two ordering bugs fixed in the same PR: the POST error path now emits `[DONE]` (commit `25e47c6`), and the terminal `data-run` slice is emitted **before** `writer.finish()` so the v5 writer's internal `finished` flag doesn't silently drop it from the driving tab's socket (commit `f05acc9`). Anchor index, intake / activity-intake interrupts, cross-tab + reload resume, and per-lesson critic gating all reverified end-to-end against the new wire.

> **Invariant after Phase 7:** the four audit P0/P1 classes are
> resolved with measured before/after numbers; chat tokens render
> live; and the FE talks to the API on Vercel AI SDK v5's typed
> `data-<kind>` SSE frames with no v4 line-prefix code paths
> remaining.

---

## What the audit then revealed

The audit (`01-audit.md`) was performed against the post-#69 state. It found that the foundations laid in Phases 0–6 were sound, but the *integration* between them had four classes of bug:

1. **Reload contracts violated** — the per-slice anchored UX (Phase 4) requires `state.messages` to survive completion. It does not. Cards therefore render against an empty chat. (`01-audit.md` §2.2)
2. **Sequentialism in async-friendly code** — the per-step granularity (Phase 2) was implemented as a state-machine with `search_step_index`, not as a fan-out. One slow scrape blocks the other four topics. (`01-audit.md` §2.1)
3. **Tier-overload** — the three LLM tiers (Phase 0) load supervisor with both routing and critic. Critic is the heavier consumer. (`01-audit.md` §2.4)
4. **UX duplication** — the synthesized intake message (Phase 4) is rendered both as a resolved card and as a user bubble, and uses raw lesson UUIDs. (`01-audit.md` §2.3)

The post-audit work in `02-optimizations/` resolves these in the order P0 → P1 → P2.

---

## Citation index — all 69 merge commits

Every PR with its merge SHA, original branch slug, and the architectural significance one-liner. Use this when citing in the LaTeX chapter.

| #   | SHA       | Slug                                | Significance                                     |
|-----|-----------|-------------------------------------|--------------------------------------------------|
| 1   | 31a38da   | bootstrap-foundation                | Monorepo, DB schema, streaming protocol, 3 LLM tiers |
| 2   | 741db9b   | pr2-agent                           | Supervisor + search + command subgraphs (E2E)    |
| 3   | 2a6a11e   | pr2-review-fixes                    | Singleton race + REPLICA IDENTITY FULL           |
| 4   | 74dd99a   | pr4-redesign                        | Typed-slice DataPart union; ask_user action      |
| 5   | af98840   | update-skills (1777193923)          | Devin skill update                               |
| 6   | 72a9c49   | mpfe-style                          | 3-pane MPFE-styled FE                            |
| 7   | f57bc1c   | responsive-ux                       | First responsive pass                            |
| 8   | fdcfafb   | fix-home-overflow                   | Layout overflow fix                              |
| 9   | 37d15a7   | ask-shape-prompts                   | Structured ask shapes                            |
| 10  | 36018af   | deploy-infra                        | Railway monorepo deploy targets                  |
| 12  | 072e50c   | fix-interrupt-history-hydration     | Interrupt history reload-safe                    |
| 13  | 8bf5ad5   | resumable-streams-phase0            | First cut SSE replay                             |
| 15  | c1f4cae   | update-skills (1777225347)          | Skill update                                     |
| 16  | 497e504   | add-railway-toml                    | Railway config                                   |
| 17  | db4bf56   | web-dockerfile                      | Web dockerfile                                   |
| 18  | 34eef0f   | fix-railway-cache-mount             | Cache mount fix                                  |
| 19  | e4edaf1   | drop-pnpm-cache-mount               | Drop pnpm cache mount                            |
| 20  | a54f202   | split-railway-config                | Split railway config                             |
| 21  | 62ac3ef   | deploy-docs-and-skill               | Deploy docs + skill                              |
| 22  | bc27245   | arg-cache-position                  | Dockerfile ARG ordering                          |
| 23  | 25d40e5   | llm-noise-and-language              | stripContentLength + language detector           |
| 24  | 183df5e   | inline-ask                          | Inline ask bubble                                |
| 25  | 2bc3fd9   | threads-index                       | /threads page                                    |
| 26  | 104951d   | search-per-step                     | Per-topic substep transitions                    |
| 27  | f0f09f0   | search-parent-checkpoint            | Parent checkpoint between substeps               |
| 28  | deb4df5   | agent-run-realtime                  | agent_runs + Realtime broadcast                  |
| 29  | 58e1e34   | failed-card-gating                  | Failed-run inline retry card                     |
| 30  | 266a2e5   | writer-per-lesson-stream            | Per-lesson writer events                         |
| 31  | c3e6b54   | command-subgraph-inlining           | Command subgraph restructure                     |
| 32  | 21756ed   | heartbeat-decoupled-timer           | Wall-clock heartbeat                             |
| 33  | d8f9698   | supervisor-history-and-listeners    | compactHistory(8); listeners                     |
| 34  | 3694911   | redis-stream-channel                | Redis Streams replace in-proc buffer             |
| 35  | 8c85ce5   | redis-stream-terminal-ordering      | Terminal frame ordering                          |
| 36  | 922f18a   | decouple-agent-from-request         | Agent run survives request close                 |
| 37  | ca0d43a   | post-loop-abort-check               | Abort check between revisions                    |
| 38  | 9c0bf4f   | fix-stream-edge-buffering           | Vary/X-Accel for edge proxies                    |
| 39  | 88ae739   | fix-stream-cycle-wrapup             | Wrap-up bubble always emitted                    |
| 40  | 0b4934e   | fastly-no-buffer-stream             | X-Accel-Buffering: no                            |
| 41  | 8a754d6   | card-anchor-indices                 | Server-authoritative anchor indices              |
| 42  | 1413896   | split-wrapup-bubble                 | Wrap-up split from cards                         |
| 43  | 3fb2867   | pedagogical-overhaul                | Pedagogy / LearningObjective / BloomLevel        |
| 44  | b9bee56   | picker-other-dedup-fix              | Picker v2 diversity                              |
| 45  | 8cb4640   | viewer-contract-chips               | Contract chips in viewer                         |
| 46  | e3567fb   | intake-form                         | IntakeFormSpec (typed)                           |
| 47  | 462627a   | update-skills (1777319766)          | Skill update                                     |
| 48  | 748fd64   | writer-critic-deadlock              | blockFingerprint deadlock detection              |
| 49  | 7f008e1   | mark-reviewed                       | Lesson review state                              |
| 50  | 56a6a8a   | review-fixes                        | Review fixes                                     |
| 51  | 934c939   | critic-context-and-patches          | Critic v2 + SEARCH/REPLACE patches               |
| 52  | c6e7751   | update-skills (1777330573)          | Skill update                                     |
| 53  | 1502c70   | agent-docs-page                     | Public /docs page                                |
| 54  | d819fd7   | patch-locate-reason                 | Patch failure reason                             |
| 55  | f554231   | activity-agents                     | activity-tooled + activity-toolless + MCP        |
| 56  | 8164012   | mcp-deploy-fix                      | MCP deploy fix                                   |
| 57  | 06dc395   | update-skills (1777363216)          | Skill update                                     |
| 58  | bf0355e   | mcp-tool-zod-schema                 | MCP tool zod schema                              |
| 59  | 56933af   | mcp-tool-zod-build-fix              | MCP build fix                                    |
| 60  | b0c5ac1   | mcp-tool-call-fix                   | MCP tool call fix                                |
| 61  | 7282049   | mcp-content-collapse                | MCP content collapse                             |
| 62  | a87162d   | threads-pagination                  | Threads cursor pagination                        |
| 63  | 345f2ab   | fix-new-thread-modal-pagination     | New-thread modal pagination                      |
| 64  | d781b42   | update-skills (1777380400)          | Skill update                                     |
| 65  | d6ad930   | stream-mcp-tool-calls               | Typed activity_tool_calls slice                  |
| 66  | 0e9190d   | activity-tooled-bugfixes            | Activity-tooled bug fixes                        |
| 67  | bed2cfc   | interactive-activity-agents         | Follow-up classifier                             |
| 68  | 0c21cfb   | fix-intake-topic-loss               | Intake topic loss fix                            |
| 69  | 5416089   | tool-call-chip-workbench            | EMIT_WORKSHEET chip + workbench                  |
| 70  | 244a5c6   | pfe-docs-scaffold                   | This directory scaffold                          |
| 71  | ec490a7   | hydration-from-events               | Audit §2.2: completed-thread reload restores history |
| 72  | 914d05b   | fix-listforthread-doc               | Doc fix                                          |
| 73  | 17b719b   | parallel-research-send              | Audit §2.1: research fanout via LangGraph `Send` |
| 74  | 9513fc5   | critic-tier                         | Audit §2.4: dedicated CRITIC_LLM_* tier          |
| 75  | 690ec74   | intake-dedup                        | Audit §2.3: intake double-render fix             |
| 76  | 1fea3e9   | research-sources                    | Audit §3.5: ResearchStep.sources[]               |
| 77  | b306ad7   | quick-wins                          | Audit §3 polish bundle                           |
| 78  | cbb50dd   | writer-recovery                     | Audit §2.7/§5.4: structured critic_issues + MAX_REVISIONS 3 |
| 79  | 6131393   | fe-perf                             | Audit §3.2/§3.6: ETag/304 polling + memo deps    |
| 80  | 051ec49   | fix-etag-signature                  | ETag tracks agent_runs+syllabuses; preserve on load-more |
| 81  | 460f6bc   | threads-scroll-area                 | Pin /threads chrome; scroll only the list        |
| 82  | da415d1   | update-skills (1777501639)          | Testing skill update                             |
| 83  | 8bf31e9   | modal-and-link-polish               | Clearer new-thread modal + semantic icons + SPA links |
| 84  | 8bc14a8   | agent-status-pill                   | Persistent agent-presence indicator              |
| 85  | f7858e7   | activity-progress-streaming         | activity_progress typed slice                    |
| 86  | bc632c6   | activity-cold-start-chat            | Activity greets + chats before intake form       |
| 87  | 89526c7   | real-token-streaming                | Live LLM token streaming on supervisor + activity decide |
| 88  | c471bca   | stream-user-message-first           | user_message emitted first in JSON envelope      |
| 89  | 36cfcbd   | fe-render-stream-deltas-live        | Drop useDeferredValue on chat Markdown           |
| 91  | 9709b23   | ai-sdk-v5-migration                 | Vercel AI SDK v4 → v5 UI Message Stream wire     |

Note: PRs #11 and #14 do not appear in `git log --merges`; they were
rebased / closed without merge in the original development. PR #90
was closed without merge.
