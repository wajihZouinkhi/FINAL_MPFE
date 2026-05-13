import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { AppConfigModule } from "./config/app-config.module";
import { SupabaseModule } from "./supabase/supabase.module";
import { CacheModule } from "./cache/cache.module";
import { GraphModule } from "./graph/graph.module";
import { ThreadsModule } from "./threads/threads.module";
import { ChatModule } from "./chat/chat.module";
import { RunsModule } from "./runs/runs.module";
import { HealthController } from "./health.controller";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    AppConfigModule,
    SupabaseModule,
    CacheModule,
    GraphModule,
    ThreadsModule,
    RunsModule,
    ChatModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
