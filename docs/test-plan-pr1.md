# PR #1 Smoke Test Plan — Phase-0 Foundation

**Goal:** prove the four pieces of wiring that subsequent PRs depend on actually
work end-to-end, in a way that would visibly fail if any one of them were
broken.

What this PR contains (relevant code paths):

- `apps/web/app/page.tsx:11-24` — `startThread()` POSTs to `/api/threads` and
  navigates to `/threads/{id}`.
- `apps/web/app/threads/[id]/view.tsx:38-53` — Vercel AI SDK `useChat` against
  `/api/chat/{threadId}` with `streamProtocol: "data"`, plus `ui_state` patch
  merger reading from `data` parts.
- `apps/web/app/threads/[id]/view.tsx:115` — right pane header renders
  `ui.phase`, initialised to `"idle"` (line 14).
- `apps/api/src/chat/chat.controller.ts` — Vercel AI SDK Data Stream v1
  allow-list: forwards `on_chat_model_stream` text and `on_chain_end`
  `ui_state` patches; never forwards tool calls / tool messages.
- `apps/api/src/graph/graph.service.ts` — `PostgresSaver.fromConnString(...)` +
  `saver.setup()`; falls back to `MemorySaver` with a warning if the DB URL
  doesn't connect.

What a "broken" implementation would look like, by component:

| Component | Broken symptom this plan catches |
|---|---|
| Thread creation route | "New thread" button click stays on `/` (or 404 on `/threads/{id}`) |
| Snapshot fetch | Right pane shows "Loading snapshot…" indefinitely instead of "No syllabus yet" |
| Vercel AI SDK Data Stream | Left pane shows nothing, or shows raw JSON / tool-call payload, or stays "Send" disabled forever |
| `ui_state` patch merger | Right pane header keeps reading `idle` after the stub responds |
| Allow-list mask | Left pane reveals tool-call JSON or "Phase-0 stub" appears in the wrong place |
| `PostgresSaver` checkpointer | After full page reload, the user message + AI reply disappear from the left pane |

---

## Primary flow (one continuous recording)

### Test 1 — "It should create a thread, stream a stub reply, flip phase to chatting, and persist across reload"

**Setup state:** API + Web are running locally. `.env` has all 9 LLM tier
vars, real `SUPABASE_DB_URL`, Redis URL. Boot logs confirmed
`Tier supervisor: ...`, `Tier writer: ...`, `Tier utility: ...`,
`Using PostgresSaver checkpointer`, `Graph compiled`,
`Redis connected (PONG)`, `API listening on http://localhost:3001`.

#### Step 1 — Open landing page
- **Action:** Navigate browser to `http://localhost:3000`.
- **Expected:**
  - Page title `"FINAL_MPFE — Syllabus Generator"` is visible in the document title.
  - Heading text reads exactly `"Syllabus Generator"`.
  - A button labelled `"New thread"` is present and **not** disabled.
- **Pass criterion:** all three exact strings observed.
- **Why this catches breakage:** if SSR is broken or the API URL env is
  misconfigured the page won't render the button.

#### Step 2 — Create a thread
- **Action:** Click the `"New thread"` button.
- **Expected:**
  - Button text briefly changes to `"Creating…"`.
  - URL changes to `/threads/{uuid}` where `{uuid}` is a 36-char UUID.
  - Two-pane layout renders: left pane has header `"Thread {first 8 of uuid}…"`
    and a placeholder paragraph starting with
    `"Ask the agent to build a syllabus."`; right pane shows
    `Phase` label with value **`idle`**, and below it the card
    `"No syllabus yet"`.
- **Pass criterion:** URL pattern matches, **right pane header reads `idle`**
  (NOT `chatting`), `"No syllabus yet"` card visible.
- **Why this catches breakage:** if `POST /api/threads` is broken the user
  stays on `/` with a red error. If the snapshot fetch is broken, the right
  pane is stuck on `"Loading snapshot…"`. If the initial `ui_state` is
  miswired, the phase header would already say `chatting`.

#### Step 3 — Send "hello" and observe streaming
- **Action:** Type `hello` in the input at the bottom of the left pane and
  click the `"Send"` button.
- **Expected during stream:**
  - User message bubble (label `USER`) shows `hello`.
  - AI message bubble (label `ASSISTANT`) appears and shows text containing
    the substrings:
    - `Acknowledged: "hello".`
    - `Phase-0 stub`
  - Left pane shows **no** raw JSON, no `tool_calls`, no `ToolMessage`
    payload.
  - Right pane header **flips from `idle` to `chatting`**.
- **Pass criterion:** both substrings present, no raw JSON visible, phase
  header now reads `chatting`.
- **Why this catches breakage:** if Data Stream Protocol isn't wired
  (`streamProtocol: "data"`), `useChat` will either show nothing or render
  raw bytes. If the allow-list is wrong, tool messages would leak. If the
  `ui_state` patch merger misses the data part, phase would still be `idle`.

#### Step 4 — Reload page; verify Postgres-backed history persistence
- **Action:** Press `F5` (or browser reload) on the same `/threads/{uuid}` URL.
- **Expected:**
  - Both the user `hello` message and the AI `Acknowledged: "hello". ... Phase-0 stub` reply still render in the left pane after reload.
  - Right pane shows `"No syllabus yet"` (snapshot didn't write rows) and
    phase header is back to `idle` (this is correct — `ui_state` lives in
    React state, not the checkpointer; only LangGraph `messages` persist).
- **Pass criterion:** both messages reappear without sending another request.
- **Why this catches breakage:** if `PostgresSaver` silently fell back to
  `MemorySaver`, reload would drop the message history (left pane would be
  empty again). This is the entire point of wiring the checkpointer in PR 1.
- **Verification beyond UI:** also assert via curl that
  `GET /api/chat/{threadId}/state` returns a `messages` array with `human` +
  `ai` entries matching the chat (already confirmed during setup, will
  re-verify here as the persistence proof point).

#### Step 5 — Restart API; reload page; verify history STILL persists
- **Action:** Kill the API process, restart it (`node apps/api/dist/main.js`),
  wait for `Using PostgresSaver checkpointer` + `Graph compiled` in logs,
  then reload the same browser tab on `/threads/{uuid}`.
- **Expected:** chat history still present (this is the strongest evidence
  PostgresSaver actually writes through to Supabase rather than just
  surviving an in-process React refresh).
- **Pass criterion:** same as step 4 but across a process restart.
- **Why this catches breakage:** would expose a `MemorySaver` fallback that
  step 4 alone could miss (in-process state survives an HMR reload but not
  a process restart).

---

## Out of scope for this test plan

Explicitly *not* tested in PR #1 (deferred to later PRs):

- Real Supervisor / Search / Writer subgraphs (PR 2 + 3).
- Supabase Realtime row subscriptions on the frontend (PR 4).
- Sticky workspace components (`SearchTracker`, `Manifest`,
  `ContentViewer`) — PR 4.
- Activities / quizzes (out of scope for v1).
- Auth / `user_id` (out of scope per project decision).
