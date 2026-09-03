import { Context, Effect, Layer } from "effect";
import type { GateRecord } from "../../gate/models/GateRecord.ts";
import type { RunId } from "../../shared/models/RunId.ts";
import type { InFlightPhase } from "../models/InFlightPhase.ts";
import type { Occurrence } from "../models/Occurrence.ts";
import type { PhaseRecord } from "../models/PhaseRecord.ts";
import type { RunOutcome, RunRecord } from "../models/RunRecord.ts";
import type { SandboxRecord } from "../models/SandboxRecord.ts";
import { Tracer } from "../ports/Tracer.ts";

/**
 * The recorded trace of one process, readable from a test or from the CLI without a database.
 *
 * Separate from `Tracer` on purpose: `Tracer` is the write port every phase depends on, and
 * nothing that writes a record should be able to read the others back.
 */
export class RecordedTrace extends Context.Service<
  RecordedTrace,
  {
    readonly runs: Effect.Effect<ReadonlyArray<RunRecord>>;
    readonly phases: Effect.Effect<ReadonlyArray<PhaseRecord>>;
    readonly gates: Effect.Effect<ReadonlyArray<GateRecord>>;
    readonly sandboxes: Effect.Effect<ReadonlyArray<SandboxRecord>>;
    readonly occurrences: Effect.Effect<ReadonlyArray<Occurrence>>;
    readonly outcomes: Effect.Effect<ReadonlyMap<RunId, RunOutcome>>;
    /**
     * What each run is executing right now — replaced on entry, removed when the record arrives.
     *
     * A map rather than a list, because this is the run's status and not a record of work. A run
     * whose phase has exited is absent from it, which is what makes "cleared when the record replaces
     * it" checkable in a tier with no database.
     */
    readonly inFlight: Effect.Effect<ReadonlyMap<RunId, InFlightPhase>>;
  }
>()("kojo/trace/RecordedTrace") {}

/**
 * The in-memory adapter, providing both services from one piece of state.
 *
 * Both services come out of a single `Layer.effectContext` because they are two views of the same
 * arrays. Two separate layers would each build their own state and the reader would always be
 * empty — a failure that looks exactly like "nothing was traced".
 */
export const layer: Layer.Layer<RecordedTrace | Tracer> = Layer.effectContext(
  Effect.sync(() => {
    const runs: Array<RunRecord> = [];
    const phases: Array<PhaseRecord> = [];
    const gates: Array<GateRecord> = [];
    const sandboxes: Array<SandboxRecord> = [];
    const occurrences: Array<Occurrence> = [];
    const outcomes = new Map<RunId, RunOutcome>();
    const inFlight = new Map<RunId, InFlightPhase>();

    return Context.make(Tracer, {
      runStarted: (record) => Effect.sync(() => void runs.push(record)),
      runFinished: (runId, outcome) => Effect.sync(() => void outcomes.set(runId, outcome)),
      phaseEntered: (runId, phase) => Effect.sync(() => void inFlight.set(runId, phase)),
      // The record and the clearing of the status it replaces, exactly as the durable adapter does
      // both in one write. A phase that has exited must not still be drawn as one that is running.
      phase: (record) =>
        Effect.sync(() => {
          phases.push(record);
          inFlight.delete(record.runId);
        }),
      gate: (record) => Effect.sync(() => void gates.push(record)),
      sandbox: (record) => Effect.sync(() => void sandboxes.push(record)),
      occurrence: (record) => Effect.sync(() => void occurrences.push(record)),
    }).pipe(
      Context.add(RecordedTrace, {
        runs: Effect.sync(() => [...runs]),
        phases: Effect.sync(() => [...phases]),
        gates: Effect.sync(() => [...gates]),
        sandboxes: Effect.sync(() => [...sandboxes]),
        occurrences: Effect.sync(() => [...occurrences]),
        outcomes: Effect.sync(() => new Map(outcomes)),
        inFlight: Effect.sync(() => new Map(inFlight)),
      }),
    );
  }),
);
