import { Clock, Duration, Effect } from "effect";
import type { AskedGate } from "../../gate/models/AskedGate.ts";
import { unsettled } from "../../gate/models/AskedGate.ts";
import type { GateStoreError } from "../../gate/models/GateStoreError.ts";
import { GateRepository } from "../../gate/ports/GateRepository.ts";
import type { RunId } from "../../shared/models/RunId.ts";
import type { RunStatus } from "./run.ts";

/**
 * Where one execution of a workflow body came to rest.
 *
 * `unsettled` is not a failure. It says the process gave up watching, which is a statement about
 * the watcher and never about the run: the run is durable and carries on without anybody looking.
 */
export type Stop =
  /** The body reached a gate and let go of everything it held. */
  | { readonly _tag: "suspended"; readonly gate: AskedGate }
  /** The run reached a terminal status. */
  | { readonly _tag: "finished"; readonly status: RunStatus }
  /** Nothing had happened by the time the watcher's patience ran out. */
  | { readonly _tag: "unsettled"; readonly status: RunStatus };

/** How often the two signals below are read. Short, because a person is waiting on the answer. */
const defaultPollEvery = Duration.millis(100);

/**
 * Waits for **this** execution of the body to stop, and says where it stopped.
 *
 * **Not driven by `poll`, and that is measured rather than stylistic.** A run that suspends,
 * resumes and suspends again reads `suspended` on both sides of the resume, and answers nothing at
 * all — which reads as `running` — while the body is mid-replay. Anything that watched only the
 * engine's status would report the *previous* suspension as the new one, instantly, and every line
 * printed after it would describe a run that had not moved.
 *
 * The durable list of askings is the signal that can tell them apart: one row per asking, written
 * from inside the request activity, so it appears exactly once and exactly when the body reaches a
 * gate it has not reached before. `known` is what this process had already seen, so a fresh row is
 * unambiguously this execution's work.
 *
 * The engine is still asked, and asked **first**: a run whose gate expired carries on and may fail
 * with its last asking still sitting unanswered in the list, so a terminal status outranks a row
 * every time.
 */
export const stopped = <R>(options: {
  readonly runId: RunId;
  /** The engine's own answer for this workflow, pre-bound because the definition is generic. */
  readonly status: Effect.Effect<RunStatus, never, R>;
  /** The tokens of askings this process had already seen before it started watching. */
  readonly known: ReadonlySet<string>;
  /** How long to watch. A run outlives the watching of it. */
  readonly within: Duration.Input;
  readonly pollEvery?: Duration.Input | undefined;
}): Effect.Effect<Stop, GateStoreError, GateRepository | R> =>
  Effect.gen(function* () {
    const repository = yield* GateRepository;
    const pollEvery = options.pollEvery ?? defaultPollEvery;
    const giveUpAt =
      (yield* Clock.currentTimeMillis) +
      Duration.toMillis(Duration.fromInputUnsafe(options.within));

    const watch = (): Effect.Effect<Stop, GateStoreError, R> =>
      Effect.gen(function* () {
        const reported = yield* options.status;
        if (reported === "succeeded" || reported === "failed") {
          return { _tag: "finished" as const, status: reported };
        }

        const asked = yield* repository.all;
        const fresh = unsettled(asked).find(
          (gate) => gate.request.runId === options.runId && !options.known.has(gate.request.token),
        );
        if (fresh !== undefined) return { _tag: "suspended" as const, gate: fresh };

        if ((yield* Clock.currentTimeMillis) >= giveUpAt) {
          return { _tag: "unsettled" as const, status: reported };
        }

        yield* Effect.sleep(pollEvery);
        return yield* watch();
      });

    return yield* watch();
  });

/** The tokens of every asking already on file, so a later stop is known to be a new one. */
export const askingsSoFar: Effect.Effect<
  ReadonlySet<string>,
  GateStoreError,
  GateRepository
> = Effect.map(
  Effect.flatMap(GateRepository, (repository) => repository.all),
  (asked) => new Set(asked.map((gate) => gate.request.token as string)),
);
