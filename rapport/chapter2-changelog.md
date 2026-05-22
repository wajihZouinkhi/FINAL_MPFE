# Chapter 2 — Changelog

Revision of `rapport/chapters/chapter2.tex` to align the chapter with a comparative,
defensible-at-oral, Chapter-3-ready direction.

## Headline change

The chapter no longer reads as a software-testing report. It now reads as
**conception + comparative reading of the implemented agent forms**, with a
strong bridge into Chapter 3 on orchestration.

## What was removed

- **`§2.4` Tests et évaluation de la couche d'agents (≈290 lines).** The whole
  pass/partial/fail-style testing section was dropped. This included:
  - Campaign A/B framing (test protocol).
  - Latency table per prompt (ms), token consumption table (in/out/total),
    MCP-call-count tables, worksheet-structure tables.
  - The historical syllabus performance table (`tab:syllabus-hist`).
  - The per-node token-cost breakdown table for syllabus generation
    (`tab:syllabus-timing`).
  - The Synthèse-et-discussion paragraphs framing the chapter around
    "+38 % latency", "×3.2 input tokens", etc.
- **Legacy V1 MCP names in the deepagent subsection.** The mentions of
  `create_chapter` and `create_lesson` were replaced by the canonical
  `create_unity` / `create_activity` so the chapter uses the final
  pedagogical vocabulary (syllabus, unité, activité) consistently.
- **The `$\tau$` threshold framing in `§2.1.2`.** The explicit "seuil τ, fixé
  empiriquement / si la similarité dépasse τ" paragraph was replaced by a more
  cautious formulation that states the calibration is a server-side
  implementation parameter and that the chapter does not depend on any
  numeric value.
- **Intro sentence "La méthodologie de tests sera définie ultérieurement"**
  was dropped. The chapter no longer promises a future testing campaign — it
  announces a comparative reading instead.

## What was reframed

### `§2.4` is now `Lecture comparative des implémentations`

Architectural reading of the implemented agents, organised in five
subsections:

1. **Axes de comparaison** — four orthogonal axes used throughout the
   section: orchestration ownership (LLM vs code), human posture
   (HITL / operator / programmatic), inspectable-artifact granularity
   (token stream vs VFS vs DB rows), cost & latency envelope.
2. **Agent 1 contre agent 2 : la valeur conditionnelle de l'ancrage** —
   prose comparison of the tool-less vs MCP-tooled activity generators.
   Numbers are kept as orders of magnitude (~×3 input tokens, ~tens of
   percent latency overhead) and are explicitly framed as the *price of
   anchoring*, not as a verdict.
3. **Quatre variantes de l'agent 3, quatre profils d'intégration** —
   one paragraph per variant (V1/Op.1 conversational HITL,
   V1/Op.2 deepagent specialist subagents, V2/Op.1 manual workshop,
   V2/Op.2 SDK orchestrator) describing what each variant is *better
   adapted to* and what it *pays in return* — exactly per the
   instruction to use "cette variante privilégie / en contrepartie"
   formulations.
4. **Coûts observés et enveloppes d'usage** — observed timings (30 s to
   2 min for a full syllabus, etc.) are kept only as ordres de grandeur
   to qualify three distinct *usage envelopes* (interactive / workshop /
   industrial). The text explicitly says these numbers do not designate
   a preferred variant.
5. **Enseignements croisés** — the three lessons that motivate
   Chapter 3: orchestration ownership is the structuring axis, variants
   differ by human posture more than by raw quality, and the value of
   MCP+indexing is conditional on the query.

There are no longer any PASS / PARTIEL / FAIL tables, no
screenshot-by-screenshot description, no scenario assertions, and no
quantitative tables in the comparative section.

### `§2.5` is now `Conclusion : du catalogue à l'orchestration`

A purpose-built bridge into Chapter 3, not a recap of the test
campaign. It:

1. Summarises the three structuring elements of Chapter 2 (indexation,
   MCP/least-privilege, agent catalogue).
2. States the central finding: the four agent-3 variants are not on a
   linear quality scale; they answer different integration questions
   and none is universally preferable.
3. Frames the open questions explicitly (routing between variants,
   articulating conversational / workshop / SDK surfaces, observability,
   security policy from least-privilege).
4. Announces Chapter 3 in concrete terms: orchestration strategy,
   observability dispositif, security analysis, operational procedures.

The closing sentence ("Le chapitre 2 a comparé les formes d'agents ;
le chapitre 3 organise leur coexistence.") makes the
conception → orchestration transition unambiguous.

### Intro paragraph

The chapter intro was retuned to:

- announce four numbered sections plus a conclusion (matching the new
  structure);
- describe `§2.4` as a *comparative reading*, not a test campaign;
- explicitly mention that the conclusion prepares Chapter 3.

## What was deliberately kept

Per the brief, the following structuring elements were kept (and
compressed only lightly):

- The redundancy problem and the indexation principle (`§2.1`).
- The three MCP servers + least-privilege whitelist tables (`§2.2`).
- The agent catalogue, the 2-axis matrix figure of agent-3 variants,
  and the four agent-3 variants themselves (`§2.3`).
- The V2 public state machine figure (`fig:v2-status`).
- Real observations from the deployed instance, but only as
  *support for architectural comparison*, never as the main story.

## Files touched

- `rapport/chapters/chapter2.tex` — the only source-of-truth chapter file.
  - Intro paragraph retuned.
  - `§2.1.2` softened around the similarity threshold.
  - `§2.3.4` V1/Op.2 deepagent section: `create_chapter`/`create_lesson`
    legacy names replaced by canonical `create_unity`/`create_activity`.
  - `§2.4` fully replaced (Tests → Lecture comparative).
  - `§2.5` fully replaced (Conclusion → Bridge to Chapter 3).
- `rapport/chapter2-changelog.md` — this file.
- `rapport/main.pdf` — regenerated for preview.

Line count went from `1684` to `1580` (≈ −6 %); the tests block alone
(≈ 345 lines) was replaced by ≈ 250 lines of comparative prose, and
the rest of the chapter was kept and only marginally adjusted.

## Compilation

The chapter compiles cleanly with the existing `rapport/compile.sh`
(pdflatex + bibtex + makeglossaries, three passes). The only LaTeX
warning is the pre-existing `Warning: There were undefined references.`
that was already present on `main` before this change.
