import { Clock, Duration, Effect, Option, Stream } from "effect";
import type { WorkflowEngine } from "effect/unstable/workflow";
import { type AskedGate, unsettled, waitingFirst } from "../../gate/models/AskedGate.ts";
import type { GateStoreError } from "../../gate/models/GateStoreError.ts";
import { GateRepository } from "../../gate/ports/GateRepository.ts";
import { parseToken } from "../../gate/services/answerGate.ts";
import type { RunId } from "../../shared/models/RunId.ts";
import type { RunOutcome } from "../../trace/models/RunRecord.ts";
import type { RunLock } from "../../workflow/ports/RunLock.ts";
import { oneRunner } from "../../workflow/services/oneRunner.ts";
import { type Stop, stopped } from "../../workflow/services/stopped.ts";
import type { Driven, Watched } from "../models/Driven.ts";
import type { TriggerError } from "../models/TriggerError.ts";
import type { WatchNotice } from "../models/WatchNotice.ts";
import { Trigger } from "../ports/Trigger.ts";

/**
 * How often the watcher reads the askings back.
 *
 * It is a *reporting* interval, not a control loop: nothing waits on it to make a run move. A run
 * moves when the engine delivers the answer somebody wrote, which happens on the entity poll
 * interval whether anybody is looking or not.
 */
const defaultSweepEvery = Duration.seconds(5);

/**
 * How long one wait on a driven run lasts before it is renewed.
 *
 * A slice rather than a deadline: when it runs out the wait simply starts again, so nothing is
 * abandoned. It exists so a watcher blocked on a run that is going nowhere still returns to its own
 * loop from time to time.
 */
const defaultWatchSlice = Duration.seconds(30);

/** What the trigger is told about the run its event produced. */
const outcomeOf = (stop: Stop): Option.Option<RunOutcome> => {
  switch (stop._tag) {
    case "suspended":
      // A settled answer, not a hang: the run asked a human and let go of everything it held.
      return Option.some("suspended");
    case "finished":
      return stop.status === "succeeded" || stop.status === "failed"
        ? Option.some(stop.status)
        : Option.none();
    case "unsettled":
      return Option.none();
  }
};

/**
 * The factory running unattended: events become runs, and answers written elsewhere are applied.
 *
 * This is the mode a real factory runs in, and it is two loops rather than one because the two
 * things a watcher does have nothing to do with each other:
 *
 * - **Driving.** Each event from the `Trigger` becomes a run, and the watcher stays with that run
 *   until it reaches a human or ends. Two events naming one ticket revision produce one run — the
 *   engine deduplicates on the workflow's idempotency key, and nothing here keeps a second table of
 *   seen events beside it.
 * - **Sweeping.** Every few seconds the askings are read back. That is how a *restarted* watcher
 *   says what it has adopted, how a run that ended while nobody was driving it gets reported, and
 *   how a question past its deadline is surfaced rather than buried (architecture.md §8 edge 8).
 *
 * **Nothing here resumes a run, and that is the point.** A verdict written by another process is a
 * write to the engine's storage; what applies it is a live runner, which is what this process is by
 * virtue of holding the engine. So a watcher restarted after two days picks up every answer written
 * while it was down, replays each body from its recorded activity results, and re-runs no completed
 * phase. The watcher's own job is to be there, and to say what happened.
 *
 * **`poll` is asked one question only — has this run ended.** It cannot tell one suspension from the
 * next: it reads `suspended` on both sides of a resume and answers nothing at all mid-replay. What
 * says *this* execution has come to rest is the durable list of askings, one row per asking, which
 * is what `stopped` watches.
 */
export const watch = (options: {
  /** The workflow the trigger's events start. */
  readonly driving: Driven;
  /**
   * Every workflow this build can resume, including the one being driven.
   *
   * A suspended run adopted from a previous instance may belong to any of them, and the token on
   * its asking says which. A watcher holding fewer workflows than the factory has would record
   * answers it could never apply.
   */
  readonly known: ReadonlyArray<Watched>;
  readonly report: (notice: WatchNotice) => Effect.Effect<void>;
  readonly sweepEvery?: Duration.Input | undefined;
  readonly watchSlice?: Duration.Input | undefined;
}): Effect.Effect<
  void,
  TriggerError | GateStoreError,
  Trigger | GateRepository | RunLock | WorkflowEngine.WorkflowEngine
> =>
  Effect.gen(function* () {
    const trigger = yield* Trigger;
    const repository = yield* GateRepository;
    const sweepEvery = options.sweepEvery ?? defaultSweepEvery;
    const watchSlice = options.watchSlice ?? defaultWatchSlice;

    /**
     * What this process has already said, so neither loop repeats the other.
     *
     * Per process rather than persisted: a restarted watcher **should** announce the askings it has
     * adopted, because nobody was there to hear the first time.
     */
    const said = {
      asking: new Set<string>(),
      overdue: new Set<string>(),
      ended: new Set<string>(),
    };

    const once = (seen: Set<string>, key: string, notice: WatchNotice) =>
      seen.has(key)
        ? Effect.void
        : Effect.andThen(
            Effect.sync(() => seen.add(key)),
            options.report(notice),
          );

    const waiting = (gate: AskedGate) =>
      once(said.asking, gate.request.token, { _tag: "waiting", gate });

    const ended = (runId: RunId, status: "succeeded" | "failed") =>
      once(said.ended, runId, { _tag: "ended", runId, status });

    const say = (runId: RunId, stop: Stop) => {
      switch (stop._tag) {
        case "suspended":
          return waiting(stop.gate);
        case "finished":
          return stop.status === "succeeded" || stop.status === "failed"
            ? ended(runId, stop.status)
            : Effect.void;
        case "unsettled":
          return Effect.void;
      }
    };

    /**
     * Waits for the run this event produced to come to rest, in renewable slices.
     *
     * `known` is every asking that belongs to some *other* run, which is what makes a redelivered
     * event cheap: the asking the run is already waiting on counts as fresh, so the second event is
     * acknowledged with the suspension that already exists rather than waiting for a suspension
     * that has already happened.
     */
    const untilItRests = (runId: RunId, others: ReadonlySet<string>) =>
      Effect.repeat(
        stopped({
          runId,
          status: options.driving.status(runId),
          known: others,
          within: watchSlice,
        }),
        { until: (stop: Stop) => stop._tag !== "unsettled" },
      ).pipe(Effect.tap((stop) => say(runId, stop)));

    const driving = Stream.runForEach(trigger.stream, (event) =>
      Effect.gen(function* () {
        const before = yield* repository.all;
        const runId = yield* options.driving.driven(event);
        yield* options.report({
          _tag: "started",
          runId,
          source: event.source,
          key: event.key,
        });

        const others = new Set(
          before
            .filter((gate) => gate.request.runId !== runId)
            .map((gate) => gate.request.token as string),
        );

        // **Refused, never raced** (edge 9). A run id names a branch and a branch names a worktree,
        // so a second driver is told no and the event is left unacknowledged — the source is still
        // waiting to hear, and whoever holds the run is the one who can say how it went.
        const outcome = yield* oneRunner(runId, untilItRests(runId, others)).pipe(
          Effect.map(outcomeOf),
          Effect.catchTag("RunLocked", (locked) =>
            Effect.as(options.report({ _tag: "refused", locked }), Option.none<RunOutcome>()),
          ),
        );

        if (Option.isSome(outcome)) yield* trigger.ack(event, { runId, outcome: outcome.value });
      }),
    );

    /** Which of the known workflows a token names, when this build has it at all. */
    const workflowOf = (token: string) =>
      parseToken(token).pipe(
        Effect.match({
          onFailure: () => Option.none<Watched>(),
          onSuccess: (parsed) =>
            Option.fromUndefinedOr(
              options.known.find((candidate) => candidate.name === parsed.workflowName),
            ),
        }),
      );

    const sweep = Effect.gen(function* () {
      const asked = yield* repository.all;
      const now = yield* Clock.currentTimeMillis;

      // Worst first, so the run nobody has looked at is the first thing the watcher says rather
      // than the last — the same ordering `kojo gate list` prints, for the same reason.
      for (const gate of waitingFirst(unsettled(asked), now)) {
        yield* waiting(gate);
        if (gate.state(now) === "overdue") {
          yield* once(said.overdue, gate.request.token, { _tag: "overdue", gate });
        }
      }

      // A run that ended while nobody was driving it — because the answer arrived days after the
      // watcher that asked the question had gone. The asking is what remembers the run exists.
      for (const gate of asked) {
        const runId = gate.request.runId;
        if (said.ended.has(runId)) continue;

        const watched = yield* workflowOf(gate.request.token);
        if (Option.isNone(watched)) continue;

        const reported = yield* watched.value.status(runId);
        if (reported === "succeeded" || reported === "failed") yield* ended(runId, reported);
      }
    });

    // The first sweep runs before the first sleep: a restarted watcher says what is waiting at
    // once, rather than leaving a person to wonder for an interval whether it read anything.
    const sweeping = Effect.forever(Effect.andThen(sweep, Effect.sleep(sweepEvery)));

    yield* Effect.all([driving, sweeping], { concurrency: "unbounded", discard: true });
  });
