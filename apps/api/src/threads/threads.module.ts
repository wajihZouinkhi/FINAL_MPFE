import { Module } from "@nestjs/common";
import { AgentsV2Module } from "../agents-v2/agents-v2.module";
import { ActivitiesController } from "./activities.controller";
import { EntitiesService } from "./entities.service";
import { ScopedGenerateService } from "./scoped-generate.service";
import { SyllabusesController } from "./syllabuses.controller";
import { ThreadsController } from "./threads.controller";
import { ThreadsService } from "./threads.service";
import { UnitiesController } from "./unities.controller";

@Module({
  imports: [AgentsV2Module],
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
