import type { AskedGate } from "../contexts/gate/models/AskedGate.ts";
import { waitingFirst } from "../contexts/gate/models/AskedGate.ts";

const pad = (value: string, width: number) => value.padEnd(width);

/**
 * A span of time as a person reads it.
 *
 * Rounded down to two units, because the question this list answers is *has this been sitting too
 * long*, and `2d 6h` answers it while `2d 6h 13m 4s` makes the reader do the rounding themselves.
 */
export const humanMillis = (millis: number): string => {
  const total = Math.max(0, Math.floor(millis / 1000));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;

  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  return `${seconds}s`;
};

/** What the deadline column says, which is a different sentence in each of the four states. */
const deadlineOf = (gate: AskedGate, now: number): string => {
  switch (gate.state(now)) {
    case "recorded":
      return `${gate.verdict?.choice ?? ""} by ${gate.verdict?.answerer ?? ""}`;
    // Two different sentences on purpose: OVERDUE means an answer may still land, EXPIRED means
    // the run already took its expiry branch and no answer can reach it any more.
    case "expired":
      return `EXPIRED ${humanMillis(now - (gate.expiredAt ?? now))} ago`;
    case "overdue":
      return `OVERDUE by ${humanMillis(-gate.remainingMillis(now))}`;
    case "waiting":
      return `in ${humanMillis(gate.remainingMillis(now))}`;
  }
};

/**
 * The askings, worst first.
 *
 * Ordered by `waitingFirst` rather than by when each question was asked, and the ordering is the
 * feature: a run whose deadline has already passed is the one nobody looked at, so it goes at the
 * top rather than under everything asked since. Human latency is the metric this design lives or
 * dies by, and a list that buries the worst case reports the opposite of what it measures.
 *
 * The token is printed in full because it is the argument to the next command. Truncating it would
 * make every line of this table something the reader has to go and look up somewhere else.
 */
export const renderGateTable = (gates: ReadonlyArray<AskedGate>, now: number): string => {
  if (gates.length === 0) return "no gate waits on anybody";

  const rows = waitingFirst(gates, now).map((gate) => ({
    state: gate.state(now),
    run: gate.request.runId as string,
    gate: gate.request.gate,
    actor: gate.request.actor,
    waiting: humanMillis(gate.waitedMillis(now)),
    deadline: deadlineOf(gate, now),
    token: gate.request.token as string,
  }));

  const widths = {
    state: Math.max(5, ...rows.map((row) => row.state.length)),
    run: Math.max(3, ...rows.map((row) => row.run.length)),
    gate: Math.max(4, ...rows.map((row) => row.gate.length)),
    actor: Math.max(5, ...rows.map((row) => row.actor.length)),
    waiting: Math.max(7, ...rows.map((row) => row.waiting.length)),
    deadline: Math.max(8, ...rows.map((row) => row.deadline.length)),
  };

  const line = (cells: {
    readonly state: string;
    readonly run: string;
    readonly gate: string;
    readonly actor: string;
    readonly waiting: string;
    readonly deadline: string;
    readonly token: string;
  }) =>
    [
      pad(cells.state, widths.state),
      pad(cells.run, widths.run),
      pad(cells.gate, widths.gate),
      pad(cells.actor, widths.actor),
      pad(cells.waiting, widths.waiting),
      pad(cells.deadline, widths.deadline),
      cells.token,
    ].join("  ");

  return [
    line({
      state: "STATE",
      run: "RUN",
      gate: "GATE",
      actor: "ACTOR",
      waiting: "WAITING",
      deadline: "DEADLINE",
      token: "TOKEN",
    }),
    ...rows.map(line),
  ].join("\n");
};
