import { Option } from "effect";
import { laneOf } from "../contexts/shared/models/SandboxId.ts";
import type { PhaseRecord } from "../contexts/trace/models/PhaseRecord.ts";

const OUTCOME_MARK: Record<PhaseRecord["outcome"], string> = {
  succeeded: "ok",
  failed: "FAIL",
  interrupted: "interrupted",
};

/** What a phase that never entered a sandbox scope is shown as. It ran on the host, and says so. */
const HOST = "host";

const pad = (value: string, width: number) => value.padEnd(width);

/**
 * Renders the phase records of one run as a table.
 *
 * Ordered by when each phase started rather than by when it finished, because the question a
 * reader is asking is what the run did, in order — not what happened to complete first.
 *
 * **The LANE column appears only when the run used a sandbox at all.** It is read from the phase's
 * own `sandboxId`, so it costs no second query and no matching on time; the moment two lanes run at
 * once, time is exactly what cannot tell them apart. A run with no container has nothing to say
 * here and the column is left out rather than filled with one repeated word.
 */
export const renderPhaseTable = (phases: ReadonlyArray<PhaseRecord>): string => {
  if (phases.length === 0) return "no phases recorded";

  const rows = [...phases]
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((phase) => ({
      name: phase.name,
      lane: Option.getOrElse(laneOf(phase.sandboxId), () => HOST),
      kind: phase.kind,
      outcome: OUTCOME_MARK[phase.outcome],
      duration: `${phase.durationMillis}ms`,
      description: phase.description,
    }));

  const sandboxed = rows.some((row) => row.lane !== HOST);

  const widths = {
    name: Math.max(5, ...rows.map((r) => r.name.length)),
    lane: Math.max(4, ...rows.map((r) => r.lane.length)),
    kind: Math.max(4, ...rows.map((r) => r.kind.length)),
    outcome: Math.max(7, ...rows.map((r) => r.outcome.length)),
    duration: Math.max(8, ...rows.map((r) => r.duration.length)),
  };

  const header = [
    pad("PHASE", widths.name),
    ...(sandboxed ? [pad("LANE", widths.lane)] : []),
    pad("KIND", widths.kind),
    pad("OUTCOME", widths.outcome),
    pad("DURATION", widths.duration),
    "DESCRIPTION",
  ].join("  ");

  const body = rows.map((row) =>
    [
      pad(row.name, widths.name),
      ...(sandboxed ? [pad(row.lane, widths.lane)] : []),
      pad(row.kind, widths.kind),
      pad(row.outcome, widths.outcome),
      pad(row.duration, widths.duration),
      row.description,
    ].join("  "),
  );

  return [header, ...body].join("\n");
};
