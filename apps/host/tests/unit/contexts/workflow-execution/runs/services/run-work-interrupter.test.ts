import { describe, expect, it } from "@effect/vitest";
import { ProjectIdentity } from "@kojo/control";
import { Deferred, Effect, Schema } from "effect";
import { makeRunWorkInterrupter } from "../../../../../../src/contexts/workflow-execution/runs/services/run-work-interrupter";

describe("Run work interrupter", () => {
  it.effect("waits for cleanup of active Activity, Agent, Command, and Sandbox work", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const project = {
          identity: Schema.decodeUnknownSync(ProjectIdentity)(Bun.randomUUIDv7()),
          path: "/tmp/kojo-run-work-interrupter",
        };
        const runId = "run-under-stop";
        const interrupter = makeRunWorkInterrupter();
        const cleaned = new Set<string>();

        for (const kind of ["Activity", "Agent", "Command", "Sandbox"]) {
          const started = yield* Deferred.make<void>();
          yield* Effect.forkScoped(
            interrupter.interruptible(
              project,
              runId,
              Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.ensuring(
                  Effect.sync(() => {
                    cleaned.add(kind);
                  }),
                ),
              ),
            ),
          );
          yield* Deferred.await(started);
        }

        expect(yield* interrupter.interrupt(project, runId)).toEqual({ _tag: "interrupted" });
        expect([...cleaned].sort()).toEqual(["Activity", "Agent", "Command", "Sandbox"]);
      }),
    ),
  );
});
