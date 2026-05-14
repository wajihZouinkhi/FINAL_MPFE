import { Module } from "@nestjs/common";
import { GraphService } from "./graph.service";
import { SupervisorNode } from "./supervisor/supervisor.node";
import { SearchSubgraph } from "./search/search.subgraph";
import { SerperSearchProvider } from "./search/serper.provider";
import { Scraper } from "./search/scraper";
import { CommandSubgraph } from "./command/command.subgraph";
import { ActivityAgentService } from "./activity/activity-agent.service";
import { McpClientService } from "./activity/mcp-client.service";
import { CacheModule } from "../cache/cache.module";
import { SupabaseModule } from "../supabase/supabase.module";

@Module({
  imports: [CacheModule, SupabaseModule],
  providers: [
    GraphService,
    SupervisorNode,
    SearchSubgraph,
    SerperSearchProvider,
    Scraper,
    CommandSubgraph,
    ActivityAgentService,
    McpClientService,
  ],
  // McpClientService is re-exported so ThreadsModule (specifically
  // EntitiesService) can call MCP `embed_text` from the REST
  // create-activity / create-unity paths, keeping the
  // `activity_embeddings` / `unity_embeddings` tables in sync with
  // rows inserted outside the agent flow.
  exports: [GraphService, McpClientService],
})
export class GraphModule {}
