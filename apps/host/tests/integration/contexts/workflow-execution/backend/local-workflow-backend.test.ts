import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import {
  LocalWorkflowBackend,
  type LocalWorkflowDefinition,
  type WorkflowBackendReference,
  type WorkflowBackendState,
} from "../../../../../src/contexts/workflow-execution/backend/services/local-workflow-backend";
import { makeLocalWorkflowBackendLayer } from "../../../../../src/contexts/workflow-execution/backend/services/local-workflow-backend-live";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("Local Workflow Backend", () => {
  it.live(
    "reuses a completed Workflow Activity and delivers a due wake-up after Host restart",
    () =>
      Effect.gen(function* () {
        const directory = yield* Effect.promise(() =>
          mkdtemp(join(tmpdir(), "kojo-workflow-backend-")),
        );
        cleanups.push(() => rm(directory, { recursive: true }));
        const databasePath = join(directory, "kojo.sqlite");
        const wakeAfterMillis = 1_000;
        let activityInvocations = 0;
        const definition = makeRecoveryDefinition(() => {
          activityInvocations += 1;
          return "recorded activity result";
        });

        const acceptedAt = Date.now();
        const reference = yield* Effect.scoped(
          Effect.gen(function* () {
            const backend = yield* LocalWorkflowBackend;
            const accepted = yield* backend.submit({
              workflowKey: definition.workflowKey,
              runId: "run:recovery-proof",
              input: { wakeAfterMillis },
            });

            const waiting = yield* awaitState(backend, accepted, "Waiting");
            expect(waiting).toEqual({ _tag: "Waiting" });
            expect(activityInvocations).toBe(1);
            return accepted;
          }).pipe(
            Effect.provide(
              makeLocalWorkflowBackendLayer({ databasePath, definitions: [definition] }),
            ),
          ),
        );
        const hostStoppedAfterMillis = Date.now() - acceptedAt;
        expect(hostStoppedAfterMillis).toBeLessThan(wakeAfterMillis);

        yield* Effect.sleep(`${wakeAfterMillis - hostStoppedAfterMillis + 250} millis`);

        const completed = yield* Effect.scoped(
          Effect.gen(function* () {
            const backend = yield* LocalWorkflowBackend;
            return yield* awaitState(backend, reference, "Completed");
          }).pipe(
            Effect.provide(
              makeLocalWorkflowBackendLayer({ databasePath, definitions: [definition] }),
            ),
          ),
        );

        expect(completed).toEqual({
          _tag: "Completed",
          result: { activityResult: "recorded activity result", wakeUpDelivered: true },
        });
        expect(activityInvocations).toBe(1);
      }),
    20_000,
  );
});

const makeRecoveryDefinition = (
  invokeActivity: () => string,
): LocalWorkflowDefinition<typeof RecoveryInput, typeof RecoveryResult> => ({
  workflowKey: "recovery-proof",
  inputSchema: RecoveryInput,
  successSchema: RecoveryResult,
  execute: (input, operations) =>
    Effect.gen(function* () {
      const activityResult = yield* operations.activity({
        operationKey: "record-result",
        successSchema: Schema.String,
        execute: Effect.sync(invokeActivity),
      });
      yield* operations.sleep({
        operationKey: "wake-after-restart",
        duration: `${input.wakeAfterMillis} millis`,
      });
      return { activityResult, wakeUpDelivered: true };
    }),
});

const RecoveryInput = Schema.Struct({
  wakeAfterMillis: Schema.Number,
});

const RecoveryResult = Schema.Struct({
  activityResult: Schema.String,
  wakeUpDelivered: Schema.Boolean,
});

const awaitState = (
  backend: LocalWorkflowBackend["Service"],
  reference: WorkflowBackendReference,
  tag: WorkflowBackendState["_tag"],
) =>
  backend.observe(reference).pipe(
    Effect.repeat({
      until: (state) => state._tag === tag,
      schedule: Schedule.spaced("25 millis"),
      times: 400,
    }),
  );
