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
  exports: [GraphService],
})
export class GraphModule {}
