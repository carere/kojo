import type { RunnerPresence } from "../../shared/models/Health.ts";
import type { Asking } from "./Asking.ts";

/**
 * Where one asking stands — console.md §9, and the rule the whole surface turns on.
 *
 * **A recorded answer is never rendered as an applied one.** The Console writes a verdict; a live
 * runner applies it. Those are two events, they can be days apart, and an *approved ✓* that means
 * nothing is the single failure that destroys trust in a control surface (adr/gate/0001). So the
 * six states below are six different words, and nothing collapses them.
 */
export type AnsweringState =
  /** Nobody has answered, and the deadline has not passed. */
  | "waiting"
  /** Nobody has answered, and the deadline has passed. The run is stuck on a stale question. */
  | "overdue"
  /** The verdict is written down and a runner is alive. Normal, and it can last ten seconds. */
  | "applying"
  /** The verdict is written down and nothing is running. It applies when a runner next starts. */
  | "idle"
  /** The run settled the asking without an answer: the deadline won, and it took its branch. */
  | "expired"
  /** The Run ended before a Runner could apply the Recorded Verdict. */
  | "unable"
  /** The run woke up and settled the asking **with an answer**. The only state that may say so. */
  | "applied";

/**
 * **What makes `applied` provable rather than assumed.**
 *
 * A settled `GateRecord` is written by the *run itself*, in the activity that follows the
 * suspension — `phase/gate.ts` records `settled(request, settlement)` immediately after the durable
 * deferred resolves. So a record keyed by this asking is proof the run picked the answer up and
 * carried on. Its absence is proof it has not.
 *
 * Nothing weaker will do. A successful `POST` proves the verdict was written and nothing else; a run
 * whose outcome left `suspended` may have suspended again on a second gate. Only the record is about
 * *this* asking.
 *
 * **And the record alone is not enough either, which is why `outcome` is carried.** `phase/gate.ts`
 * writes the same activity for both settlements — `DurableDeferred.raceAll` returns a verdict *or*
 * the word `expired`, and either way `settled(request, settlement)` is recorded. So a record whose
 * outcome is `expired` proves the run moved on **without** a human decision. Reading its presence as
 * *applied* would put "a runner picked the answer up" in front of a person over a question nobody
 * ever answered, which is the same lie as the one this module exists to prevent, pointed the other
 * way.
 */
export interface SettledAsking {
  readonly asking: string;
  /** How the run settled it. Only `answered` may ever be drawn as *applied*. */
  readonly outcome: "answered" | "expired";
}

/** The run's own record of this asking, if it has settled it at all. */
const settlementOf = (
  asking: Asking,
  settled: ReadonlyArray<SettledAsking>,
): SettledAsking | undefined => settled.find((record) => record.asking === asking.request.asking);

/**
 * Has the run settled this asking **with an answer**? The one fact that may be drawn as *applied*.
 *
 * Not exported, and that is the point: there is one place in the Console where the word *applied* is
 * decided, and it is {@link answeringState} three lines below. A component that could ask this
 * question directly could draw a tick without going through the five other states it has to rule out
 * first, which is how a control surface ends up claiming a run resumed when it did not.
 */
const isApplied = (asking: Asking, settled: ReadonlyArray<SettledAsking>): boolean =>
  asking.daemonState === "applied" || settlementOf(asking, settled)?.outcome === "answered";

/**
 * Has the run settled this asking at all, either way?
 *
 * The question the card asks before it decides whether anything is still pending. An expired asking
 * is finished — nothing will apply an answer to it, so there is nothing to poll a runner about.
 */
export const isSettled = (asking: Asking, settled: ReadonlyArray<SettledAsking>): boolean =>
  asking.daemonState === "applied" ||
  asking.daemonState === "expired" ||
  settlementOf(asking, settled) !== undefined;

/**
 * A verdict written down that nothing has acted on yet.
 *
 * The state that must never be hidden. It is what keeps the gate card on screen after a click, what
 * makes the Console poll for a runner, and what a run reaching a terminal outcome does not excuse:
 * an answer nobody applied is still an answer nobody applied.
 *
 * It turns on {@link isSettled} rather than {@link isApplied}, because a verdict that arrived after
 * the deadline is not awaiting anything — the run has already taken its expiry branch, and a card
 * kept on screen forever over it would be waiting for something that can never happen.
 */
export const awaitingApply = (asking: Asking, settled: ReadonlyArray<SettledAsking>): boolean =>
  asking.verdict !== undefined && !isSettled(asking, settled);

/**
 * Which of the six states an asking is in.
 *
 * The order of the questions is the order of certainty. A settled record outranks everything,
 * because it is the run's own account of having moved — and *how* it settled is asked in the same
 * breath, because a record is written for an expiry exactly as it is for an answer. A verdict
 * without a record is recorded and not applied, and which of the two recorded states it is turns on
 * one thing only — whether anybody is alive to apply it. Only then is the deadline worth reading,
 * because a gate the run has already settled cannot go overdue.
 */
export const answeringState = (options: {
  readonly asking: Asking;
  /** Every settled asking of this run, from the run document. */
  readonly settled: ReadonlyArray<SettledAsking>;
  /**
   * Whether anybody is registered to apply an answer, or `undefined` while that is not yet known.
   *
   * Unknown is treated as *nothing is running*, and the asymmetry is deliberate: the two errors are
   * not equal. Guessing `live` would put *applying…* on screen over a factory with nothing running,
   * which is the lie this module exists to prevent; guessing `none` understates and tells somebody
   * to start a watcher that is already up, which the next poll corrects within a second.
   */
  readonly runner: RunnerPresence | undefined;
  readonly now: number;
}): AnsweringState => {
  if (options.asking.terminalInability !== undefined) return "unable";
  if (isSettled(options.asking, options.settled)) {
    return isApplied(options.asking, options.settled) ? "applied" : "expired";
  }
  if (options.asking.verdict !== undefined) {
    return options.runner === "live" ? "applying" : "idle";
  }
  return options.now > options.asking.request.deadlineAt ? "overdue" : "waiting";
};

/**
 * Is this question still open to an answer?
 *
 * The two states with an answer still to give. Everything else — a verdict already written, a run
 * that has already settled the asking either way — is a question a second click could only refuse.
 */
export const answerable = (state: AnsweringState): boolean =>
  state === "waiting" || state === "overdue";

/** Has somebody answered, whether or not anything has acted on it? */
export const isRecorded = (state: AnsweringState): boolean =>
  state === "applying" || state === "idle" || state === "applied" || state === "unable";

/**
 * The sentence each state puts in front of a person.
 *
 * Written out here rather than in a component because it is the deliverable: these six strings are
 * what the ADR is about, and a change to one of them is a change to what the Console claims.
 */
export const answeringHeadline: Record<AnsweringState, string> = {
  waiting: "Waiting on a human",
  overdue: "Overdue — nobody answered in time",
  applying: "Recorded — applying…",
  applied: "Applied — the run resumed",
  expired: "Expired — the run moved on without an answer",
  idle: "Recorded — nothing is running",
  unable: "Recorded — the run cannot apply it",
};

/** The second line: what that means, and what to do about it. */
export const answeringDetail: Record<AnsweringState, string> = {
  waiting: "This run has stopped and holds nothing. It moves the moment somebody answers.",
  overdue:
    "The deadline has passed. The run takes its expiry branch when a runner next reaches it, and an answer given now may arrive too late.",
  applying:
    "The verdict is written down and a runner is alive. It picks up an answer written by another process on its own poll, so around ten seconds here is ordinary rather than a failure.",
  applied: "A runner picked the answer up and the run settled this asking.",
  expired:
    "Nobody answered before the deadline, and the run has settled this asking on its expiry branch. There is nothing left to decide here; what it cost is the wait above.",
  idle: "The verdict is written down. The Daemon will schedule its application when the Run can continue.",
  unable:
    "The verdict remains in the durable record, but the run failed or was cancelled before a Runner could apply it.",
};
