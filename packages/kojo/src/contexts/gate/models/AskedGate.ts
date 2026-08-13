import { Schema } from "effect";
import { GateRequest } from "./GateRequest.ts";
import { Verdict } from "./Verdict.ts";

/**
 * Where one asking stands, from outside the run.
 *
 * `recorded` is deliberately not called *applied*. An answer that is written down is real and will
 * apply, but the run has not moved until a live runner picks it up — and a surface that shows the
 * two as one thing is lying. See adr/gate/0001.
 */
export const AskedGateState = Schema.Literals([
  /** Nobody has answered, and the deadline has not passed. */
  "waiting",
  /** Nobody has answered, and the deadline has passed — but an answer may still land. */
  "overdue",
  /** A verdict is written down against this asking. Recorded, not applied. */
  "recorded",
  /**
   * The run settled this asking without an answer: the deadline won the race, and the run took its
   * expiry branch. Distinct from `overdue`, and the distinction is the queue's whole reason to carry
   * it — *overdue* means an answer may still land, *expired* means it cannot.
   */
  "expired",
]);
export type AskedGateState = typeof AskedGateState.Type;

/**
 * One asking of one gate, as a surface that never ran the workflow sees it.
 *
 * The request half is written when the human is asked, from inside the request activity — so a run
 * that suspends and replays leaves one row per *asking*, not one per replay. The verdict half is
 * written by whoever answered, in whatever process that was.
 *
 * This is not `GateRecord`. That record is the trace's, written once when an asking **settles**, and
 * a gate still waiting has no settlement to write. This one exists precisely for the interval
 * between the two, which is the interval a human lives in.
 */
export class AskedGate extends Schema.Class<AskedGate>("AskedGate")({
  request: GateRequest,
  /** The verdict written against this asking, if one was. */
  verdict: Schema.optionalKey(Verdict),
  /**
   * When the run settled this asking by expiry, if it did. Written by the run itself, in the same
   * activity that records the settled `GateRecord`, so its presence proves nobody can answer any
   * more — the run has already taken its expiry branch.
   */
  expiredAt: Schema.optionalKey(Schema.Finite),
}) {
  /**
   * How long the question was with a human: request to answer, request to expiry, or request to now.
   *
   * This is the human latency the factory lives or dies by, readable *while* the wait is happening
   * rather than only after it ends. An expired asking stops accruing at its expiry — the question
   * left everybody's desk there, and a wait that kept growing would overstate what it cost.
   */
  waitedMillis(now: number): number {
    return (this.verdict?.answeredAt ?? this.expiredAt ?? now) - this.request.requestedAt;
  }

  /** Time left before the deadline. Negative once it has passed. */
  remainingMillis(now: number): number {
    return this.request.deadlineAt - now;
  }

  state(now: number): AskedGateState {
    // The run's own settlement outranks a verdict: a verdict recorded after the deadline won the
    // race is one the run will never apply, and calling it `recorded` would promise otherwise.
    if (this.expiredAt !== undefined) return "expired";
    if (this.verdict !== undefined) return "recorded";
    return now > this.request.deadlineAt ? "overdue" : "waiting";
  }
}

/**
 * What waits on a human, worst first.
 *
 * Overdue askings sort above waiting ones and longer waits above shorter ones, because the whole
 * reason to print this list is to find the run nobody has looked at. A list ordered by when the
 * question was asked buries the one that has been ignored the longest under everything asked since.
 */
export const waitingFirst = (
  gates: ReadonlyArray<AskedGate>,
  now: number,
): ReadonlyArray<AskedGate> =>
  [...gates].sort((left, right) => {
    const rank = (gate: AskedGate) => (gate.state(now) === "overdue" ? 0 : 1);
    const byState = rank(left) - rank(right);
    return byState === 0 ? right.waitedMillis(now) - left.waitedMillis(now) : byState;
  });

/**
 * The askings still on a human's desk — waiting or overdue, never the ones already settled.
 *
 * Settled covers both ways an asking ends: **answered**, and **expired**. An expired asking has no
 * verdict, and before the settlement was written down it sat here forever, *overdue by* a number
 * that grew without bound — a queue that lists work nobody can do is a queue people stop reading.
 */
export const unsettled = (gates: ReadonlyArray<AskedGate>): ReadonlyArray<AskedGate> =>
  gates.filter((gate) => gate.verdict === undefined && gate.expiredAt === undefined);
