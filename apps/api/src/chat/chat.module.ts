import { Module } from "@nestjs/common";
import { ChatController } from "./chat.controller";
import { GraphModule } from "../graph/graph.module";
import { RunsModule } from "../runs/runs.module";
import { ThreadsModule } from "../threads/threads.module";
import { AgentsV2Module } from "../agents-v2/agents-v2.module";

@Module({
  imports: [GraphModule, RunsModule, ThreadsModule, AgentsV2Module],
  controllers: [ChatController],
})
export class ChatModule {}
