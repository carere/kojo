import { Console, Effect, Runtime, Schema } from "effect";
import type { RunStatus } from "../contexts/workflow/services/run.ts";

/**
 * The exit code of a run that ended badly. One, the ordinary failure code.
 *
 * Written down rather than left to the default because the two codes below are a pair, and a pair
 * only reads as one if both are in one place.
 */
const failedCode = 1;

/**
 * The exit code of a watch that ran out of patience — `EX_TEMPFAIL` from `sysexits.h`.
 *
 * Its own code, because `--wait` timing out is not the run failing and a script must be able to tell
 * the two apart. `EX_TEMPFAIL` is the one convention that already means exactly this: nothing is
 * wrong, ask again later. The run is durable and is still going.
 */
const unsettledCode = 75;

/**
 * The run this command started reached its terminal `failed` status.
 *
 * **Distinct from `CommandFailed`, and the difference is who is at fault.** `CommandFailed` is the
 * command being unable to do its job — a workflow name nothing answers to, a token from another
 * factory. This one is the command doing its job perfectly and reporting bad news: the run ran, and
 * the workflow's own typed error says why.
 *
 * `errorReported` is `false` for the same reason `CommandFailed` sets it. The runtime's automatic
 * report prints a stack trace of the CLI, and the CLI is not where the failure is — the reason is
 * printed by {@link runFailed}, from the run's own cause, and the exit code still comes from this
 * failure.
 */
export class RunFailed extends Schema.TaggedError<RunFailed>()("RunFailed", {
  runId: Schema.String,
  reason: Schema.String,
}) {
  readonly [Runtime.errorReported] = false;
  readonly [Runtime.errorExitCode] = failedCode;
}

/**
 * `--wait` stopped watching, and the run had not ended.
 *
 * **This is the watcher giving up, never the run failing**, which is the same distinction
 * `Stop.unsettled` makes and the reason this is not a `RunFailed`. The run is durable: it carries on
 * with nobody looking at it, and a gate it is waiting at may be answered days later.
 *
 * It is still non-zero, because `--wait` exists for scripts and its whole promise is *block until
 * this run has ended*. A script that asked for that and got `0` without it would read the exit code
 * as `succeeded`, which is the one answer that is certainly wrong.
 */
export class RunUnsettled extends Schema.TaggedError<RunUnsettled>()("RunUnsettled", {
  runId: Schema.String,
  status: Schema.String,
}) {
  readonly [Runtime.errorReported] = false;
  readonly [Runtime.errorExitCode] = unsettledCode;
}

/**
 * Says why the run failed, on stderr, then fails so the exit code says it too.
 *
 * **stderr, while the phase table goes to stdout**, so a script can pipe the table somewhere and
 * still see the reason — and so that a person who redirects one keeps the other.
 */
export const runFailed = (options: {
  readonly runId: string;
  readonly reason: string;
}): Effect.Effect<never, RunFailed> =>
  Effect.andThen(
    Console.error(`\nrun ${options.runId} failed — ${options.reason}`),
    Effect.fail(new RunFailed(options)),
  );

/** Says which status the watching actually ended on, so nobody reads the silence as success. */
export const runUnsettled = (options: {
  readonly runId: string;
  readonly status: RunStatus;
}): Effect.Effect<never, RunUnsettled> =>
  Effect.andThen(
    Console.error(
      `\n--wait stopped watching run ${options.runId} while it was still ${options.status}. ` +
        "The run carries on without this command; ask again, or answer what it waits on.",
    ),
    Effect.fail(new RunUnsettled(options)),
  );
