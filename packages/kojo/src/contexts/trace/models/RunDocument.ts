import { Schema } from "effect";
import { GateRecord } from "../../gate/models/GateRecord.ts";
import { PhaseRecord } from "./PhaseRecord.ts";
import { RunSummary } from "./RunSummary.ts";
import { SandboxRecord } from "./SandboxRecord.ts";

/**
 * One whole run, in one value: everything the run view draws, fetched in one read.
 *
 * **This is a document rather than a page, and that is the design decision the Console lives with.**
 * console.md §7 makes the case: a run's phase list is ten to forty records and a few kilobytes, so
 * polling the whole thing and replacing it removes every merge concern a cursor would create — no
 * de-duplication, no reconciling a record that was rewritten, no gap when a poll is missed. The one
 * genuinely unbounded stream inside a run is a phase's occurrences, and that one — and only that one
 * — is read by cursor.
 *
 * Occurrences are therefore absent here on purpose. They belong to the phase detail panel, they are
 * read while a phase is in flight, and putting them in this document would make the cheap poll
 * expensive exactly when a run is busiest.
 */
export class RunDocument extends Schema.Class<RunDocument>("RunDocument")({
  run: RunSummary,
  /** Every phase, oldest first. The waterfall draws them in this order. */
  phases: Schema.Array(PhaseRecord),
  /**
   * Every **settled** asking, oldest first.
   *
   * A gate that is still waiting has no record yet — the trace writes one when the asking settles —
   * so the open question a run is suspended on comes from the askings, not from here. The two are
   * different sources answering different questions, and the Console shows both.
   */
  gates: Schema.Array(GateRecord),
  /** Every acquisition, oldest first. A rebuild after a gate is a second row, so it is a second. */
  sandboxes: Schema.Array(SandboxRecord),
}) {}
