import type { ProjectSnapshot } from "@kojo/control";
import { Deferred, Effect } from "effect";

export interface RunWorkInterrupter {
  readonly interrupt: (
    project: ProjectSnapshot,
    runId: string,
  ) => Effect.Effect<
    | { readonly _tag: "interrupted" }
    | { readonly _tag: "needs-attention"; readonly message: string }
  >;
  readonly interruptible: <Success, Failure, Requirements>(
    project: ProjectSnapshot,
    runId: string,
    external: Effect.Effect<Success, Failure, Requirements>,
  ) => Effect.Effect<Success, Failure, Requirements>;
}

interface ActiveWork {
  readonly completed: Deferred.Deferred<void>;
  readonly signal: Deferred.Deferred<void>;
}

const key = (project: ProjectSnapshot, runId: string) => `${project.path}:${runId}`;

/**
 * Coordinates cleanup for external work owned by a Workflow Activity. A stop
 * signal finishes the wrapper with a terminal defect instead of an Effect
 * interruption, because Effect Workflow retries interrupted Activities.
 */
export const makeRunWorkInterrupter = (): RunWorkInterrupter => {
  const active = new Map<string, Set<ActiveWork>>();

  return {
    interrupt: (project, runId) =>
      Effect.gen(function* () {
        const work = [...(active.get(key(project, runId)) ?? [])];
        for (const entry of work) yield* Deferred.succeed(entry.signal, undefined);

        return yield* Effect.forEach(work, (entry) => Deferred.await(entry.completed)).pipe(
          Effect.timeout("5 seconds"),
          Effect.as({ _tag: "interrupted" } as const),
          Effect.catchCause((cause) =>
            Effect.succeed({
              _tag: "needs-attention" as const,
              message: `Timed out waiting for active work cleanup: ${cause.toString()}`,
            }),
          ),
        );
      }),
    interruptible: (project, runId, external) =>
      Effect.gen(function* () {
        const signal = yield* Deferred.make<void>();
        const completed = yield* Deferred.make<void>();
        const runKey = key(project, runId);
        const work = { completed, signal };
        yield* Effect.sync(() => {
          const entries = active.get(runKey) ?? new Set<ActiveWork>();
          entries.add(work);
          active.set(runKey, entries);
        });
        return yield* Effect.raceFirst(
          external,
          Deferred.await(signal).pipe(
            Effect.andThen(Effect.die("Workflow Run stop interrupted external work.")),
          ),
        ).pipe(
          Effect.ensuring(
            Deferred.succeed(completed, undefined).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  const entries = active.get(runKey);
                  if (entries === undefined) return;
                  entries.delete(work);
                  if (entries.size === 0) active.delete(runKey);
                }),
              ),
            ),
          ),
        );
      }),
  };
};
