import { Effect, Layer, Option } from "effect";
import type { GateRecord } from "../../gate/models/GateRecord.ts";
import type { RunId } from "../../shared/models/RunId.ts";
import type { Occurrence } from "../models/Occurrence.ts";
import {
  defaultPageSize,
  type OccurrenceCursor,
  OccurrencePage,
} from "../models/OccurrencePage.ts";
import type { PhaseRecord } from "../models/PhaseRecord.ts";
import { RunDocument } from "../models/RunDocument.ts";
import { RunSummary } from "../models/RunSummary.ts";
import type { SandboxRecord } from "../models/SandboxRecord.ts";
import { TraceReader } from "../ports/TraceReader.ts";
import { RecordedTrace } from "./InMemoryTracer.ts";

/**
 * A whole trace as plain arrays — what the browser tier runs against.
 *
 * console.md §11 fixes this as the Console's test seam: the browser tests exercise the real routes,
 * the real Query wiring and the real waterfall behind **in-memory readers**, so only the data source
 * is fake. That means the fixtures have to be able to say things a running process cannot be made to
 * say on demand — a gate held for forty-one hours, a phase interrupted mid-flight, a sandbox
 * acquired twice — which is why this takes records rather than driving a workflow.
 */
export interface Records {
  readonly runs: ReadonlyArray<RunSummary>;
  readonly phases: ReadonlyArray<PhaseRecord>;
  readonly gates: ReadonlyArray<GateRecord>;
  readonly sandboxes: ReadonlyArray<SandboxRecord>;
  /**
   * Every occurrence of every phase, in the order they were recorded.
   *
   * One array rather than a map by phase, on purpose: the position in this array **is** the cursor,
   * exactly as the `id` column is in the database. Grouping them first would give each phase a
   * cursor of its own, and a reader written against that would break the moment it met the real
   * adapter, where the cursor is a table-wide row id.
   */
  readonly occurrences: ReadonlyArray<Occurrence>;
}

/** Ascending by whatever the record calls its start. A copy is sorted: the caller's array is theirs. */
const oldestFirst = <A>(records: ReadonlyArray<A>, at: (record: A) => number): ReadonlyArray<A> =>
  [...records].sort((left, right) => at(left) - at(right));

const documentOf = (records: Records, summary: RunSummary): RunDocument =>
  new RunDocument({
    run: summary,
    phases: oldestFirst(
      records.phases.filter((phase) => phase.runId === summary.run.runId),
      (phase) => phase.startedAt,
    ),
    gates: oldestFirst(
      records.gates.filter((gate) => gate.runId === summary.run.runId),
      (gate) => gate.requestedAt,
    ),
    sandboxes: oldestFirst(
      records.sandboxes.filter((sandbox) => sandbox.runId === summary.run.runId),
      (sandbox) => sandbox.acquiredAt,
    ),
  });

/**
 * The reader over a source of records, read again on every call.
 *
 * **Read again, never captured.** The one live source — `RecordedTrace` — fills up while a workflow
 * runs, and a service that snapshotted its arrays when the layer was built would answer empty
 * forever. That is the same failure `InMemoryTracer` warns about for its own two services, and it
 * looks exactly like "nothing was traced".
 */
const service = (source: Effect.Effect<Records>): TraceReader["Service"] => ({
  runs: Effect.map(source, (records) =>
    [...records.runs].sort((left, right) => right.run.startedAt - left.run.startedAt),
  ),

  run: (runId: RunId) =>
    Effect.map(source, (records) =>
      Option.map(
        Option.fromUndefinedOr(records.runs.find((summary) => summary.run.runId === runId)),
        (summary) => documentOf(records, summary),
      ),
    ),

  occurrences: (options) =>
    Effect.map(source, (records) => {
      // The index carries the cursor before anything is filtered, so a phase's third occurrence
      // keeps the place it holds in the whole trace rather than gaining one of its own.
      const numbered = records.occurrences.map((occurrence, index) => ({
        occurrence,
        cursor: (index + 1) as OccurrenceCursor,
      }));
      const after = numbered.filter(
        (row) => row.occurrence.phaseId === options.phaseId && row.cursor > options.since,
      );
      const page = after.slice(0, options.limit ?? defaultPageSize);

      return new OccurrencePage({
        occurrences: page.map((row) => row.occurrence),
        // A poll that found nothing leaves the cursor where it was. Answering zero here would send
        // the panel back to the first tool call on every idle second.
        cursor: page[page.length - 1]?.cursor ?? options.since,
      });
    }),
});

/**
 * The reader over records a test states outright.
 *
 * Every field defaults to empty, so a fixture says only what it is about — a run with no phases yet
 * is `of({ runs: [oneRun] })`, and that state is one console.md names as a thing a UI gets wrong.
 */
export const of = (records: Partial<Records>): Layer.Layer<TraceReader> =>
  Layer.succeed(
    TraceReader,
    service(
      Effect.succeed({
        runs: records.runs ?? [],
        phases: records.phases ?? [],
        gates: records.gates ?? [],
        sandboxes: records.sandboxes ?? [],
        occurrences: records.occurrences ?? [],
      }),
    ),
  );

/**
 * The reader over what *this process* traced, through `InMemoryTracer`'s own recording.
 *
 * The pairing the rest of the codebase has: a unit test drives a workflow against `InMemoryTracer`
 * and then reads the result back through the same port the Console reads, so the shapes the UI
 * lives with are exercised by the tier that has no database at all.
 *
 * One thing it cannot say, and it says nothing rather than guessing: `RecordedTrace` keeps a run's
 * outcome and not the moment it was written, so `finishedAt` stays absent here. The durable adapter
 * has the column; this one would have to invent the value.
 *
 * The in-flight phase it *can* say, and does: `RecordedTrace` keeps the same map the durable writer
 * keeps in a column, so a unit test can drive a workflow and read back which phase a run is inside
 * without a database.
 */
export const layer: Layer.Layer<TraceReader, never, RecordedTrace> = Layer.effect(
  TraceReader,
  Effect.map(RecordedTrace, (recorded) =>
    service(
      Effect.gen(function* () {
        const outcomes = yield* recorded.outcomes;
        const running = yield* recorded.inFlight;
        return {
          runs: (yield* recorded.runs).map((run) => {
            const outcome = outcomes.get(run.runId);
            const inFlight = running.get(run.runId);
            return new RunSummary({
              run,
              ...(outcome === undefined ? {} : { outcome }),
              ...(inFlight === undefined ? {} : { inFlight }),
            });
          }),
          phases: yield* recorded.phases,
          gates: yield* recorded.gates,
          sandboxes: yield* recorded.sandboxes,
          occurrences: yield* recorded.occurrences,
        };
      }),
    ),
  ),
);
