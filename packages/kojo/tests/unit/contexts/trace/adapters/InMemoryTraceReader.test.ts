import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import { GateRecord } from "../../../../../src/contexts/gate/models/GateRecord.ts";
import { makePhaseId } from "../../../../../src/contexts/shared/models/PhaseId.ts";
import type { RunId } from "../../../../../src/contexts/shared/models/RunId.ts";
import { makeSandboxId } from "../../../../../src/contexts/shared/models/SandboxId.ts";
import * as InMemoryTraceReader from "../../../../../src/contexts/trace/adapters/InMemoryTraceReader.ts";
import * as InMemoryTracer from "../../../../../src/contexts/trace/adapters/InMemoryTracer.ts";
import { Occurrence } from "../../../../../src/contexts/trace/models/Occurrence.ts";
import { beginning } from "../../../../../src/contexts/trace/models/OccurrencePage.ts";
import { PhaseRecord } from "../../../../../src/contexts/trace/models/PhaseRecord.ts";
import { RunRecord } from "../../../../../src/contexts/trace/models/RunRecord.ts";
import { RunSummary } from "../../../../../src/contexts/trace/models/RunSummary.ts";
import { SandboxRecord } from "../../../../../src/contexts/trace/models/SandboxRecord.ts";
import { TraceReader } from "../../../../../src/contexts/trace/ports/TraceReader.ts";
import { Tracer } from "../../../../../src/contexts/trace/ports/Tracer.ts";

/**
 * The read shapes the Console lives with, against no database at all.
 *
 * This is the tier console.md §11 names: the browser tests run the real routes and the real
 * waterfall over an in-memory reader, so what is graded here is the *shape of the answer* — the run
 * list, the whole run document, and the one cursor — rather than any storage.
 */

const first = "run-first" as RunId;
const second = "run-second" as RunId;

const run = (runId: RunId, startedAt: number) =>
  new RunRecord({
    runId,
    workflow: "lane",
    idempotencyKey: `lane/${runId}`,
    startedAt,
    engineVersion: "0.0.0",
    engineCommit: "development",
    configDigest: "sha256:abc",
    host: "builder-1",
  });

const phase = (runId: RunId, name: string, startedAt: number) =>
  new PhaseRecord({
    runId,
    phaseId: makePhaseId(runId, name, 1),
    name,
    description: `the ${name} phase`,
    kind: "code",
    outcome: "succeeded",
    attempt: 1,
    startedAt,
    endedAt: startedAt + 500,
  });

const occurrence = (runId: RunId, phaseName: string, name: string) =>
  new Occurrence({
    runId,
    phaseId: makePhaseId(runId, phaseName, 1),
    kind: "exec",
    name,
    startedAt: 1_000,
    endedAt: 1_250,
    outcome: "succeeded",
  });

const gate = new GateRecord({
  runId: first,
  gate: "review",
  asking: "gate/review/1",
  token: "token-1" as GateRecord["token"],
  description: "Does this land?",
  actor: "engineer",
  choices: ["approve", "reject"],
  requestedAt: 2_000,
  deadlineAt: 605_800_000,
  onExpiry: "fail",
  outcome: "answered",
  answerer: "kevin",
  choice: "approve",
  reason: "reads fine",
  answeredAt: 173_800_000,
});

const sandbox = (sequence: number) =>
  new SandboxRecord({
    runId: first,
    sandboxId: makeSandboxId(first, "lane", 900 * sequence, sequence),
    name: "lane",
    provider: "docker",
    kind: "bind-mount",
    branch: "kojo/lane",
    worktreePath: "/worktrees/kojo/lane",
    environment: { KOJO_RUN_ID: first },
    acquiredAt: 1_000 * sequence,
    releasedAt: 1_000 * sequence + 400,
    outcome: sequence === 1 ? "interrupted" : "released",
  });

/** A trace holding two runs, one of which has everything a run view draws. */
const stated = InMemoryTraceReader.of({
  runs: [
    new RunSummary({ run: run(first, 500), outcome: "succeeded", finishedAt: 9_000 }),
    new RunSummary({ run: run(second, 4_000), outcome: "suspended" }),
  ],
  // Deliberately out of order, and deliberately mixing runs: the reader owes the caller one run's
  // records, oldest first, and a fixture already sorted would grade nothing.
  phases: [
    phase(second, "elsewhere", 100),
    phase(first, "land", 3_000),
    phase(first, "prepare", 1_000),
  ],
  gates: [gate],
  sandboxes: [sandbox(2), sandbox(1)],
  occurrences: [
    occurrence(first, "prepare", "bun install"),
    occurrence(second, "elsewhere", "cargo build"),
    occurrence(first, "prepare", "bun test"),
    occurrence(first, "prepare", "git commit"),
  ],
});

const reading = <A, E>(program: Effect.Effect<A, E, TraceReader>) =>
  program.pipe(Effect.provide(stated));

describe("the run list", () => {
  it.effect("answers every run, newest first", () =>
    reading(
      Effect.gen(function* () {
        const reader = yield* TraceReader;
        const runs = yield* reader.runs;

        expect(runs.map((summary) => summary.run.runId)).toEqual([second, first]);

        // The two facts the list shows beside the name, and the one derived rule the polling cadence
        // rests on: a suspended run is *not* terminal, because a person is about to move it.
        expect(runs[0]?.outcome).toBe("suspended");
        expect(runs[0]?.terminal).toBe(false);
        expect(runs[1]?.outcome).toBe("succeeded");
        expect(runs[1]?.terminal).toBe(true);
      }),
    ),
  );
});

describe("one whole run", () => {
  it.effect("gathers the run's own records, oldest first, and nobody else's", () =>
    reading(
      Effect.gen(function* () {
        const reader = yield* TraceReader;
        const document = Option.getOrThrow(yield* reader.run(first));

        expect(document.run.run.runId).toBe(first);
        expect(document.phases.map((record) => record.name)).toEqual(["prepare", "land"]);
        expect(document.gates.map((record) => record.gate)).toEqual(["review"]);

        // Two acquisitions of one scope, in the order they happened. The gap between them is what a
        // gate cost in rebuild, so a reader that returned them in fixture order would hide it.
        expect(document.sandboxes.map((record) => record.outcome)).toEqual([
          "interrupted",
          "released",
        ]);
      }),
    ),
  );

  it.effect("holds no occurrences, because the document is polled whole", () =>
    reading(
      Effect.gen(function* () {
        const reader = yield* TraceReader;
        const document = Option.getOrThrow(yield* reader.run(first));

        // The document has four fields and none of them is `occurrences`. The one unbounded stream
        // inside a run is read by cursor instead, so the cheap poll stays cheap when a run is busy.
        expect(Object.keys(document).sort()).toEqual(["gates", "phases", "run", "sandboxes"]);
      }),
    ),
  );

  it.effect("answers None for a run it has never seen, rather than failing", () =>
    reading(
      Effect.gen(function* () {
        const reader = yield* TraceReader;
        // A URL a person pasted with one character wrong is not a fault of the trace.
        expect(yield* reader.run("run-typo" as RunId)).toStrictEqual(Option.none());
      }),
    ),
  );
});

describe("the one cursor", () => {
  it.effect("advances, and returns only what came after it", () =>
    reading(
      Effect.gen(function* () {
        const reader = yield* TraceReader;
        const phaseId = makePhaseId(first, "prepare", 1);

        const opened = yield* reader.occurrences({ phaseId, since: beginning, limit: 2 });
        expect(opened.occurrences.map((record) => record.name)).toEqual([
          "bun install",
          "bun test",
        ]);
        expect(opened.cursor).toBeGreaterThan(beginning);

        const next = yield* reader.occurrences({ phaseId, since: opened.cursor });
        expect(next.occurrences.map((record) => record.name)).toEqual(["git commit"]);
        expect(next.cursor).toBeGreaterThan(opened.cursor);
      }),
    ),
  );

  it.effect("stands still on a poll that found nothing", () =>
    reading(
      Effect.gen(function* () {
        const reader = yield* TraceReader;
        const phaseId = makePhaseId(first, "prepare", 1);

        const drained = yield* reader.occurrences({ phaseId, since: beginning });
        expect(drained.occurrences).toHaveLength(3);

        // The whole reason the cursor is on the page: an idle poll that answered zero would send the
        // panel back to the first tool call every second.
        const idle = yield* reader.occurrences({ phaseId, since: drained.cursor });
        expect(idle.occurrences).toEqual([]);
        expect(idle.cursor).toBe(drained.cursor);
      }),
    ),
  );

  it.effect("gives one phase's occurrences and not the trace's", () =>
    reading(
      Effect.gen(function* () {
        const reader = yield* TraceReader;

        // The fixture interleaves another run's occurrence between two of this phase's, so a reader
        // that filtered after slicing — or numbered after filtering — is caught here.
        const page = yield* reader.occurrences({
          phaseId: makePhaseId(second, "elsewhere", 1),
          since: beginning,
        });
        expect(page.occurrences.map((record) => record.name)).toEqual(["cargo build"]);
      }),
    ),
  );
});

describe("the reader over what this process traced", () => {
  it.effect("sees records written after the layer was built", () =>
    Effect.gen(function* () {
      const tracer = yield* Tracer;
      const reader = yield* TraceReader;

      // Empty before anything is written, through the same reader value that answers below. A
      // service that snapshotted the recorded arrays when the layer was built would answer empty
      // here *and* after the write — a failure that looks exactly like "nothing was traced".
      expect(yield* reader.runs).toEqual([]);

      yield* tracer.runStarted(run(first, 500));
      yield* tracer.phase(phase(first, "prepare", 1_000));
      yield* tracer.occurrence(occurrence(first, "prepare", "bun install"));
      yield* tracer.runFinished(first, "succeeded");

      const runs = yield* reader.runs;
      expect(runs.map((summary) => summary.run.runId)).toEqual([first]);
      expect(runs[0]?.outcome).toBe("succeeded");
      // `RecordedTrace` keeps the outcome and not the moment it was written, and this adapter says
      // nothing rather than inventing a timestamp.
      expect(runs[0]?.finishedAt).toBeUndefined();

      const document = Option.getOrThrow(yield* reader.run(first));
      expect(document.phases.map((record) => record.name)).toEqual(["prepare"]);

      const page = yield* reader.occurrences({
        phaseId: makePhaseId(first, "prepare", 1),
        since: beginning,
      });
      expect(page.occurrences.map((record) => record.name)).toEqual(["bun install"]);
    }).pipe(
      Effect.provide(InMemoryTraceReader.layer.pipe(Layer.provideMerge(InMemoryTracer.layer))),
    ),
  );
});
