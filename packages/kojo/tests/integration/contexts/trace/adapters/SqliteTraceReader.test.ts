// Deep path, never the package barrel: the barrel re-exports BunRedis, which imports the `bun`
// builtin and would end this worker before a single test ran.
import * as BunServices from "@effect/platform-bun/BunServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option, type PlatformError } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { GateRecord } from "../../../../../src/contexts/gate/models/GateRecord.ts";
import * as SqliteDatabase from "../../../../../src/contexts/shared/adapters/SqliteDatabase.ts";
import { PathRollback } from "../../../../../src/contexts/shared/models/PathRollback.ts";
import { makePhaseId } from "../../../../../src/contexts/shared/models/PhaseId.ts";
import type { RunId } from "../../../../../src/contexts/shared/models/RunId.ts";
import { makeSandboxId } from "../../../../../src/contexts/shared/models/SandboxId.ts";
import * as SqliteTraceReader from "../../../../../src/contexts/trace/adapters/SqliteTraceReader.ts";
import * as SqliteTracer from "../../../../../src/contexts/trace/adapters/SqliteTracer.ts";
import { AgentCallRecord } from "../../../../../src/contexts/trace/models/AgentCallRecord.ts";
import { InFlightPhase } from "../../../../../src/contexts/trace/models/InFlightPhase.ts";
import { Occurrence } from "../../../../../src/contexts/trace/models/Occurrence.ts";
import { beginning } from "../../../../../src/contexts/trace/models/OccurrencePage.ts";
import { PhaseRecord } from "../../../../../src/contexts/trace/models/PhaseRecord.ts";
import { RepoEffect } from "../../../../../src/contexts/trace/models/RepoEffect.ts";
import { RunRecord } from "../../../../../src/contexts/trace/models/RunRecord.ts";
import { SandboxRecord } from "../../../../../src/contexts/trace/models/SandboxRecord.ts";
import { TraceReadError } from "../../../../../src/contexts/trace/models/TraceReadError.ts";
import { Verification } from "../../../../../src/contexts/trace/models/Verification.ts";
import { TraceReader } from "../../../../../src/contexts/trace/ports/TraceReader.ts";
import { Tracer } from "../../../../../src/contexts/trace/ports/Tracer.ts";

/**
 * The query side against the file the writer actually wrote.
 *
 * Both adapters are real, per the testing rule, and both are over **one** client — which is what
 * makes this a reader of what the writer wrote rather than of its own memory. What is graded is the
 * round trip: a record goes in through `Tracer`, comes back through `TraceReader`, and has to be
 * the same record. Column names, null handling and the reassembly of the three nested blocks all
 * fail here if they are wrong, and none of them fails anywhere else.
 */

const runId = "run-under-read" as RunId;
const older = "run-older" as RunId;

const run = (id: RunId, startedAt: number) =>
  new RunRecord({
    runId: id,
    workflow: "lane",
    idempotencyKey: `lane/${id}`,
    startedAt,
    engineVersion: "0.0.0",
    engineCommit: "development",
    configDigest: "sha256:abc",
    host: "builder-1",
  });

/** Everything a phase can hold: the agent half, the verdict, the repository, and a breach. */
const scouted = new PhaseRecord({
  runId,
  phaseId: makePhaseId(runId, "scout", 1),
  name: "scout",
  description: "the scout phase",
  kind: "agent",
  outcome: "failed",
  attempt: 1,
  startedAt: 1_000,
  endedAt: 3_500,
  sandboxId: makeSandboxId(runId, "lane", 900, 1),
  errorTag: "CheckViolation",
  agent: new AgentCallRecord({
    agent: "scout",
    model: "opus",
    session: "scout-session-1" as AgentCallRecord["session"],
    resumed: true,
    tokensIn: 1_200,
    tokensOut: 340,
    contextTokens: 8_800,
  }),
  verification: new Verification({
    envelope: "Notes",
    ran: ["diffMatchesClaims", "artifactsExist"],
    failed: ["artifactsExist"],
    corrections: 2,
    correctable: true,
  }),
  repo: new RepoEffect({
    claimed: ["src/health.ts"],
    changed: ["src/health.ts", "src/other.ts"],
    commits: ["c0ffee"],
  }),
  breaches: [
    new PathRollback({ path: ".github/workflows/ci.yml", outcome: { _tag: "Restored" } }),
    new PathRollback({ path: "secrets.env", outcome: { _tag: "NotUndone", reason: "read-only" } }),
  ],
});

/** A code phase on the host: every optional block absent, which is the other half of the contract. */
const prepared = new PhaseRecord({
  runId,
  phaseId: makePhaseId(runId, "prepare", 1),
  name: "prepare",
  description: "the prepare phase",
  kind: "code",
  outcome: "succeeded",
  attempt: 1,
  startedAt: 500,
  endedAt: 700,
});

const answered = new GateRecord({
  runId,
  gate: "review",
  asking: "gate/review/1",
  token: "token-1" as GateRecord["token"],
  description: "Does this land?",
  actor: "engineer",
  choices: ["approve", "reject"],
  requestedAt: 4_000,
  deadlineAt: 605_800_000,
  onExpiry: "fail",
  outcome: "answered",
  answerer: "kevin",
  choice: "approve",
  reason: "reads fine",
  answeredAt: 173_800_000,
});

const acquired = (sequence: number) =>
  new SandboxRecord({
    runId,
    sandboxId: makeSandboxId(runId, "lane", 900 * sequence, sequence),
    name: "lane",
    provider: "docker",
    kind: "bind-mount",
    branch: "kojo/lane",
    worktreePath: "/worktrees/kojo/lane",
    environment: { KOJO_RUN_ID: runId },
    acquiredAt: 1_000 * sequence,
    releasedAt: 1_000 * sequence + 400,
    outcome: sequence === 1 ? "interrupted" : "released",
  });

/**
 * The writer and the reader on one file and one client.
 *
 * `provideMerge` and not a merge: the writer owns the schema, so its migrations must have run
 * before the reader asks anything. The reader itself migrates nothing — reading must never be an
 * act of writing.
 */
const onOwnFile = <A, E>(
  use: Effect.Effect<A, E, Tracer | TraceReader | SqlClient.SqlClient | FileSystem.FileSystem>,
): Effect.Effect<A, E | PlatformError.PlatformError> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "kojo-trace-read-" });

    return yield* use.pipe(
      Effect.provide(
        SqliteTraceReader.layer.pipe(
          Layer.provideMerge(Layer.orDie(SqliteTracer.layer)),
          Layer.provideMerge(Layer.orDie(SqliteDatabase.layer({ path: `${root}/kojo.db` }))),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer));

/** Everything the fixture is about, written through the real writer. */
const written = Effect.gen(function* () {
  const tracer = yield* Tracer;
  yield* tracer.runStarted(run(older, 100));
  yield* tracer.runFinished(older, "failed");
  yield* tracer.runStarted(run(runId, 500));
  yield* tracer.phase(scouted);
  yield* tracer.phase(prepared);
  yield* tracer.gate(answered);
  yield* tracer.sandbox(acquired(2));
  yield* tracer.sandbox(acquired(1));
});

describe("the run list on disk", () => {
  it.live("answers newest first, with the mutable half of the run row", () =>
    onOwnFile(
      Effect.gen(function* () {
        yield* written;
        const reader = yield* TraceReader;
        const runs = yield* reader.runs;

        expect(runs.map((summary) => summary.run.runId)).toEqual([runId, older]);

        // A run that has never stopped has no outcome, and absent is not `suspended`: one is a run
        // executing right now, the other is a run waiting for a person.
        expect(runs[0]?.outcome).toBeUndefined();
        expect(runs[0]?.finishedAt).toBeUndefined();
        expect(runs[0]?.terminal).toBe(false);

        // And the run the writer stamped carries both halves of the stamp.
        expect(runs[1]?.outcome).toBe("failed");
        expect(runs[1]?.finishedAt).toBeGreaterThan(0);
        expect(runs[1]?.terminal).toBe(true);

        // What produced the run, read back off the immutable half of the row.
        expect(runs[1]?.run.idempotencyKey).toBe(`lane/${older}`);
        expect(runs[1]?.run.configDigest).toBe("sha256:abc");
        expect(runs[1]?.run.imageDigest).toBeUndefined();
      }),
    ).pipe(Effect.orDie),
  );
});

describe("one whole run document", () => {
  it.live("rebuilds the wide phase row, nested blocks and all", () =>
    onOwnFile(
      Effect.gen(function* () {
        yield* written;
        const reader = yield* TraceReader;
        const document = Option.getOrThrow(yield* reader.run(runId));

        expect(document.phases.map((phase) => phase.name)).toEqual(["prepare", "scout"]);

        // The wide row is one record again: six agent columns back into one block, five verdict
        // columns into another, three JSON lists into a third. Every one of these is a column name
        // that is only ever checked here.
        const scout = document.phases[1];
        expect(scout?.agent?.model).toBe("opus");
        expect(scout?.agent?.session).toBe("scout-session-1");
        expect(scout?.agent?.resumed).toBe(true);
        expect(scout?.agent?.tokensIn).toBe(1_200);
        expect(scout?.agent?.contextTokens).toBe(8_800);
        expect(scout?.verification?.envelope).toBe("Notes");
        expect(scout?.verification?.ran).toEqual(["diffMatchesClaims", "artifactsExist"]);
        expect(scout?.verification?.failed).toEqual(["artifactsExist"]);
        expect(scout?.verification?.corrections).toBe(2);
        expect(scout?.verification?.correctable).toBe(true);
        expect(scout?.repo?.claimed).toEqual(["src/health.ts"]);
        expect(scout?.repo?.changed).toEqual(["src/health.ts", "src/other.ts"]);
        expect(scout?.repo?.commits).toEqual(["c0ffee"]);
        expect(scout?.errorTag).toBe("CheckViolation");
        expect(scout?.sandboxId).toBe(makeSandboxId(runId, "lane", 900, 1));
        expect(scout?.durationMillis).toBe(2_500);

        // The breaches come back as the tagged union they went in as, `reason` and all — a JSON
        // column decoded through the schema rather than handed over as parsed JSON.
        expect(scout?.breaches?.map((breach) => breach.outcome._tag)).toEqual([
          "Restored",
          "NotUndone",
        ]);
        expect(scout?.breaches?.[1]?.outcome).toEqual({ _tag: "NotUndone", reason: "read-only" });

        // A code phase on the host has none of the three blocks, and absent is what says so. A
        // reader that defaulted a missing column would report an agent call that never happened.
        const prepare = document.phases[0];
        expect(prepare?.agent).toBeUndefined();
        expect(prepare?.verification).toBeUndefined();
        expect(prepare?.repo).toBeUndefined();
        expect(prepare?.breaches).toBeUndefined();
        expect(prepare?.sandboxId).toBeUndefined();
        expect(prepare?.errorTag).toBeUndefined();
      }),
    ).pipe(Effect.orDie),
  );

  it.live("carries the settled askings and every acquisition, oldest first", () =>
    onOwnFile(
      Effect.gen(function* () {
        yield* written;
        const reader = yield* TraceReader;
        const document = Option.getOrThrow(yield* reader.run(runId));

        expect(document.gates.map((gate) => gate.gate)).toEqual(["review"]);
        expect(document.gates[0]?.choices).toEqual(["approve", "reject"]);
        expect(document.gates[0]?.answerer).toBe("kevin");
        expect(Option.getOrThrow(document.gates[0]?.latencyMillis ?? Option.none())).toBe(
          173_796_000,
        );

        // Written second first, and read back in the order they happened: the gap between two rows
        // of one scope is what the rebuild after a gate cost.
        expect(document.sandboxes.map((sandbox) => sandbox.outcome)).toEqual([
          "interrupted",
          "released",
        ]);
        expect(document.sandboxes[0]?.environment).toEqual({ KOJO_RUN_ID: runId });
        expect(document.sandboxes[0]?.lifetimeMillis).toBe(400);
      }),
    ).pipe(Effect.orDie),
  );

  it.live("carries the phase a run is inside, and drops it when the record replaces it", () =>
    onOwnFile(
      Effect.gen(function* () {
        const tracer = yield* Tracer;
        const reader = yield* TraceReader;
        yield* tracer.runStarted(run(runId, 500));

        const entered = new InFlightPhase({
          phaseId: makePhaseId(runId, "prepare", 1),
          name: "prepare",
          kind: "code",
          attempt: 1,
          startedAt: 500,
          sandboxId: makeSandboxId(runId, "lane", 900, 1),
        });
        yield* tracer.phaseEntered(runId, entered);

        // Six columns on the run row, read back as one value. This is the only place the column
        // names on either side of adr/trace/0002 are checked against each other.
        const running = Option.getOrThrow(yield* reader.run(runId)).run.inFlight;
        expect(running?.phaseId).toBe(makePhaseId(runId, "prepare", 1));
        expect(running?.name).toBe("prepare");
        expect(running?.kind).toBe("code");
        expect(running?.attempt).toBe(1);
        expect(running?.startedAt).toBe(500);
        expect(running?.sandboxId).toBe(makeSandboxId(runId, "lane", 900, 1));
        // And a live run has no phase record for it yet, which is the whole reason the column is here.
        expect(Option.getOrThrow(yield* reader.run(runId)).phases).toEqual([]);

        yield* tracer.phase(prepared);

        const after = Option.getOrThrow(yield* reader.run(runId));
        expect(after.phases.map((phase) => phase.name)).toEqual(["prepare"]);
        // Cleared by the record that replaced it. A row still claiming to be inside a phase whose
        // record exists would make the Console draw the same phase twice — once finished, once
        // growing forever.
        expect(after.run.inFlight).toBeUndefined();
      }),
    ).pipe(Effect.orDie),
  );

  it.live("answers None for a run the file has never held", () =>
    onOwnFile(
      Effect.gen(function* () {
        yield* written;
        const reader = yield* TraceReader;
        expect(yield* reader.run("run-typo" as RunId)).toStrictEqual(Option.none());
      }),
    ).pipe(Effect.orDie),
  );
});

describe("the cursor over real row ids", () => {
  it.live("advances past what it has been given, and stands still when there is nothing", () =>
    onOwnFile(
      Effect.gen(function* () {
        const tracer = yield* Tracer;
        const reader = yield* TraceReader;
        const phaseId = makePhaseId(runId, "build", 1);
        const elsewhere = makePhaseId(older, "build", 1);

        const record = (phase: typeof phaseId, name: string) =>
          tracer.occurrence(
            new Occurrence({
              runId,
              phaseId: phase,
              kind: "exec",
              name,
              startedAt: 1_000,
              endedAt: 1_250,
              outcome: "succeeded",
            }),
          );

        yield* record(phaseId, "bun install");
        // Another phase's row, interleaved, so a cursor that ignored the phase would pick it up.
        yield* record(elsewhere, "cargo build");
        yield* record(phaseId, "bun test");

        const opened = yield* reader.occurrences({ phaseId, since: beginning, limit: 1 });
        expect(opened.occurrences.map((row) => row.name)).toEqual(["bun install"]);
        expect(opened.cursor).toBeGreaterThan(beginning);

        const next = yield* reader.occurrences({ phaseId, since: opened.cursor });
        expect(next.occurrences.map((row) => row.name)).toEqual(["bun test"]);
        // The cursor is the row id, so it jumps over the other phase's row rather than counting.
        expect(next.cursor).toBeGreaterThan(opened.cursor + 1);

        const idle = yield* reader.occurrences({ phaseId, since: next.cursor });
        expect(idle.occurrences).toEqual([]);
        expect(idle.cursor).toBe(next.cursor);

        // The whole point of naming the primary key: a reader that got no cursor would re-read the
        // first row forever, and this is what proves it does not.
        yield* record(phaseId, "git commit");
        const later = yield* reader.occurrences({ phaseId, since: idle.cursor });
        expect(later.occurrences.map((row) => row.name)).toEqual(["git commit"]);
      }),
    ).pipe(Effect.orDie),
  );
});

describe("a row the schema refuses", () => {
  it.live("fails in the typed channel rather than answering something wrong", () =>
    onOwnFile(
      Effect.gen(function* () {
        yield* written;
        const sql = yield* SqlClient.SqlClient;
        const reader = yield* TraceReader;

        // A value no version of this writer produces, put there the way an older or a newer engine
        // would: straight into the column. This is the case a cast cannot cover — the reader would
        // hand the Console a fourth run state and nothing would notice until the UI drew it.
        yield* sql.unsafe(
          `update ${SqliteTracer.tables.runs} set outcome = 'exploded' where run_id = '${older}'`,
        );

        const failure = yield* reader.runs.pipe(
          Effect.flip,
          Effect.mapError(() => new Error("the reader accepted a state that is not a run state")),
          Effect.orDie,
        );

        expect(failure).toBeInstanceOf(TraceReadError);
        expect(failure.operation).toBe("runs");
        // And the reason names the column and what was expected of it, because it is a schema issue
        // rather than a driver error — which is the whole value of decoding rather than casting.
        expect(failure.reason).toContain("outcome");
        expect(failure.reason).toContain('"succeeded" | "failed" | "suspended"');
      }),
    ).pipe(Effect.orDie),
  );
});
