/**
 * @mpfe/deep-agent
 *
 * Isolated workspace package that wraps the `deepagents` library.
 *
 * Why isolated? `deepagents@1.9` requires `@langchain/core@^1.1`,
 * `@langchain/langgraph@^1.2`, `langchain@^1.3`, and `zod@^4`. The rest
 * of the api app is on `@langchain/core@0.3`, `@langchain/langgraph@0.2`
 * and `zod@3`. Pinning the v1 family to a separate package lets pnpm
 * hoist two physically distinct copies (under each package's own
 * `node_modules/.pnpm/` directory) so the two ecosystems coexist
 * without forcing a monorepo-wide upgrade. The api app imports the
 * runner via this package's plain TS public API — no v1 langchain
 * types leak across the boundary.
 */
export {
  createDeepAgentRunner,
  type DeepAgentRunner,
  type DeepAgentRunnerOptions,
  type DeepAgentChunk,
  type DeepAgentTextChunk,
  type DeepAgentToolStartChunk,
  type DeepAgentToolEndChunk,
  type DeepAgentTaskStartChunk,
  type DeepAgentTaskEndChunk,
  type DeepAgentFilesUpdateChunk,
  type DeepAgentLlmUsageChunk,
  type DeepAgentDoneChunk,
  type DeepAgentErrorChunk,
} from "./runner.js";
export type { DeepAgentMcpConfig } from "./mcp.js";
