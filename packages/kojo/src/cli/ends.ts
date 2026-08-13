import type { Cause } from "effect";
import { Effect, Option } from "effect";
import type { RunId } from "../contexts/shared/models/RunId.ts";
import type { RunStatus } from "../contexts/workflow/services/run.ts";
import type { Stop } from "../contexts/workflow/services/stopped.ts";
import { describeFailure } from "./failureLine.ts";
import { type RunFailed, type RunUnsettled, runFailed, runUnsettled } from "./RunFailed.ts";

/** The one status a `Stop` does not carry as a field, because a suspension is a gate rather than it. */
export const reachedStatus = (stop: Stop): RunStatus =>
  stop._tag === "suspended" ? "suspended" : stop.status;

/**
 * What a command exits with, after everything it printed on the way.
 *
 * **One exit path for every command that carries a runner, because a run fails the same way whoever
 * was watching it.** `kojo run` starts a run and `kojo gate answer` continues one, and the two of
 * them already share `describeStop` and `reportPhases` — this is the piece that was not shared, and
 * the piece is why answering a gate printed `run failed` with no reason and exited `0` long after
 * starting one had stopped doing that. Two copies of a rule this small do not stay equal, and the
 * inequality is invisible until somebody's script trusts the wrong one.
 *
 * Three answers:
 *
 * - **A run that failed exits non-zero and says why.** The reason is the workflow's own typed error,
 *   read back off the finished run and rendered by {@link describeFailure} — the agent that was
 *   never called, the check that did not hold, the human who said no. A CLI that printed `run failed`
 *   and exited `0` told a person nothing and told a script the opposite of the truth.
 * - **A run that ends suspended exits `0`.** A suspension is a success: the body reached a gate and
 *   let go of everything it held, and the human answers later from anywhere. That is the whole
 *   design, and making it an error would make the design's normal path look like its broken one. It
 *   holds for a *resumed* run in exactly the same way — a run that is answered at one gate and stops
 *   at the next has done nothing wrong, and `kojo gate answer` says so with a `0`.
 * - **A watch that promised to settle and did not is its own answer.** Its own sentence and its own
 *   exit code, because `--wait` promised to block until the run ended — and `0` there would be read
 *   as `succeeded` by the only kind of caller that passes the flag.
 */
export const ends = <R>(options: {
  readonly runId: RunId;
  /** Where the watching ended: the run's own status, with a suspension counted as one. */
  readonly reached: RunStatus;
  /**
   * Why the run failed, if it did — pre-bound to the run, the way `stopped` takes its status.
   *
   * Bound rather than looked up here so this stays one rule over a `RunStatus` and a cause, gradeable
   * without an engine behind it.
   */
  readonly failure: Effect.Effect<Option.Option<Cause.Cause<unknown>>, never, R>;
  /**
   * Did this command promise to watch until the run ended?
   *
   * True for `kojo run --wait` and false everywhere else. `kojo gate answer` watches with a timeout
   * but promises nothing: the run outlives the watching of it, so giving up is not a fault to report.
   */
  readonly promisedToWait: boolean;
}): Effect.Effect<void, RunFailed | RunUnsettled, R> => {
  if (options.reached === "failed") {
    return Effect.flatMap(options.failure, (cause) =>
      runFailed({
        runId: options.runId,
        reason: Option.match(cause, {
          // The engine says `failed` from the exit alone, so a failed run without a cause to read
          // is not a case that should happen — and inventing a reason for it would be worse.
          onNone: () => "the engine recorded no cause against it",
          onSome: describeFailure,
        }),
      }),
    );
  }
  return options.promisedToWait && options.reached !== "succeeded"
    ? runUnsettled({ runId: options.runId, status: options.reached })
    : Effect.void;
};
