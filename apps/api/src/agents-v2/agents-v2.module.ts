import { Module } from "@nestjs/common";
import { DeepAgentService } from "./deepagent.service";

/**
 * AgentsV2Module hosts the deepagents-based supervisor (and, in
 * future iterations, its subagents). Distinct from the legacy
 * `GraphModule` so the two LangChain ecosystems (v0.3 and v1.x)
 * stay physically isolated by package boundary.
 */
@Module({
  providers: [DeepAgentService],
  exports: [DeepAgentService],
})
export class AgentsV2Module {}
