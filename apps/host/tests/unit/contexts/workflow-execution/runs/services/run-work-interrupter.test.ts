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

  it.effect("signals every active work item when a Project backend closes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const project = {
          identity: Schema.decodeUnknownSync(ProjectIdentity)(Bun.randomUUIDv7()),
          path: "/tmp/kojo-run-work-interrupter-project",
        };
        const otherProject = { ...project, path: "/tmp/kojo-run-work-interrupter-other" };
        const interrupter = makeRunWorkInterrupter();
        const cleaned: Array<Deferred.Deferred<void>> = [];

        for (const runId of ["first-run", "second-run"]) {
          const started = yield* Deferred.make<void>();
          const completed = yield* Deferred.make<void>();
          yield* Effect.forkScoped(
            interrupter.interruptible(
              project,
              runId,
              Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.ensuring(Deferred.succeed(completed, undefined)),
              ),
            ),
          );
          yield* Deferred.await(started);
          cleaned.push(completed);
        }
        yield* Effect.forkScoped(
          interrupter.interruptible(otherProject, "other-run", Effect.never),
        );

        yield* interrupter.interruptProject(project);
        yield* Effect.forEach(cleaned, Deferred.await, { discard: true });
      }),
    ),
  );
});
