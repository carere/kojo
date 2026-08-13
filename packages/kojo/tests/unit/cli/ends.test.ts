import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Option, Result, Runtime } from "effect";
import type { DurableDeferred } from "effect/unstable/workflow";
import { ends, reachedStatus } from "../../../src/cli/ends.ts";
import type { RunFailed, RunUnsettled } from "../../../src/cli/RunFailed.ts";
import { AskedGate } from "../../../src/contexts/gate/models/AskedGate.ts";
import { GateRejected } from "../../../src/contexts/gate/models/GateRejected.ts";
import { GateRequest } from "../../../src/contexts/gate/models/GateRequest.ts";
import type { RunId } from "../../../src/contexts/shared/models/RunId.ts";
import type { RunStatus } from "../../../src/contexts/workflow/services/run.ts";

const runId = "run-41" as RunId;

/** The rejection a human writes at a gate, which is what a resumed run most often fails with. */
const rejected = new GateRejected({ gate: "approve", actor: "engineer", reason: "not yet" });

/** How the command asks a run why it failed. Answered here, so the rule is graded without an engine. */
const because = (cause: Cause.Cause<unknown>) => Effect.succeed(Option.some(cause));
const nothing = Effect.succeed(Option.none<Cause.Cause<unknown>>());

const ending = (options: {
  readonly reached: RunStatus;
  readonly failure?: Effect.Effect<Option.Option<Cause.Cause<unknown>>>;
  readonly promisedToWait?: boolean;
}) =>
  Effect.result(
    ends({
      runId,
      reached: options.reached,
      failure: options.failure ?? nothing,
      promisedToWait: options.promisedToWait ?? false,
    }),
  );

type Ended = Result.Result<void, RunFailed | RunUnsettled>;

const failureOf = (outcome: Ended): RunFailed | RunUnsettled | undefined =>
  Result.isFailure(outcome) ? outcome.failure : undefined;

/**
 * The exit code a failure carries, read off the error itself.
 *
 * The number is what `runMain` turns into the process's status, so this is the property rather than
 * a proxy for it — and the integration tier grades the same number out of a real spawn.
 */
const exitCode = (outcome: Ended): number | undefined =>
  failureOf(outcome)?.[Runtime.errorExitCode];

/** What the reader is told, when what ended the run was the run failing. */
const whyFailed = (outcome: Ended): string | undefined => {
  const failure = failureOf(outcome);
  return failure?._tag === "RunFailed" ? failure.reason : undefined;
};

/**
 * The one exit path both `kojo run` and `kojo gate answer` end on.
 *
 * It lives in one module because the two commands were allowed to disagree about it once already:
 * `run` learned to report a failed run and `gate answer` did not, so answering a gate that ended a
 * run printed nothing about why and exited `0`. Everything below is asserted on the *code*, because
 * the exit code is the half of this that no amount of reading stdout can see.
 */
describe("how a command ends after a run stopped", () => {
  it.effect("fails with the run's own typed error when the run failed", () =>
    Effect.gen(function* () {
      const outcome = yield* ending({ reached: "failed", failure: because(Cause.fail(rejected)) });

      expect(failureOf(outcome)?._tag).toBe("RunFailed");
      // The words are the error's own fields, so the reader learns which gate and whose words
      // ended the run rather than that "the run failed".
      expect(whyFailed(outcome)).toContain("GateRejected");
      expect(whyFailed(outcome)).toContain("gate: approve");
      expect(whyFailed(outcome)).toContain("reason: not yet");
      expect(exitCode(outcome)).toBe(1);
    }),
  );

  it.effect("says so rather than inventing a reason when the run recorded no cause", () =>
    Effect.gen(function* () {
      const outcome = yield* ending({ reached: "failed", failure: nothing });

      expect(whyFailed(outcome)).toContain("no cause");
      expect(exitCode(outcome)).toBe(1);
    }),
  );

  /**
   * **A suspended run is a success, and this is where a resume could have got it wrong.**
   *
   * A run answered at one gate and stopped at the next has done nothing wrong: it let go of
   * everything it held and waits for the next human. A command that exited non-zero here would
   * report the design's normal path as its broken one.
   */
  it.effect("succeeds when the run suspended, and when it succeeded", () =>
    Effect.gen(function* () {
      expect(Result.isSuccess(yield* ending({ reached: "suspended" }))).toBe(true);
      expect(Result.isSuccess(yield* ending({ reached: "succeeded" }))).toBe(true);
      // Still going, and nobody promised to see it end. `kojo gate answer` ends here.
      expect(Result.isSuccess(yield* ending({ reached: "running" }))).toBe(true);
    }),
  );

  it.effect("keeps a watch that gave up apart from a run that failed", () =>
    Effect.gen(function* () {
      const outcome = yield* ending({ reached: "suspended", promisedToWait: true });

      expect(failureOf(outcome)?._tag).toBe("RunUnsettled");
      // `EX_TEMPFAIL`, never `1`: nothing is wrong with the run, and a script must be able to tell
      // "ask again later" from "this run is over and it ended badly".
      expect(exitCode(outcome)).toBe(75);

      // The promise was to see the run *end*, and a run that ended well kept it.
      expect(Result.isSuccess(yield* ending({ reached: "succeeded", promisedToWait: true }))).toBe(
        true,
      );
    }),
  );
});

describe("the status a stop reached", () => {
  it("calls a suspension suspended, and reads the rest off the stop", () => {
    const asked = new AskedGate({
      request: new GateRequest({
        runId,
        gate: "approve",
        asking: "gate/approve/1",
        description: "does this land?",
        actor: "engineer",
        choices: ["approve", "reject"],
        token: "token-41" as DurableDeferred.Token,
        requestedAt: 0,
        deadlineAt: 1,
        onExpiry: "fail",
      }),
    });

    // The one status a `Stop` does not carry as a field. Getting this wrong is how a resumed run
    // that stopped at its next gate would be read as anything but the success it is.
    expect(reachedStatus({ _tag: "suspended", gate: asked })).toBe("suspended");
    expect(reachedStatus({ _tag: "finished", status: "failed" })).toBe("failed");
    expect(reachedStatus({ _tag: "unsettled", status: "running" })).toBe("running");
  });
});
