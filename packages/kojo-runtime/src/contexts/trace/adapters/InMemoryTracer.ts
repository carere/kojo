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
    /** Active Phase attempts per Run. Completion removes only its own attempt. */
    readonly inFlight: Effect.Effect<ReadonlyMap<RunId, ReadonlyArray<InFlightPhase>>>;
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
    const inFlight = new Map<RunId, ReadonlyArray<InFlightPhase>>();

    return Context.make(Tracer, {
      runStarted: (record) => Effect.sync(() => void runs.push(record)),
      runFinished: (runId, outcome) =>
        Effect.sync(() => {
          outcomes.set(runId, outcome);
          inFlight.delete(runId);
        }),
      phaseEntered: (runId, phase) =>
        Effect.sync(() => {
          if (phases.some((record) => record.runId === runId && record.phaseId === phase.phaseId))
            return;
          const siblings = inFlight.get(runId) ?? [];
          inFlight.set(runId, [
            ...siblings.filter((item) => item.phaseId !== phase.phaseId),
            phase,
          ]);
        }),
      // The record and the clearing of the status it replaces, exactly as the durable adapter does
      // both in one write. A phase that has exited must not still be drawn as one that is running.
      phase: (record) =>
        Effect.sync(() => {
          phases.push(record);
          const siblings = (inFlight.get(record.runId) ?? []).filter(
            (phase) => phase.phaseId !== record.phaseId,
          );
          if (siblings.length === 0) inFlight.delete(record.runId);
          else inFlight.set(record.runId, siblings);
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
