import { Global, Module } from "@nestjs/common";
import { AppConfigService } from "./app-config.service";
import { LlmConfigService } from "./llm-config.service";

@Global()
@Module({
  providers: [AppConfigService, LlmConfigService],
  exports: [AppConfigService, LlmConfigService],
})
export class AppConfigModule {}
