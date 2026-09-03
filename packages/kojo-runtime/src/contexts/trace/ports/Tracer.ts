import { Context, type Effect } from "effect";
import type { GateRecord } from "../../gate/models/GateRecord.ts";
import type { RunId } from "../../shared/models/RunId.ts";
import type { InFlightPhase } from "../models/InFlightPhase.ts";
import type { Occurrence } from "../models/Occurrence.ts";
import type { PhaseRecord } from "../models/PhaseRecord.ts";
import type { RunOutcome, RunRecord } from "../models/RunRecord.ts";
import type { SandboxRecord } from "../models/SandboxRecord.ts";

/**
 * Where the trace goes.
 *
 * Note the shape: there is deliberately no `event(name, data)` method. A method like that is an
 * invitation to scatter half-context lines across a phase and reassemble them later in a query.
 * Every method here takes a *completed* record — everything known about one unit of work, in one
 * call, at the moment it ends.
 */
export class Tracer extends Context.Service<
  Tracer,
  {
    readonly runStarted: (record: RunRecord) => Effect.Effect<void>;
    readonly runFinished: (runId: RunId, outcome: RunOutcome) => Effect.Effect<void>;
    /**
     * The run's *current* phase, stamped on the run row when the phase is entered.
     *
     * **The one method here that does not take a completed record, and the exception is principled.**
     * adr/trace/0002: a phase record is written on exit, so a phase that has been running for four
     * minutes has none and a live run has nothing to draw. This is not a record of work — it is the
     * run's mutable status, on the row that is already mutable for exactly that reason — and it is
     * *replaced*, never accumulated, so no completed unit of work gains a second row.
     */
    readonly phaseEntered: (runId: RunId, phase: InFlightPhase) => Effect.Effect<void>;
    /** Written once, on exit, on every path. Clears the in-flight phase it replaces. */
    readonly phase: (record: PhaseRecord) => Effect.Effect<void>;
    /** One record per *asking*, written when that asking settles. Carries the human latency. */
    readonly gate: (record: GateRecord) => Effect.Effect<void>;
    /**
     * One record per **acquisition**, written when the sandbox is released.
     *
     * Not per sandbox definition. A run that suspends at a gate tears its container down and builds
     * it again on resume, and both acquisitions get a row — otherwise the rebuild, which is the
     * cost of the central decision in this design, is invisible.
     */
    readonly sandbox: (record: SandboxRecord) => Effect.Effect<void>;
    /**
     * One repetition inside a phase, written when that repetition ends.
     *
     * The subordinate record, and the only method here that may be called many times for one unit of
     * work. It is for the case a wide row cannot hold — a count nobody knows in advance — and it is
     * bound by the rule in `Occurrence`: no question may need one of these to answer it.
     */
    readonly occurrence: (record: Occurrence) => Effect.Effect<void>;
  }
>()("kojo/trace/Tracer") {}
