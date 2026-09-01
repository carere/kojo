import { type Asking, openGateOf } from "../../gate/models/Asking.ts";
import { deadlineLabel } from "../../shared/lib/duration.ts";
import { type RunLine, type RunStatus, statusOf } from "./RunLine.ts";

/**
 * One row of the run list: the five things console.md §3 puts on the front page.
 *
 * **Every field is already a string by the time it reaches a cell**, and the clock is an argument to
 * the function that built it. That is what keeps `Date.now()` out of the components: a cell renderer
 * has no reason to reach for a clock because there is nothing left in the row to compute.
 */
export interface RunRow {
  readonly runId: string;
  readonly workflow: string;
  readonly status: RunStatus;
  readonly queueReason: string;
  /** The gate this run waits on, or an em dash. Nothing waiting is a fact, not a blank. */
  readonly gate: string;
  /** *in 7h 0m*, *overdue by 2h 0m*, or an em dash when nothing is waiting. */
  readonly deadline: string;
  /** The deadline as an ISO instant, for the cell's tooltip. Absent when nothing is waiting. */
  readonly deadlineAt?: string;
  /** Whether the deadline has passed with nobody having answered. Drawn, not written out twice. */
  readonly overdue: boolean;
}

/** What a column holds when the run is not waiting on anybody. */
const nothing = "—";

/**
 * The rows, newest run first.
 *
 * The order is the server's — `GET /api/runs` answers newest first — and it is preserved rather than
 * re-sorted here, so one rule about what "newest" means lives in one place.
 */
export const runRows = (options: {
  readonly runs: ReadonlyArray<RunLine>;
  readonly askings: ReadonlyArray<Asking>;
  readonly now: number;
}): ReadonlyArray<RunRow> =>
  options.runs.map((line) => {
    const open = openGateOf(options.askings, line.run.runId);
    if (open === undefined) {
      return {
        runId: line.run.runId,
        workflow: line.run.workflow,
        status: statusOf(line),
        queueReason: line.queueReason ?? "—",
        gate: nothing,
        deadline: nothing,
        overdue: false,
      };
    }
    return {
      runId: line.run.runId,
      workflow: line.run.workflow,
      status: statusOf(line),
      queueReason: line.queueReason ?? "—",
      gate: open.request.gate,
      deadline: deadlineLabel(open.request.deadlineAt, options.now),
      deadlineAt: new Date(open.request.deadlineAt).toISOString(),
      overdue: options.now > open.request.deadlineAt,
    };
  });
