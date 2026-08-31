import { Schema } from "effect";
import { PhaseId } from "../../shared/models/PhaseId.ts";
import { SandboxId } from "../../shared/models/SandboxId.ts";
import { PhaseKind } from "./PhaseRecord.ts";

/**
 * The phase a run is executing **right now**, held on the run row.
 *
 * adr/trace/0002. A phase record is written once, on exit, so while an agent phase runs for four
 * minutes the trace holds nothing about it and a live run has nothing to draw. This is what the run
 * row carries in the meantime: enough to draw one span that grows to *now*, and no more.
 *
 * **It is not a phase record and must never be mistaken for one.** There is no outcome here, no
 * duration, no verification and no repository effect, because none of those exist until the phase
 * ends. The record replaces this value on exit — the Console draws the growing span until then and
 * the real span afterwards — so nothing is ever assembled from the two together.
 *
 * A stale value is possible and is not a defect: a process killed outright never runs its exit
 * handler, so the column keeps whatever the dead run was doing. The Console drops it for a run that
 * has reached a terminal outcome, so a finished run never carries a span that grows for ever.
 *
 * **A suspended run is not covered by that guard, and is covered by the writers instead.** Suspend
 * is a graceful interrupt: `code` and `agent` both clear this column from the same `onExit` that
 * writes the interrupted record, so a run waiting at a gate has nothing here to draw. A writer that
 * could suspend without running its exit handler would break that, and the guard — in the Console's
 * `spansOf`, and in the held row `rowsOf` derives from `sandboxId` — would have to tighten from
 * *terminal* to *executing*. Whoever adds such a writer owns both.
 */
export class InFlightPhase extends Schema.Class<InFlightPhase>("InFlightPhase")({
  phaseId: PhaseId,
  name: Schema.String,
  kind: PhaseKind,
  /** Which attempt this is. A retried phase re-enters, so the number moves while the name does not. */
  attempt: Schema.Finite,
  startedAt: Schema.Finite,
  /** The acquisition it is running inside, absent on the host — the same reading `PhaseRecord` takes. */
  sandboxId: Schema.optionalKey(SandboxId),
}) {}
