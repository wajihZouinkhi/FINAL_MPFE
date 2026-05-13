import { Module } from "@nestjs/common";
import { RunRecorder } from "./run-recorder.service";
import { EventLog } from "./event-log.service";
import { RunStream } from "./run-stream.service";
import { RunWorker } from "./run-worker.service";
import { RunRegistry } from "./run-registry.service";

/**
 * Resumable-streams infra.
 *
 * Provides:
 *   - RunRecorder: lifecycle of `agent_runs` rows (Postgres).
 *   - RunStream:   live + replay channel for typed slices (Redis Streams).
 *   - EventLog:    legacy shadow log to `agent_events` (Postgres). Kept
 *                  for one release cycle as a fallback while RunStream
 *                  bakes in production; will be deleted once Redis is
 *                  the only source of truth for the live channel.
 *   - RunWorker:   stale-run reaper.
 *   - RunRegistry: in-process map of `runId → AbortController` so the
 *                  Stop button can abort a live run independently of
 *                  the HTTP request that started it. The chat
 *                  controller is the only producer; the cancel
 *                  endpoint is the only external consumer.
 */
@Module({
  providers: [RunRecorder, EventLog, RunStream, RunWorker, RunRegistry],
  exports: [RunRecorder, EventLog, RunStream, RunRegistry],
})
export class RunsModule {}
