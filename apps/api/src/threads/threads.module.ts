import { Module } from "@nestjs/common";
import { AgentsV2Module } from "../agents-v2/agents-v2.module";
import { GraphModule } from "../graph/graph.module";
import { ActivitiesController } from "./activities.controller";
import { EntitiesService } from "./entities.service";
import { ScopedGenerateService } from "./scoped-generate.service";
import { SyllabusesController } from "./syllabuses.controller";
import { ThreadsController } from "./threads.controller";
import { ThreadsService } from "./threads.service";
import { UnitiesController } from "./unities.controller";

@Module({
  // GraphModule re-exports McpClientService so EntitiesService can
  // call the MCP `embed_text` tool to upsert pgvector embeddings
  // when REST handlers insert activities / unities outside the
  // agent flow (parity with the MCP `create_activity` / `create_unity`
  // tools that already write to `activity_embeddings` /
  // `unity_embeddings`).
  imports: [AgentsV2Module, GraphModule],
  controllers: [
    ThreadsController,
    SyllabusesController,
    UnitiesController,
    ActivitiesController,
  ],
  providers: [ThreadsService, EntitiesService, ScopedGenerateService],
  exports: [ThreadsService, EntitiesService],
})
export class ThreadsModule {}
