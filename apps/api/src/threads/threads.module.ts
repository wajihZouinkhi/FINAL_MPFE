import { Module } from "@nestjs/common";
import { ActivitiesController } from "./activities.controller";
import { SyllabusesController } from "./syllabuses.controller";
import { ThreadsController } from "./threads.controller";
import { ThreadsService } from "./threads.service";

@Module({
  controllers: [ThreadsController, SyllabusesController, ActivitiesController],
  providers: [ThreadsService],
  exports: [ThreadsService],
})
export class ThreadsModule {}
