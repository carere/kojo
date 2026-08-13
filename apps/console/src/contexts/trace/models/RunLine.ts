/**
 * One line of `GET /api/runs`, as the wire carries it.
 *
 * The server's `RunSummary` holds the whole immutable run record; the list reads the three fields it
 * puts on screen and the two mutable ones that say where the run stands.
 */
export interface RunLine {
  readonly run: {
    readonly runId: string;
    readonly workflow: string;
    readonly startedAt: number;
  };
  /** How the run last stopped. Absent while it has never stopped, which is *executing*. */
  readonly outcome?: "succeeded" | "failed" | "suspended";
}

/**
 * Where a run stands, as one word.
 *
 * Four states from the wire's three, because an absent outcome is not a missing value — it is the
 * run still going. Naming it keeps every consumer from re-deciding what `undefined` meant.
 */
export type RunStatus = "executing" | "suspended" | "succeeded" | "failed";

export const statusOf = (line: RunLine): RunStatus => line.outcome ?? "executing";

/**
 * Has this run stopped for good?
 *
 * `suspended` is deliberately not terminal. A suspended run is waiting for a person and moves the
 * moment one answers, so a Console that stopped polling on it would show a run that had resumed
 * hours ago as still waiting.
 */
export const isTerminal = (status: RunStatus): boolean =>
  status === "succeeded" || status === "failed";

/**
 * Is there nothing left to watch?
 *
 * This is the whole poll rule: the list asks again once a second while any run can still move, and
 * stops entirely when none can, so a finished run costs nothing to leave open on screen
 * (console.md §7).
 *
 * **An empty list is not settled.** A factory with no runs in it is exactly where the first one is
 * about to appear, and there is no finished run there whose cost this rule was written to remove.
 */
export const allSettled = (lines: ReadonlyArray<RunLine>): boolean =>
  lines.length > 0 && lines.every((line) => isTerminal(statusOf(line)));
