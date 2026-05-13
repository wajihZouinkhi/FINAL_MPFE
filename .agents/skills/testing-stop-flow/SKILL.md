# Testing FINAL_MPFE Stop/cancel flow

Reference for validating the syllabus-generator Stop/cancel terminal cleanup behavior.

## Devin Secrets Needed

- `SUPABASE_DB_URL` — pooler connection string for LangGraph/Postgres state.
- `SUPABASE_URL`, `SUPABASE_ANON_KEY` — Supabase realtime/REST.
- `SUPABASE_MANAGEMENT_PAT`, `SUPABASE_PROJECT_REF` — migrations via `pnpm db:push`.
- `XAI_API_KEY`, `NVIDIA_API_KEY` — supervisor/writer/utility LLM tiers.
- `SERPR_API_KEY` — Serper.dev search.
- Redis should run locally as container `mpfe-redis` on port `6379`.

## Setup

Use the general `.agents/skills/testing-final-mpfe/SKILL.md` setup first: source the root `.env`, run `pnpm db:push`, start the API on `3001`, and use the web app on `3000`.

Production web mode is usually the most stable for recordings:

```bash
cd /home/ubuntu/repos/FINAL_MPFE
set -a && source .env && set +a
pnpm --filter @mpfe/web build
pnpm --filter @mpfe/web start
```

## Flow to trigger Stop cleanup

1. Open `/threads` and create a **Syllabus generator** thread.
2. Send a long syllabus prompt, for example:
   `Create a 5-chapter, 15-lesson syllabus introducing distributed databases for undergraduate CS students, ending in a hands-on replication and sharding project.`
3. If the supervisor routes through the setup/intake card, click the pre-filled **Start research** button. This is expected for some prompts and still leads into the long-running research/write flow.
4. Wait until the top badge is `WORKING` and the button beside the chat input is exactly **Stop**.
5. Click **Stop**.

## Assertions

The important evidence for the Stop/cancel terminal cleanup is:

- visible sequence `Stop` → `Stopping…` → no Stop button
- cancel request `POST /api/chat/:threadId/runs/:runId/cancel` returns `202`
- no `Could not stop the run` toast appears
- within 90 seconds, the badge is no longer `WORKING`
- the input placeholder returns to `Send a message…`
- `/api/chat/:threadId/state.latest_run.status` is terminal (`failed`, `completed`, or `paused`)
- API logs contain `cancel: aborted run ... by user request` or `cancel: broadcast for run ...`

## Capturing fast `Stopping…` transitions

The `Stopping…` state can be very brief when the backend aborts quickly. For recordings, use a read-only browser overlay before starting the flow. The overlay should only observe DOM text and wrap `window.fetch` to log metadata for app-owned requests; it must not call APIs itself or mutate application state.

The overlay should log:

- current Stop button text (`Stop`, `Stopping…`, or `none`)
- current lifecycle badge (`WORKING`, `ASKING`, `FAILED`, etc.)
- input placeholder (`Agent is working…` or `Send a message…`)
- cancel response status (`202` expected)
- app-owned `/state.latest_run.status` responses

After the visual run, fetch `/api/chat/<thread-id>/state` from the shell for text evidence and keep the relevant API log excerpt in the test report.
