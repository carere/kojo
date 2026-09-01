import type { JsonValue } from "@carere/kojo-runner-contracts/contexts/shared/codecs/json";
import { Context, type Effect } from "effect";

export interface CommittedActivityTiming {
  readonly startedAt: number;
  readonly endedAt: number;
}

/** Project-local IPC port. The Daemon adapter fences every operation with the current Claim. */
export class DaemonExecutionRepository extends Context.Service<
  DaemonExecutionRepository,
  {
    readonly readResult: (
      runId: string,
      revisionId: string,
      phasePath: string,
      attempt: number,
    ) => Effect.Effect<JsonValue | undefined>;
    readonly commitResult: (
      runId: string,
      revisionId: string,
      phasePath: string,
      attempt: number,
      result: JsonValue,
      timing: CommittedActivityTiming,
    ) => Effect.Effect<void>;
    readonly readDeferred: (
      runId: string,
      deferredName: string,
    ) => Effect.Effect<JsonValue | undefined>;
    readonly commitDeferred: (
      runId: string,
      deferredName: string,
      result: JsonValue,
    ) => Effect.Effect<void>;
    readonly scheduleWakeup: (
      runId: string,
      deferredName: string,
      dueAt: number,
    ) => Effect.Effect<void>;
  }
>()("kojo-runtime/workflow/DaemonExecutionRepository") {}
