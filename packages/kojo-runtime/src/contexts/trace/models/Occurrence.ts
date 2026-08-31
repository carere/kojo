import { Schema } from "effect";
import { PhaseId } from "../../shared/models/PhaseId.ts";
import { RunId } from "../../shared/models/RunId.ts";

/** What repeated. Three kinds, because three are what a phase genuinely does many of. */
export const OccurrenceKind = Schema.Literals(["exec", "tool", "iteration"]);
export type OccurrenceKind = typeof OccurrenceKind.Type;

/** How one repetition ended. There is no `interrupted`: an interrupted phase records the phase. */
export const OccurrenceOutcome = Schema.Literals(["succeeded", "failed"]);
export type OccurrenceOutcome = typeof OccurrenceOutcome.Type;

/**
 * One repetition **inside** a phase — a tool call, an `exec`, an iteration.
 *
 * The subordinate record, and the only one in the trace that is allowed to be numerous. It exists
 * for the case the wide record cannot hold: a count nobody knows in advance, where each instance is
 * its own fact. Everything else is a column on the phase row.
 *
 * Two rules govern it, and both are the reason the trace does not decay into an event log:
 *
 * - **An occurrence never carries context its phase record lacks.** It has a run and a phase and
 *   what it did, and nothing else. There is no agent here, no model, no verdict — those are the
 *   phase's, and a copy on every tool call is how a wide record turns back into thin rows.
 * - **No question may need one to answer it.** If a human has to open the occurrences to learn what
 *   a phase cost or how it ended, the phase row is missing a column and this is not the fix.
 *
 * It is also the one table with a reader's cursor, which is why its row carries an explicit
 * `INTEGER PRIMARY KEY` in the schema: `select *` never expands SQLite's implicit rowid, so a
 * reader polling for new occurrences would get no cursor to advance and re-read row one forever.
 */
export class Occurrence extends Schema.Class<Occurrence>("Occurrence")({
  runId: RunId,
  /** The phase this repeated inside. An occurrence outside a phase has no home and no meaning. */
  phaseId: PhaseId,
  kind: OccurrenceKind,
  /** What ran — the command line, the tool's name, the iteration's label. */
  name: Schema.String,
  startedAt: Schema.Finite,
  endedAt: Schema.Finite,
  outcome: OccurrenceOutcome,
  /** One line about how it ended — an exit code, a tool's own error. Absent when there is none. */
  detail: Schema.optionalKey(Schema.String),
}) {
  get durationMillis(): number {
    return this.endedAt - this.startedAt;
  }
}
