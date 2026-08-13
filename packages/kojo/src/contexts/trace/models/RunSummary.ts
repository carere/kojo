import { Schema } from "effect";
import { InFlightPhase } from "./InFlightPhase.ts";
import { RunOutcome, RunRecord } from "./RunRecord.ts";

/**
 * One line of the run list: what produced the run, and where the run stands now.
 *
 * The run row is the only mutable one in the trace, so reading it gives two things that no other
 * record carries — the outcome the writer stamps on every stop, and when the run last stopped. They
 * are held beside the immutable record rather than merged into it, because `RunRecord` is what the
 * writer was handed and this is what the file holds now.
 *
 * **The in-flight phase is here now.** adr/trace/0002 puts it on the run row; ticket 24 shipped no
 * column for it and said the next migration would add one, and `0002_in_flight` is that migration.
 * So this class carries three mutable things rather than two, and all three come off the one row the
 * trace is allowed to rewrite.
 */
export class RunSummary extends Schema.Class<RunSummary>("RunSummary")({
  run: RunRecord,
  /**
   * How the run last stopped, or absent while it has never stopped.
   *
   * Three states rather than two, and `suspended` is the interesting one: it is written every time
   * the body stops to wait for a human, so a run can be suspended today and succeeded tomorrow.
   * Absent means the run started and the writer has not stamped it since — which is *executing*,
   * and is not the same as `suspended`.
   */
  outcome: Schema.optionalKey(RunOutcome),
  /** When the outcome was last written. Absent for exactly the runs whose outcome is absent. */
  finishedAt: Schema.optionalKey(Schema.Finite),
  /**
   * What the run is executing right now, or absent because nothing is.
   *
   * Written when a phase is entered and cleared when its record replaces it, so it is absent for the
   * whole life of a finished run and present for most of the life of a live one. See
   * {@link InFlightPhase} for why a value here is never proof that anything is still moving.
   */
  inFlight: Schema.optionalKey(InFlightPhase),
}) {
  /**
   * Has this run stopped for good?
   *
   * The Console polls once a second while a run is live and stops entirely at a terminal status, so
   * that rule needs one place to ask. `suspended` is deliberately **not** terminal: a suspended run
   * is waiting for a person and will move the moment one answers.
   */
  get terminal(): boolean {
    return this.outcome === "succeeded" || this.outcome === "failed";
  }
}
