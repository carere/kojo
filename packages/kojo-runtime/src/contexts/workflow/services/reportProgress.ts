import { Clock, Effect, Schema } from "effect";
import { Activity } from "effect/unstable/workflow";
import { makePhaseId } from "../../shared/models/PhaseId.ts";
import { PhaseRecord } from "../../trace/models/PhaseRecord.ts";
import { RunProgress } from "../../trace/models/RunProgress.ts";
import type { WorkItemProgress } from "../../trace/models/WorkItemProgress.ts";
import { Tracer } from "../../trace/ports/Tracer.ts";
import { ActionRecoveryPolicy } from "../models/ActionRecoveryPolicy.ts";
import { CurrentRun } from "./CurrentRun.ts";

/**
 * Retain public work progress with a unique, replay-stable Phase name. Supply increasing revisions
 * per item. This reports authored state; it never schedules work or establishes acceptance.
 * No private payload, credentials, or private reasoning belongs in these public fields.
 */
export const reportProgress = (
  name: string,
  items: ReadonlyArray<WorkItemProgress>,
): Activity.Activity<typeof RunProgress, Schema.Never, CurrentRun | Tracer> =>
  Activity.make({
    name,
    success: RunProgress,
    error: Schema.Never,
    execute: Effect.gen(function* () {
      const run = yield* CurrentRun;
      const tracer = yield* Tracer;
      const attempt = yield* Activity.CurrentAttempt;
      const now = yield* Clock.currentTimeMillis;
      // This records data only. It must not briefly appear as executing work between Trace writes.
      yield* tracer.phase(
        new PhaseRecord({
          runId: run.runId,
          phaseId: makePhaseId(run.runId, name, attempt),
          name,
          description: "__kojo_run_progress__",
          kind: "code",
          outcome: "succeeded",
          attempt,
          startedAt: now,
          endedAt: now,
        }),
      );
      return { _tag: "KojoRunProgress" as const, items };
    }),
  }).annotate(ActionRecoveryPolicy, "safe-repetition");
