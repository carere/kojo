import { axisDuration, deadlineLabel } from "../../shared/lib/duration.ts";
import { type Asking, waitedMillis } from "./Asking.ts";

/**
 * One line of the queue — console.md §3's *"what waits on a human, and for how long"*.
 *
 * **Every field is already a string, and the clock is an argument.** The same rule the run list
 * follows, for the same reason: a cell renderer that reached for a clock would make a screenshot
 * move, and there is nothing left in this row to compute.
 */
export interface QueueRow {
  readonly state: "unanswered" | "recorded" | "applied" | "expired";
  readonly runId: string;
  readonly gate: string;
  /** The engine's own name for this round of this gate. Carried whole; the route encodes it. */
  readonly asking: string;
  readonly description: string;
  readonly actor: string;
  /**
   * How long this question has been with a human.
   *
   * The number the whole view exists for. Human latency is what a factory lives or dies by, and the
   * only place it can be shortened is while it is still being paid.
   */
  readonly waited: string;
  /** *in 7h 0m*, or *overdue by 2h 0m*. */
  readonly deadline: string;
  /** The deadline has passed and nobody has answered — but an answer may still land. */
  readonly overdue: boolean;
  /**
   * The run settled this asking without an answer: the deadline won, and no answer can reach it any
   * more. Distinct from `overdue`, and the distinction is the queue's whole reason to carry it.
   */
  readonly expired: boolean;
  /** Present once somebody answered. Its presence means *recorded*, never *applied*. */
  readonly answerer?: string;
}

/**
 * What waits on a human, worst first.
 *
 * Overdue askings above waiting ones, and longer waits above shorter ones. The whole reason to print
 * this list is to find the question nobody has looked at, and a list ordered by when each was asked
 * buries the most ignored one under everything asked since.
 */
export const queueRows = (options: {
  readonly askings: ReadonlyArray<Asking>;
  readonly now: number;
}): ReadonlyArray<QueueRow> =>
  [...options.askings]
    .sort((left, right) => {
      const rank = (asking: Asking) =>
        asking.verdict === undefined &&
        asking.expiredAt === undefined &&
        options.now > asking.request.deadlineAt
          ? 0
          : 1;
      const byState = rank(left) - rank(right);
      return byState === 0
        ? waitedMillis(right, options.now) - waitedMillis(left, options.now)
        : byState;
    })
    .map((asking) => ({
      state:
        asking.daemonState ??
        (asking.expiredAt !== undefined
          ? "expired"
          : asking.appliedAt !== undefined
            ? "applied"
            : asking.verdict === undefined
              ? "unanswered"
              : "recorded"),
      runId: asking.request.runId,
      gate: asking.request.gate,
      asking: asking.request.asking,
      description: asking.request.description,
      actor: asking.request.actor,
      waited: axisDuration(waitedMillis(asking, options.now)),
      deadline: deadlineLabel(asking.request.deadlineAt, options.now),
      overdue:
        asking.verdict === undefined &&
        asking.expiredAt === undefined &&
        options.now > asking.request.deadlineAt,
      expired: asking.expiredAt !== undefined,
      ...(asking.verdict === undefined ? {} : { answerer: asking.verdict.answerer }),
    }));

/**
 * The rows still on somebody's desk.
 *
 * A settled asking is no longer waiting on a human, and settled covers both ways an asking ends:
 * **answered**, and **expired**. An expired row listed here would be work nobody can do — the run
 * already took its expiry branch — and a queue that lists work nobody can do is a queue people stop
 * reading.
 */
export const waitingRows = (rows: ReadonlyArray<QueueRow>): ReadonlyArray<QueueRow> =>
  rows.filter((row) => row.answerer === undefined && !row.expired);

/**
 * The rows already settled — answered, or expired.
 *
 * They stay on this page rather than vanishing, and the wording is careful. For an answered row this
 * view cannot know whether a runner applied the verdict — that needs each run's own document, and
 * the queue reads one list across every run — so it says *recorded* and sends the reader to the run,
 * which can prove it. An expired row is the run's own account: the settlement is written by the run
 * itself, so *expired* is a fact here, not a guess. Understating is safe; the one thing forbidden is
 * claiming an answer was applied.
 */
export const settledRows = (rows: ReadonlyArray<QueueRow>): ReadonlyArray<QueueRow> =>
  rows.filter((row) => row.answerer !== undefined || row.expired);
