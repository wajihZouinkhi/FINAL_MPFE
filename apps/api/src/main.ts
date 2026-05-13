import "reflect-metadata";
import { setMaxListeners } from "node:events";
import { NestFactory } from "@nestjs/core";
import { Logger, ValidationPipe } from "@nestjs/common";
import { AppModule } from "./app.module";
import { AppConfigService } from "./config/app-config.service";

// Bump the default `EventTarget` listener cap process-wide. LangChain JS
// and LangGraph internally register `abort` listeners on per-run config
// signals from every nested node and callback handler. Our graph fans
// out far enough in a single turn (supervisor → search topics × substages
// → summarizer → supervisor → command_seed → command_commit → N
// command_write_one → finalize) that one shared run signal regularly
// crosses the default 10-listener limit and emits
// `MaxListenersExceededWarning: 11 abort listeners added to [AbortSignal]`.
// The listeners ARE released when each run finishes — this isn't a real
// leak, just noisy log output. Lifting the cap silences the warning
// without masking real leaks (50 is well below the millions Node would
// happily handle and any sustained growth past it would still surface).
setMaxListeners(50);

// Silence a noisy `console.warn` from `@langchain/core` `_mergeDicts`
// (messages/base.ts). It fires whenever streaming AIMessageChunks have
// inconsistent shapes for `usage_metadata.completion_tokens` across chunks
// — a quirk of providers like Mistral / NVIDIA NIM. The warning is purely
// cosmetic (the chunk merge still succeeds; just one numeric field is
// dropped) and the production logs were filling with hundreds of lines per
// run. Filter that exact message and forward everything else untouched.
const _origWarn = console.warn.bind(console);
console.warn = (...args: unknown[]) => {
  const first = args[0];
  if (
    typeof first === "string" &&
    first.includes("already exists in this message chunk")
  ) {
    return;
  }
  _origWarn(...args);
};

async function bootstrap() {
  const logger = new Logger("Bootstrap");
  const app = await NestFactory.create(AppModule, { bufferLogs: false });

  const cfg = app.get(AppConfigService);

  app.enableCors({
    origin: cfg.corsOrigin,
    credentials: true,
    // Expose ETag so the FE poll loop can read it on the threads-list
    // response and echo it back as If-None-Match on the next tick. By
    // default browsers hide all but a small CORS-safelisted set of
    // response headers from JS. Audit §3.2.
    exposedHeaders: ["ETag"],
  });
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));

  await app.listen(cfg.port);
  logger.log(`API listening on http://localhost:${cfg.port}`);
}
bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Failed to bootstrap API", err);
  process.exit(1);
});
