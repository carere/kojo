import type { Duration } from "effect";
import { Effect } from "effect";
import { Activity, type WorkflowEngine } from "effect/unstable/workflow";
import type { GateExpired } from "../../gate/models/GateExpired.ts";
import { GateRejected } from "../../gate/models/GateRejected.ts";
import type { GateUnreachable } from "../../gate/models/GateUnreachable.ts";
import type { OnExpiry } from "../../gate/models/OnExpiry.ts";
import type { Verdict } from "../../gate/models/Verdict.ts";
import type { Gate } from "../../gate/ports/Gate.ts";
import type { GateRepository } from "../../gate/ports/GateRepository.ts";
import type { Tracer } from "../../trace/ports/Tracer.ts";
import type { CurrentRun } from "./CurrentRun.ts";
import { gate } from "./phase/gate.ts";

/**
 * What an approving verdict says. Every other choice sends the subject back to be revised.
 *
 * A reviewed loop asks one question — is this good enough to go on with — so its choices are fixed
 * rather than authored. Fixing them is also what makes an unrecognised answer safe: a verdict that
 * says neither of these is not an approval, and the loop revises rather than proceeding on a word
 * nobody declared.
 */
export const approval = "approve";

const choices = [approval, "reject"] as const;

/**
 * A rejection on its way back to the top of the loop, never seen by an author.
 *
 * The loop needs a failure to make `Activity.retry` advance its counter, and that failure must not
 * be confusable with anything the author's own `revise` can raise. A private class is what makes
 * that structural: `revise` cannot construct one, so an error of the author's that happens to be a
 * `GateRejected` — from a gate nested inside the revision — travels straight out instead of being
 * swallowed as this loop's own rejection.
 */
class SentBack {
  readonly _tag = "SentBack";
  constructor(readonly verdict: Verdict) {}
}

/** What an author declares when a decision may have to be asked for more than once. */
export interface ReviewedParams<Subject, E, R> {
  readonly name: string;
  readonly description: string;
  /** Who is asked to decide. Every asking goes to the same person. */
  readonly actor: string;
  /**
   * How many times the human may be asked. Below one is raised to one: a review that asks nobody
   * is not a review, and there would be no verdict to return.
   */
  readonly limit: number;
  /** Applies to each asking on its own, not to the loop as a whole. */
  readonly deadline: Duration.Input;
  readonly onExpiry: OnExpiry;
  /** What is under review. Returned unchanged when the first asking approves. */
  readonly subject: Subject;
  /**
   * What the human sees beside the description, read again on every asking.
   *
   * A function of the subject rather than a fixed value, because the second asking is about the
   * *revised* subject. A context captured once would show the reviewer the branch and the diff they
   * already rejected.
   */
  readonly context?: ((subject: Subject) => Record<string, string>) | undefined;
  /**
   * How the subject is changed before it is shown again. The verdict carries the reviewer's own
   * words, which is what an agent needs to repair the thing that was refused.
   *
   * Not run after the last allowed asking: another turn of an agent produces work no human is going
   * to look at.
   */
  readonly revise: (verdict: Verdict, subject: Subject) => Effect.Effect<Subject, E, R>;
}

/** The description one asking carries: what is being decided, then the state it is decided against. */
const describe = <Subject, E, R>(
  params: ReviewedParams<Subject, E, R>,
  subject: Subject,
): string => {
  const entries = Object.entries(params.context?.(subject) ?? {});
  return entries.length === 0
    ? params.description
    : [params.description, "", ...entries.map(([label, value]) => `${label}: ${value}`)].join("\n");
};

/**
 * Ask a human, revise what they refused, ask again — and suspend on every asking.
 *
 * **This is the one place Kojo takes control flow away from the author**, and the reason is a defect
 * a hand-written loop cannot avoid. A `DurableDeferred` is keyed `executionId/name` and
 * `deferredDone` refuses to overwrite, so a loop that asks one gate under one name reads the *first*
 * verdict back instantly, forever: five rounds in milliseconds, one human, and a run that believes
 * it was reviewed five times. The design record shipped that bug in its own example, and the test
 * beside this file still runs it.
 *
 * The fix is not a counter the author threads through. `Activity.CurrentAttempt` is the only counter
 * the engine itself maintains, it advances under `Activity.retry` and nothing else, and the gate
 * already takes its per-asking deferred name from it. So the loop is a retry: each rejection is a
 * failure, each retry is the next asking, and the naming follows for free.
 *
 * The same counter pays a second time. Activity results are keyed `executionId/name/attempt`, so the
 * revision phase inside the loop gets its own slot on every round — it genuinely re-runs instead of
 * replaying the first revision — without the author having to name it `revise_1`, `revise_2`.
 *
 * **The bound is spent as rejections, and running out is a typed failure.** `GateRejected` carries
 * the last reviewer's own words, for the same reason the correction loop fails with the refusal that
 * ended it rather than a wrapper: a run that was never approved failed because a person said no, and
 * how many times they said it is a question for the trace, which holds one gate record per asking.
 */
export const reviewed = <Subject, E = never, R = never>(
  params: ReviewedParams<Subject, E, R>,
): Effect.Effect<
  Subject,
  E | GateRejected | GateExpired | GateUnreachable,
  | R
  | Gate
  | GateRepository
  | Tracer
  | CurrentRun
  | WorkflowEngine.WorkflowEngine
  | WorkflowEngine.WorkflowInstance
> =>
  // The subject changes from round to round, so it is state — and state that outlives one evaluation
  // is state a second `yield*` of the same value would inherit. Suspending gives each evaluation its
  // own, which is also what makes a replay start from the subject the author passed.
  Effect.suspend(() => {
    const limit = Math.max(params.limit, 1);
    let subject = params.subject;

    const round = Effect.gen(function* () {
      const asking = yield* Activity.CurrentAttempt;

      // No `asking` is passed. The gate defaults to the engine's counter, which is the whole point:
      // an author-threaded number is a number an author can get wrong.
      const verdict = yield* gate({
        name: params.name,
        description: describe(params, subject),
        actor: params.actor,
        choices,
        deadline: params.deadline,
        onExpiry: params.onExpiry,
      });

      if (verdict.choice === approval) return subject;

      if (asking < limit) subject = yield* params.revise(verdict, subject);

      return yield* Effect.fail(new SentBack(verdict));
    });

    /**
     * The bound is spent: the loop's own rejection becomes the author's.
     *
     * Written as one handler over the whole channel rather than a tag match, because `SentBack` is
     * private and an author's `E` is not: a tag match would have to prove, in the type system, that
     * `E` cannot contain this class — which is exactly what being unable to name it already proves.
     */
    const surface = (
      error: E | GateExpired | GateUnreachable | SentBack,
    ): Effect.Effect<never, E | GateRejected | GateExpired | GateUnreachable> =>
      error instanceof SentBack
        ? Effect.fail(
            new GateRejected({
              gate: params.name,
              actor: params.actor,
              reason: error.verdict.reason,
            }),
          )
        : Effect.fail(error);

    return Activity.retry(round, {
      // `times` counts retries, and the first asking is not one of them.
      times: limit - 1,
      // Only a rejection of *this* gate is retried. Everything the revision raises keeps its own
      // meaning and its own place in the error channel.
      while: (error) => error instanceof SentBack,
    }).pipe(Effect.catch(surface));
  });
