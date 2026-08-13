import { Context, Effect, Layer } from "effect";
import type { GateRecord } from "../../gate/models/GateRecord.ts";
import type { RunId } from "../../shared/models/RunId.ts";
import type { InFlightPhase } from "../models/InFlightPhase.ts";
import type { Occurrence } from "../models/Occurrence.ts";
import type { PhaseRecord } from "../models/PhaseRecord.ts";
import type { RunOutcome, RunRecord } from "../models/RunRecord.ts";
import type { SandboxRecord } from "../models/SandboxRecord.ts";
import { Tracer } from "../ports/Tracer.ts";
import { RecordedTrace } from "./InMemoryTracer.ts";

/**
 * The durable tracer, plus what **this process** handed it.
 *
 * The same shape as `RecordingGate`: another adapter, and one more thing written down beside it. A
 * command needs two different answers from the trace and they are not the same question:
 *
 * - *What has this factory done?* — the file on disk, read by `kojo ui` from another process, days
 *   later. That is the tracer this one is given, and it is the whole point of a durable trace.
 * - *What did this invocation execute?* — the phase table `kojo run` and `kojo watch` print. It is
 *   **the replay witness**: a resumed run must print only the phases after the gate, because
 *   everything before it came back as a recorded activity result without its body running again.
 *   Read from the file, that table would hold the whole run and the witness would be gone.
 *
 * So the writes go through to the durable tracer and are also kept here, and `RecordedTrace` answers
 * the second question exactly as the in-memory adapter answers it for a test. **The service is the
 * one `InMemoryTracer` declares** rather than a second one of the same shape: `reportPhases` and
 * `kojo watch` ask for that tag, and two tags would mean a table that is silently always empty.
 *
 * Nothing here can fail. `Tracer`'s methods promise `Effect<void>`, the durable adapter keeps that
 * promise by swallowing its own errors, and pushing onto an array cannot fail — so a trace write
 * still cannot take a run down.
 */
const make = Effect.gen(function* () {
  const durable = yield* Tracer;

  const runs: Array<RunRecord> = [];
  const phases: Array<PhaseRecord> = [];
  const gates: Array<GateRecord> = [];
  const sandboxes: Array<SandboxRecord> = [];
  const occurrences: Array<Occurrence> = [];
  const outcomes = new Map<RunId, RunOutcome>();
  const inFlight = new Map<RunId, InFlightPhase>();

  /** Write it where it survives the process, then remember that this process wrote it. */
  const alsoRemember = (written: Effect.Effect<void>, remember: () => void): Effect.Effect<void> =>
    Effect.andThen(written, Effect.sync(remember));

  return Context.make(Tracer, {
    runStarted: (record: RunRecord) =>
      alsoRemember(durable.runStarted(record), () => void runs.push(record)),
    runFinished: (runId: RunId, outcome: RunOutcome) =>
      alsoRemember(durable.runFinished(runId, outcome), () => void outcomes.set(runId, outcome)),
    phaseEntered: (runId: RunId, phase: InFlightPhase) =>
      alsoRemember(durable.phaseEntered(runId, phase), () => void inFlight.set(runId, phase)),
    phase: (record: PhaseRecord) =>
      alsoRemember(durable.phase(record), () => {
        phases.push(record);
        inFlight.delete(record.runId);
      }),
    gate: (record: GateRecord) => alsoRemember(durable.gate(record), () => void gates.push(record)),
    sandbox: (record: SandboxRecord) =>
      alsoRemember(durable.sandbox(record), () => void sandboxes.push(record)),
    occurrence: (record: Occurrence) =>
      alsoRemember(durable.occurrence(record), () => void occurrences.push(record)),
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
});

/**
 * The decorator, over whichever `Tracer` it is provided.
 *
 * It takes the tag it also answers, which is what makes it a decorator rather than a second adapter:
 * `RecordingTracer.layer.pipe(Layer.provide(SqliteTracer.layer))` hands the durable writer in and
 * publishes this one in its place. Provided, never merged — a merge would leave the two adapters
 * competing for one tag, and whichever won would be the only one that ever wrote.
 */
export const layer: Layer.Layer<Tracer | RecordedTrace, never, Tracer> = Layer.effectContext(make);
