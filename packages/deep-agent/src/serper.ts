/**
 * Web-search tools for the deep-agent's pedagogy_planner subagent.
 *
 * Two `langchain.tool()` instances:
 *   - `web_search(query, num?)`: Serper.dev results (organic only).
 *   - `web_fetch(url)`: best-effort HTML → readable text extraction.
 *
 * Both are direct ports of the legacy `apps/api/src/graph/search/`
 * implementations. We don't import them across the v0.3/v1 langchain
 * boundary; reimplementing here is ~80 lines of plain `fetch` + cheerio.
 *
 * Both tools return a JSON string the LLM can parse / quote in its
 * VFS notes. They never throw on transient failures — instead they
 * return `{"results": []}` / `{"text": ""}` so the planner subagent
 * can decide whether to retry, try a different query, or proceed
 * without the source.
 */
import { tool } from "langchain";
import { z } from "zod";
import * as cheerio from "cheerio";
import type { DeepAgentTool } from "./mcp.js";

export interface SerperConfig {
  /** API key for serper.dev. Without it, `web_search` falls back to
   *  Tavily (if `tavilyApiKey` is set) or is omitted entirely. */
  apiKey?: string;
  /** API key for tavily.com. When set, takes precedence over
   *  `apiKey` (Serper). Without either, `web_search` is omitted. */
  tavilyApiKey?: string;
}

interface SerperOrganic {
  title?: string;
  link?: string;
  snippet?: string;
}

const SERPER_ENDPOINT = "https://google.serper.dev/search";
const TAVILY_ENDPOINT = "https://api.tavily.com/search";
const FETCH_TIMEOUT_MS = 12_000;
const SEARCH_TIMEOUT_MS = 15_000;
const FETCH_MAX_BYTES = 200_000;
const FETCH_MAX_CHARS = 8_000;

/**
 * Build the search-tool pair for the pedagogy_planner. Returns
 * `[]` when no API key is supplied — callers should treat this as
 * "planner runs LLM-only" and adjust the prompt accordingly.
 */
export function buildSearchTools(config: SerperConfig): DeepAgentTool[] {
  const tavilyKey = config.tavilyApiKey;
  const serperKey = config.apiKey;
  if (!tavilyKey && !serperKey) return [];

  const webSearch = tool(
    async ({ query, num }: { query: string; num?: number }) => {
      const limit = Math.max(1, Math.min(num ?? 5, 10));
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        SEARCH_TIMEOUT_MS,
      );
      try {
        if (tavilyKey) {
          const res = await fetch(TAVILY_ENDPOINT, {
            method: "POST",
            signal: controller.signal,
            headers: {
              Authorization: `Bearer ${tavilyKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              query,
              max_results: limit,
              search_depth: "basic",
            }),
          });
          if (!res.ok) {
            return JSON.stringify({
              results: [],
              error: `tavily ${res.status}`,
            });
          }
          const data = (await res.json()) as {
            results?: { title?: string; url?: string; content?: string }[];
          };
          const results = (data.results ?? []).slice(0, limit).map((r) => ({
            title: r.title ?? "",
            link: r.url ?? "",
            snippet: r.content ?? "",
          }));
          return JSON.stringify({ results });
        }
        const res = await fetch(SERPER_ENDPOINT, {
          method: "POST",
          signal: controller.signal,
          headers: {
            "X-API-KEY": serperKey as string,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ q: query, num: limit }),
        });
        if (!res.ok) {
          return JSON.stringify({
            results: [],
            error: `serper.dev ${res.status}`,
          });
        }
        const data = (await res.json()) as { organic?: SerperOrganic[] };
        const results = (data.organic ?? []).slice(0, limit).map((r) => ({
          title: r.title ?? "",
          link: r.link ?? "",
          snippet: r.snippet ?? "",
        }));
        return JSON.stringify({ results });
      } catch (err) {
        return JSON.stringify({
          results: [],
          error: (err as Error).message,
        });
      } finally {
        clearTimeout(timeout);
      }
    },
    {
      name: "web_search",
      description:
        "Search the web for grounding sources before drafting the " +
        "pedagogy plan. Returns the top organic results as " +
        "`{results: [{title, link, snippet}]}`. Backed by Tavily when " +
        "`TAVILY_API_KEY` is set, else serper.dev. " +
        "Use specific, scholarly queries (course-level keyword + " +
        '"syllabus" / "learning outcomes" / "Bloom"). Limit to 5 ' +
        "queries per planning run to keep the loop bounded.",
      schema: z.object({
        query: z
          .string()
          .min(1)
          .describe("The search query — be specific and scholarly."),
        num: z
          .number()
          .int()
          .min(1)
          .max(10)
          .optional()
          .describe("How many results to return (default 5, max 10)."),
      }),
    },
  );

  const webFetch = tool(
    async ({ url }: { url: string }) => {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        FETCH_TIMEOUT_MS,
      );
      try {
        const res = await fetch(url, {
          signal: controller.signal,
          redirect: "follow",
          headers: {
            "User-Agent":
              "Mozilla/5.0 (compatible; FINAL-MPFE-Bot/0.1; " +
              "+https://github.com/hamdisoudani/FINAL_MPFE)",
            Accept: "text/html,application/xhtml+xml",
          },
        });
        if (!res.ok) {
          return JSON.stringify({
            text: "",
            error: `HTTP ${res.status}`,
          });
        }
        const ctype = res.headers.get("content-type") ?? "";
        if (
          !ctype.includes("text/html") &&
          !ctype.includes("application/xhtml")
        ) {
          return JSON.stringify({
            text: "",
            error: `unsupported content-type: ${ctype}`,
          });
        }
        const buf = await res.arrayBuffer();
        const sliced =
          buf.byteLength > FETCH_MAX_BYTES
            ? buf.slice(0, FETCH_MAX_BYTES)
            : buf;
        const html = new TextDecoder("utf-8", { fatal: false }).decode(sliced);
        const text = extractReadable(html).slice(0, FETCH_MAX_CHARS);
        return JSON.stringify({ text });
      } catch (err) {
        return JSON.stringify({
          text: "",
          error: (err as Error).message,
        });
      } finally {
        clearTimeout(timeout);
      }
    },
    {
      name: "web_fetch",
      description:
        "Fetch a URL (returned by `web_search`) and extract its " +
        "readable text. Useful for skimming a course-page / Wikipedia " +
        "article before structuring the syllabus. Truncated to ~8k " +
        "characters; binaries and non-HTML are rejected. Returns " +
        '`{text}` on success or `{text: "", error}` on failure.',
      schema: z.object({
        url: z.string().url().describe("Absolute http(s) URL to fetch."),
      }),
    },
  );

  // `as unknown as DeepAgentTool[]` — langchain v1's `tool()` factory
  // returns a `DynamicStructuredTool<ZodObject<...>, ...>` with the
  // exact schema generic baked in, but our shared `DeepAgentTool` type
  // is the more permissive `ReturnType<typeof tool>` (because the MCP
  // wrapper's schema type is dynamic at run time). The two are
  // structurally identical at runtime; the cast is purely a TS
  // boundary fix and is consistent with how the MCP module returns
  // `DeepAgentTool[]`.
  return [webSearch, webFetch] as unknown as DeepAgentTool[];
}

function extractReadable(html: string): string {
  const $ = cheerio.load(html);
  $("script, style, noscript, iframe, nav, footer, header, form").remove();
  const main = $("article").text() || $("main").text() || $("body").text();
  return main
    .replace(/[^\S\n]+/g, " ")
    .replace(/[ ]*\n[ ]*/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}
