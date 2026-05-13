# mpfe-mcp-supabase

A Python MCP server exposing Supabase access to two agents:

- the legacy **activity-generator-tooled** agent (read-only, used to
  ground a worksheet in real chapter / lesson content), and
- the new **deep-agent** supervisor + four specialist subagents
  (`pedagogy_planner`, `writer`, `activity_maker`, `pedagogy_critic`).
  Read access for the supervisor / writer / activity_maker /
  pedagogy_critic, plus four write tools: `create_syllabus`
  (supervisor), `create_chapter` + `create_lesson` (writer), and
  `create_activity` (activity_maker).

It speaks the [Model Context Protocol](https://modelcontextprotocol.io/)
over stdio (local) or streamable-http (Railway).

The API process either spawns this server as a child via
`@langchain/mcp-adapters` (legacy activity-tooled path) or connects to
it over HTTP via the `@modelcontextprotocol/sdk` (deep-agent path —
see `packages/deep-agent/src/mcp.ts`).

## Tools

### Read

| Tool | Args | Returns |
| --- | --- | --- |
| `list_syllabuses` | `thread_id: uuid` | rows from `syllabuses` |
| `get_syllabus` | `syllabus_id: uuid` | one row from `syllabuses` (or `None`) |
| `list_chapters` | `syllabus_id: uuid` | ordered rows from `chapters` |
| `list_lessons` | `chapter_id: uuid` | ordered rows from `lessons` (titles only) |
| `list_lessons_for_thread` | `thread_id: uuid` | flat menu of every lesson with chapter titles |
| `get_lesson` | `lesson_id: uuid` | full lesson row including markdown body |

`list_lessons_for_thread` is the one-stop "give me the menu" tool the
activity-tooled agent reaches for first; `get_lesson` is the targeted
second pass after the agent picks one.

### Write (deep-agent supervisor + writer + activity_maker)

| Tool | Args | Returns |
| --- | --- | --- |
| `create_syllabus` | `thread_id`, `title`, optional `description` / `audience` / `scope` / `pedagogy` | the inserted `syllabuses` row |
| `create_chapter` | `syllabus_id`, `title`, `order_index`, optional `outcomes` / `prerequisites` | the inserted `chapters` row |
| `create_lesson` | `chapter_id`, `title`, `content`, `order_index`, optional `learning_objectives` / `prerequisites` / `key_terms` / `worked_example_seed` / `assessment_idea` / `duration_min` | the inserted `lessons` row |
| `create_activity` | `thread_id`, `title`, `mcqs[]`, optional `short_answers[]` / `worked_example` / `intro` / `lesson_id` / `lesson_title` / `prompt` / `kind` (default `"worksheet"`) | the inserted `activities` row |

All four writes use the service-role client and raise an explicit
`RuntimeError` if the insert returns no rows (so a misconfigured RLS
policy or missing thread fails loudly rather than silently producing a
nonexistent id). None of them are destructive — they only insert.

`create_activity`'s `content` JSONB is a `Worksheet` (see the shared
zod schema in `packages/shared/src/index.ts`). The MCP tool does no
schema validation beyond best-effort coercion of the worked-example
fields — the FE renderer is the source of truth, and the
`activity_maker` subagent's prompt is responsible for producing
schema-valid output.

The deep-agent writer is structured around list-before-create, so
re-dispatching it after a partial run does not produce duplicate rows
even though the MCP tool itself does no upserting (see
`packages/deep-agent/src/prompts/writer.ts`). `create_activity` does
NOT have an idempotency guard — `activity_maker` is dispatched at
most once per supervisor turn, so duplicate rows are not a concern in
the current flow.

## Local dev

```sh
cd apps/mcp-supabase
uv sync
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... uv run mpfe-mcp-supabase
```

This will boot the server in the foreground reading JSON-RPC frames
from stdin. To smoke test, pipe a `tools/list` request:

```sh
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0.0.0"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | SUPABASE_URL=$SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY=$SUPABASE_SERVICE_ROLE_KEY uv run mpfe-mcp-supabase
```

You should see all the read + write tools listed in the response.

## API integration — legacy (activity-tooled, stdio)

The api spawns this server through `@langchain/mcp-adapters`:

```ts
const client = new MultiServerMCPClient({
  "mpfe-supabase": {
    transport: "stdio",
    command: "uv",
    args: ["run", "--directory", absPath("apps/mcp-supabase"), "mpfe-mcp-supabase"],
    env: {
      SUPABASE_URL: process.env.SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    },
  },
});
const tools = await client.getTools();
```

The activity-tooled graph node then binds those tools to its LLM and
runs a small ReAct-style loop. The toolless graph does **not** spawn
this server — its LLM has no tools at all, by design.

## API integration — deep-agent (stdio or streamable-http)

The deep-agent has its own MCP client built on
`@modelcontextprotocol/sdk` directly (kept off `@langchain/mcp-adapters`
because the latter is on the v0.3 langchain family while the deep-agent
package is on v1). See `packages/deep-agent/src/mcp.ts` for the wiring.

In production we run this server as a separate Railway service over
streamable-http (set `MCP_SUPABASE_URL=https://…/mcp/`); locally the
deep-agent service spawns it as a stdio child if no URL is configured.
