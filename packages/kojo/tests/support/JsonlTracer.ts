import { appendFileSync, readFileSync } from "node:fs";
import { Context, Effect, Layer, Schema } from "effect";
import { GateRecord } from "../../src/contexts/gate/models/GateRecord.ts";
import type { RunId } from "../../src/contexts/shared/models/RunId.ts";
import { Occurrence } from "../../src/contexts/trace/models/Occurrence.ts";
import { PhaseRecord } from "../../src/contexts/trace/models/PhaseRecord.ts";
import { RunOutcome, RunRecord } from "../../src/contexts/trace/models/RunRecord.ts";
import { SandboxRecord } from "../../src/contexts/trace/models/SandboxRecord.ts";
import { Tracer } from "../../src/contexts/trace/ports/Tracer.ts";

/**
 * A trace that outlives the process that wrote it.
 *
 * `InMemoryTracer` cannot answer the question ticket 19 exists to ask. A lane that suspends at a
 * gate is started by one process and finished by another, so a trace held in arrays reports one
 * third of the run to whoever asks — and the assertions that matter (one row per phase however many
 * times the body replayed, one row per *acquisition* so the rebuild is visible, two acquisitions
 * that do not share an id) are all assertions **across** the processes.
 *
 * A file rather than SQLite because `SqliteTracer` is ticket 24 and this suite must not invent its
 * schema early. One JSON object per line, appended synchronously: append is atomic enough for the
 * one writer at a time this design has, and a line that is written is a fact that survives the
 * process being killed a moment later — which is exactly the failure mode under test.
 *
 * Kept in `tests/support` and not in `src` for that reason: it is a real adapter, so an integration
 * test may use it, but it is not the trace Kojo ships.
 */

/** One line of the file: which table the row belongs to, and the row. */
const Line = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("run"), record: RunRecord }),
  Schema.Struct({ kind: Schema.Literal("phase"), record: PhaseRecord }),
  Schema.Struct({ kind: Schema.Literal("gate"), record: GateRecord }),
  Schema.Struct({ kind: Schema.Literal("sandbox"), record: SandboxRecord }),
  Schema.Struct({ kind: Schema.Literal("occurrence"), record: Occurrence }),
  Schema.Struct({
    kind: Schema.Literal("outcome"),
    runId: Schema.String,
    outcome: RunOutcome,
  }),
]);

const encodeLine = Schema.encodeUnknownSync(Line);
const decodeLine = Schema.decodeUnknownSync(Line);

/** Everything one file holds, split back into the four tables and the outcome map. */
export interface ReadTrace {
  readonly runs: ReadonlyArray<RunRecord>;
  readonly phases: ReadonlyArray<PhaseRecord>;
  readonly gates: ReadonlyArray<GateRecord>;
  readonly sandboxes: ReadonlyArray<SandboxRecord>;
  readonly occurrences: ReadonlyArray<Occurrence>;
  readonly outcomes: ReadonlyMap<string, RunOutcome>;
  /**
   * One entry per **execution of the body**, in order — not one per run.
   *
   * `runFinished` is called from `Effect.onExit` around the workflow body, and a suspended run
   * re-executes that body every time it resumes. So this list grows by exactly one each time a run
   * stops or finishes, which makes it the only signal in the system that says *the process you just
   * started has got as far as it is going to get*. The engine's own `poll` cannot say that: between
   * two suspensions its answer is the string `suspended` both before and after.
   */
  readonly executions: ReadonlyArray<{ readonly runId: string; readonly outcome: RunOutcome }>;
}

/**
 * Reads the whole file back, in the order it was written.
 *
 * Synchronous and outside Effect on purpose: it is called from a test's assertions, where the
 * subject is the run that already finished rather than the reading of it.
 */
export const read = (path: string): ReadTrace => {
  const runs: Array<RunRecord> = [];
  const phases: Array<PhaseRecord> = [];
  const gates: Array<GateRecord> = [];
  const sandboxes: Array<SandboxRecord> = [];
  const occurrences: Array<Occurrence> = [];
  const outcomes = new Map<string, RunOutcome>();
  const executions: Array<{ readonly runId: string; readonly outcome: RunOutcome }> = [];

  const text = (() => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      // A run that traced nothing leaves no file. That is an empty trace, not a broken one.
      return "";
    }
  })();

  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const parsed = decodeLine(JSON.parse(line));
    switch (parsed.kind) {
      case "run":
        runs.push(parsed.record);
        break;
      case "phase":
        phases.push(parsed.record);
        break;
      case "gate":
        gates.push(parsed.record);
        break;
      case "sandbox":
        sandboxes.push(parsed.record);
        break;
      case "occurrence":
        occurrences.push(parsed.record);
        break;
      case "outcome":
        outcomes.set(parsed.runId, parsed.outcome);
        executions.push({ runId: parsed.runId, outcome: parsed.outcome });
        break;
    }
  }

  return { runs, phases, gates, sandboxes, occurrences, outcomes, executions };
};

/** How many times this run's body has finished executing, however it finished. */
export const executionsOf = (path: string, runId: string): ReadonlyArray<RunOutcome> =>
  read(path)
    .executions.filter((entry) => entry.runId === runId)
    .map((entry) => entry.outcome);

/** The path this process is tracing to, so a workflow body can name it without a global. */
export class TracePath extends Context.Service<TracePath, { readonly path: string }>()(
  "kojo/test/TracePath",
) {}

export const layer = (path: string): Layer.Layer<Tracer | TracePath> =>
  Layer.effectContext(
    Effect.sync(() => {
      const write = (line: unknown) =>
        Effect.sync(() => appendFileSync(path, `${JSON.stringify(encodeLine(line))}\n`));

      return Context.make(Tracer, {
        runStarted: (record: RunRecord) => write({ kind: "run", record }),
        runFinished: (runId: RunId, outcome: RunOutcome) =>
          write({ kind: "outcome", runId, outcome }),
        // The run's mutable status, which a file of appended rows cannot hold — every line here is a
        // record of completed work, and this is the one thing the trace overwrites. The lane suite
        // asks what a run *did*, never what it is doing, so nothing is lost by dropping it.
        phaseEntered: () => Effect.void,
        phase: (record: PhaseRecord) => write({ kind: "phase", record }),
        gate: (record: GateRecord) => write({ kind: "gate", record }),
        sandbox: (record: SandboxRecord) => write({ kind: "sandbox", record }),
        occurrence: (record: Occurrence) => write({ kind: "occurrence", record }),
      }).pipe(Context.add(TracePath, { path }));
    }),
  );
