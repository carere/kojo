import { type Asking, openGateOf } from "../../gate/models/Asking.ts";
import { deadlineLabel } from "../../shared/lib/duration.ts";
import { type RunLine, type RunStatus, statusOf } from "./RunLine.ts";

/** Build Run list cells with the supplied clock before rendering them. */
export interface RunRow {
  readonly runId: string;
  readonly request: string;
  readonly project: string;
  readonly activity: string;
  readonly updatedAt: string;
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
 * The order is the Daemon's — `GET /api/v1/runs` answers newest first — and it is preserved rather than
 * re-sorted here, so one rule about what "newest" means lives in one place.
 */
export const runRows = (options: {
  readonly runs: ReadonlyArray<RunLine>;
  readonly askings: ReadonlyArray<Asking>;
  readonly now: number;
  readonly projects?: ReadonlyMap<string, string>;
}): ReadonlyArray<RunRow> =>
  options.runs.map((line) => {
    const open = openGateOf(options.askings, line.run.runId);
    const gateTimes = options.askings
      .filter((asking) => asking.request.runId === line.run.runId)
      .flatMap((asking) => [
        asking.request.requestedAt,
        asking.verdict?.answeredAt ?? 0,
        asking.appliedAt ?? 0,
        asking.expiredAt ?? 0,
      ]);
    const common = {
      runId: line.run.runId,
      request: line.run.requestTitle ?? line.run.workflow,
      project: options.projects?.get(line.run.projectId) ?? line.run.projectId,
      activity: line.activity ?? statusOf(line),
      updatedAt: new Date(
        Math.max(
          Date.parse(line.updatedAt ?? new Date(line.run.startedAt).toISOString()),
          ...gateTimes,
        ),
      ).toISOString(),
      workflow: line.run.workflow,
      status: statusOf(line),
      queueReason: line.queueReason ?? nothing,
    };
    if (open === undefined) {
      return { ...common, gate: nothing, deadline: nothing, overdue: false };
    }
    return {
      ...common,
      gate: open.request.gate,
      deadline: deadlineLabel(open.request.deadlineAt, options.now),
      deadlineAt: new Date(open.request.deadlineAt).toISOString(),
      overdue: options.now > open.request.deadlineAt,
    };
  });
