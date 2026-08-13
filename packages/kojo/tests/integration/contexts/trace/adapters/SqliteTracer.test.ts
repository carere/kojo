// `@effect/platform-bun` is imported below by deep path, never by its barrel: the barrel re-exports
// BunRedis, and loading it would end the run before a single test did anything.
import * as BunServices from "@effect/platform-bun/BunServices";
import { describe, expect, it } from "@effect/vitest";
import {
  Duration,
  Effect,
  FileSystem,
  Layer,
  Logger,
  type PlatformError,
  Schedule,
  Schema,
} from "effect";
import { SqlClient } from "effect/unstable/sql";
import { DurableDeferred } from "effect/unstable/workflow";
import { GateRecord } from "../../../../../src/contexts/gate/models/GateRecord.ts";
import * as SqliteDatabase from "../../../../../src/contexts/shared/adapters/SqliteDatabase.ts";
import { present } from "../../../../../src/contexts/shared/lib/present.ts";
import { makePhaseId } from "../../../../../src/contexts/shared/models/PhaseId.ts";
import type { RunId } from "../../../../../src/contexts/shared/models/RunId.ts";
import {
  makeSandboxId,
  type SandboxId,
} from "../../../../../src/contexts/shared/models/SandboxId.ts";
import * as SqliteTracer from "../../../../../src/contexts/trace/adapters/SqliteTracer.ts";
import { AgentCallRecord } from "../../../../../src/contexts/trace/models/AgentCallRecord.ts";
import { Occurrence } from "../../../../../src/contexts/trace/models/Occurrence.ts";
import { PhaseRecord } from "../../../../../src/contexts/trace/models/PhaseRecord.ts";
import { RepoEffect } from "../../../../../src/contexts/trace/models/RepoEffect.ts";
import { RunRecord } from "../../../../../src/contexts/trace/models/RunRecord.ts";
import { SandboxRecord } from "../../../../../src/contexts/trace/models/SandboxRecord.ts";
import { Verification } from "../../../../../src/contexts/trace/models/Verification.ts";
import { Tracer } from "../../../../../src/contexts/trace/ports/Tracer.ts";
import * as SingleNodeEngine from "../../../../../src/contexts/workflow/adapters/SingleNodeEngine.ts";
import { code } from "../../../../../src/contexts/workflow/services/phase/code.ts";
import {
  type RunStatus,
  start,
  status,
} from "../../../../../src/contexts/workflow/services/run.ts";
import { workflow } from "../../../../../src/contexts/workflow/services/workflow.ts";

/**
 * The trace as it lands on disk: one wide row per unit of work, in the file the engine already uses.
 *
 * The real adapter, on a real database, per the testing rule — no in-memory tracer appears here. The
 * last test is the reason this file needs the engine at all: a run that suspends and resumes replays
 * its whole body, and after that the *table* still holds one row per phase.
 *
 * Which is a claim about the table, not about where the `onExit` sits. The two are graded in two
 * places on purpose: the unit durability suite grades the placement, against arrays that have no
 * constraint to save them, and this file grades what the file on disk ends up holding — including
 * what happens when a duplicate is attempted anyway.
 */

const runId = "run-under-test" as RunId;

const phase = (options: {
  readonly name: string;
  readonly kind: "code" | "agent";
  readonly sandboxId?: string | undefined;
}) =>
  new PhaseRecord({
    runId,
    phaseId: makePhaseId(runId, options.name, 1),
    name: options.name,
    description: `the ${options.name} phase`,
    kind: options.kind,
    outcome: "succeeded",
    attempt: 1,
    startedAt: 1_000,
    endedAt: 3_500,
    ...present("sandboxId", options.sandboxId as SandboxId | undefined),
  });

/** Everything an agent phase knows, on one row: the call, the verdict, and the repository. */
const scouted = new PhaseRecord({
  ...phase({ name: "scout", kind: "agent", sandboxId: makeSandboxId(runId, "lane", 900, 1) }),
  agent: new AgentCallRecord({
    agent: "scout",
    model: "opus",
    session: "scout-session-1" as AgentCallRecord["session"],
    resumed: false,
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
});

const onOwnFile = <A, E>(
  use: (path: string) => Effect.Effect<A, E, SqlClient.SqlClient | Tracer | FileSystem.FileSystem>,
): Effect.Effect<A, E | PlatformError.PlatformError> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "kojo-trace-" });
    const path = `${root}/kojo.db`;
    return yield* use(path).pipe(
      Effect.provide(
        // One client under the writer, exactly as a factory builds it. The tracer migrates Kojo's
        // own schema through it and opens nothing of its own.
        Layer.orDie(SqliteTracer.layer).pipe(
          Layer.provideMerge(Layer.orDie(SqliteDatabase.layer({ path }))),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer));

const rows = <A extends object>(query: string) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe<A>(query));

describe("the trace on disk", () => {
  it.live("writes one wide row per unit of work, and the lists as one column each", () =>
    onOwnFile(() =>
      Effect.gen(function* () {
        const tracer = yield* Tracer;

        yield* tracer.runStarted(
          new RunRecord({
            runId,
            workflow: "lane",
            idempotencyKey: "lane/ticket-24",
            startedAt: 500,
            engineVersion: "0.0.0",
            engineCommit: "development",
            configDigest: "sha256:abc",
            host: "builder-1",
          }),
        );
        yield* tracer.phase(phase({ name: "prepare", kind: "code" }));
        yield* tracer.phase(scouted);
        yield* tracer.runFinished(runId, "succeeded");

        const runs = yield* rows<{
          readonly workflow: string;
          readonly idempotency_key: string;
          readonly config_digest: string;
          readonly host: string;
          readonly image_digest: string | null;
          readonly outcome: string | null;
          readonly finished_at: number | null;
        }>(`select * from ${SqliteTracer.tables.runs}`);

        // What produced the run, stamped where it cannot be reconstructed from anything else.
        expect(runs).toHaveLength(1);
        expect(runs[0]?.workflow).toBe("lane");
        expect(runs[0]?.idempotency_key).toBe("lane/ticket-24");
        expect(runs[0]?.config_digest).toBe("sha256:abc");
        expect(runs[0]?.host).toBe("builder-1");
        // Nothing resolves an image digest yet, and a null says so rather than inventing one.
        expect(runs[0]?.image_digest).toBeNull();
        // The run row is the mutable one: its status was written again when the body finished.
        expect(runs[0]?.outcome).toBe("succeeded");
        expect(runs[0]?.finished_at).not.toBeNull();

        const phases = yield* rows<{
          readonly name: string;
          readonly duration_millis: number;
          readonly model: string | null;
          readonly tokens_in: number | null;
          readonly context_tokens: number | null;
          readonly resumed: number | null;
          readonly envelope: string | null;
          readonly checks_ran: string | null;
          readonly checks_failed: string | null;
          readonly corrections: number | null;
          readonly correctable: number | null;
          readonly files_claimed: string | null;
          readonly files_changed: string | null;
          readonly commits: string | null;
        }>(`select * from ${SqliteTracer.tables.phases} order by id`);

        expect(phases.map((row) => row.name)).toEqual(["prepare", "scout"]);
        expect(phases[0]?.duration_millis).toBe(2_500);

        // A code phase has no agent half at all, and null is what says so — a zero would read as a
        // call that cost nothing.
        expect(phases[0]?.model).toBeNull();
        expect(phases[0]?.tokens_in).toBeNull();
        expect(phases[0]?.envelope).toBeNull();

        // The agent half is columns rather than a blob, because "which model burned the tokens" is
        // a `group by` and not a text scan.
        const agentRow = phases[1];
        expect(agentRow?.model).toBe("opus");
        expect(agentRow?.tokens_in).toBe(1_200);
        expect(agentRow?.context_tokens).toBe(8_800);
        expect(agentRow?.resumed).toBe(0);
        expect(agentRow?.envelope).toBe("Notes");
        expect(agentRow?.corrections).toBe(2);
        expect(agentRow?.correctable).toBe(1);

        // What is genuinely a list stays one column, and comes back as the list it went in as.
        expect(JSON.parse(agentRow?.checks_ran ?? "null")).toEqual([
          "diffMatchesClaims",
          "artifactsExist",
        ]);
        expect(JSON.parse(agentRow?.checks_failed ?? "null")).toEqual(["artifactsExist"]);
        expect(JSON.parse(agentRow?.files_claimed ?? "null")).toEqual(["src/health.ts"]);
        expect(JSON.parse(agentRow?.files_changed ?? "null")).toEqual([
          "src/health.ts",
          "src/other.ts",
        ]);
        expect(JSON.parse(agentRow?.commits ?? "null")).toEqual(["c0ffee"]);
      }),
    ).pipe(Effect.orDie),
  );

  it.live("answers which phases needed a container without a join", () =>
    onOwnFile(() =>
      Effect.gen(function* () {
        const tracer = yield* Tracer;
        const sandboxId = makeSandboxId(runId, "lane", 900, 1);

        yield* tracer.phase(phase({ name: "route", kind: "agent" }));
        yield* tracer.phase(phase({ name: "compile", kind: "code", sandboxId }));

        // The whole question, as one `where` clause on the phase table. No sandbox row is read, and
        // none is written by this test: the answer lives on the phase's own row.
        const needed = yield* rows<{ readonly name: string; readonly sandbox_id: string | null }>(
          `select name, sandbox_id from ${SqliteTracer.tables.phases} where sandbox_id is not null`,
        );
        expect(needed.map((row) => row.name)).toEqual(["compile"]);
        expect(needed[0]?.sandbox_id).toBe(sandboxId);
      }),
    ).pipe(Effect.orDie),
  );

  it.live("keeps one row per acquisition, and the human latency on the gate", () =>
    onOwnFile(() =>
      Effect.gen(function* () {
        const tracer = yield* Tracer;

        // Two acquisitions of one scope: what a run that suspends at a gate actually does.
        for (const [sequence, outcome] of [
          [1, "interrupted"],
          [2, "released"],
        ] as const) {
          yield* tracer.sandbox(
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
              outcome,
            }),
          );
        }

        yield* tracer.gate(
          new GateRecord({
            runId,
            gate: "review",
            asking: "gate/review/1",
            token: "token-1" as GateRecord["token"],
            description: "Does this land?",
            actor: "engineer",
            choices: ["approve", "reject"],
            requestedAt: 1_000,
            deadlineAt: 605_800_000,
            onExpiry: "fail",
            outcome: "answered",
            answerer: "kevin",
            choice: "approve",
            reason: "reads fine",
            answeredAt: 173_800_000,
          }),
        );
        yield* tracer.gate(
          new GateRecord({
            runId,
            gate: "merge",
            asking: "gate/merge/1",
            token: "token-2" as GateRecord["token"],
            description: "Land it?",
            actor: "engineer",
            choices: ["merge"],
            requestedAt: 2_000,
            deadlineAt: 605_800_000,
            onExpiry: "fail",
            outcome: "expired",
          }),
        );

        const sandboxes = yield* rows<{
          readonly sandbox_id: string;
          readonly lifetime_millis: number;
          readonly outcome: string;
          readonly environment: string;
        }>(`select * from ${SqliteTracer.tables.sandboxes} order by id`);

        // Two rows, two ids, and the first one's outcome is what a suspension leaves behind. One row
        // per scope would hide the rebuild, which is the price of the design's central decision.
        expect(sandboxes).toHaveLength(2);
        expect(new Set(sandboxes.map((row) => row.sandbox_id)).size).toBe(2);
        expect(sandboxes.map((row) => row.outcome)).toEqual(["interrupted", "released"]);
        expect(sandboxes[0]?.lifetime_millis).toBe(400);
        expect(JSON.parse(sandboxes[0]?.environment ?? "null")).toEqual({ KOJO_RUN_ID: runId });

        const gates = yield* rows<{
          readonly gate: string;
          readonly latency_millis: number | null;
        }>(`select * from ${SqliteTracer.tables.gates} order by id`);

        // Human latency as a column, so no reader has to remember the subtraction — and null, not
        // zero, on the asking nobody answered.
        expect(gates.map((row) => row.gate)).toEqual(["review", "merge"]);
        expect(gates[0]?.latency_millis).toBe(173_799_000);
        expect(gates[1]?.latency_millis).toBeNull();
      }),
    ).pipe(Effect.orDie),
  );

  it.live("gives a polling reader a cursor it can advance", () =>
    onOwnFile(() =>
      Effect.gen(function* () {
        const tracer = yield* Tracer;
        const phaseId = makePhaseId(runId, "build", 1);

        for (const name of ["bun install", "bun test", "git commit"]) {
          yield* tracer.occurrence(
            new Occurrence({
              runId,
              phaseId,
              kind: "exec",
              name,
              startedAt: 1_000,
              endedAt: 1_250,
              outcome: "succeeded",
            }),
          );
        }

        // The transport rule, inherited exactly: poll on a monotonic cursor. `select *` would never
        // return SQLite's implicit rowid, so a reader would get no cursor and re-read row one
        // forever — which is why the table names its primary key.
        const first = yield* rows<{ readonly id: number; readonly name: string }>(
          `select * from ${SqliteTracer.tables.occurrences} where id > 0 order by id limit 2`,
        );
        expect(first.map((row) => row.name)).toEqual(["bun install", "bun test"]);

        const cursor = first[first.length - 1]?.id ?? 0;
        expect(cursor).toBeGreaterThan(0);

        const next = yield* rows<{ readonly id: number; readonly name: string }>(
          `select * from ${SqliteTracer.tables.occurrences} where id > ${cursor} order by id`,
        );
        expect(next.map((row) => row.name)).toEqual(["git commit"]);
      }),
    ).pipe(Effect.orDie),
  );

  it.live("refuses a second row for one phase, and does not take the run down over it", () =>
    onOwnFile(() =>
      Effect.gen(function* () {
        const tracer = yield* Tracer;
        const written = phase({ name: "prepare", kind: "code" });

        const logged: Array<string> = [];
        const collector = Logger.make((options: Logger.Options<unknown>) => {
          if (options.logLevel === "Error") logged.push(String(options.message));
        });

        // The same phase, written twice — what a body would do if its `onExit` sat outside the
        // activity and a resumed run replayed it.
        yield* Effect.provide(
          Effect.andThen(tracer.phase(written), tracer.phase(written)),
          Logger.layer([collector]),
        );

        // One row, because `phase_id` is unique. The trace does not gain a row per replay even if
        // something upstream loses the placement that stops the second write being attempted.
        const phases = yield* rows<{ readonly name: string }>(
          `select * from ${SqliteTracer.tables.phases}`,
        );
        expect(phases.map((row) => row.name)).toEqual(["prepare"]);

        // And the refusal was loud rather than silent: the write is swallowed so a lost row cannot
        // end a run — the trace is observability — but it says so at error level, with its cause.
        expect(logged).toHaveLength(1);
        expect(logged[0]).toContain("prepare");
      }),
    ).pipe(Effect.orDie),
  );

  it.live("migrates under Kojo's own ledger, beside the cluster's", () =>
    onOwnFile(() =>
      Effect.gen(function* () {
        const names = yield* rows<{ readonly name: string }>(
          "select name from sqlite_master where type = 'table' order by name",
        );
        const present = names.map((row) => row.name);
        for (const table of Object.values(SqliteTracer.tables)) {
          expect(present).toContain(table);
        }

        // Named rather than inherited: the package default is `effect_sql_migrations`, and the
        // cluster overrides that default with a name of its own.
        expect(present).toContain(SqliteDatabase.migrationsTable);

        // The loader splits a key into its number and its name, so `0001_trace` is stored as id 1
        // named `trace`. The ledger records that a migration ran, not what it said — which is why a
        // shipped migration is never edited and a change ships as the next number.
        const applied = yield* rows<{
          readonly migration_id: number;
          readonly name: string;
        }>(`select * from ${SqliteDatabase.migrationsTable} order by migration_id`);
        expect(applied.map((row) => `${row.migration_id}_${row.name}`)).toEqual([
          "1_trace",
          "2_in_flight",
          "3_asking_settlement",
        ]);
        expect(applied).toHaveLength(Object.keys(SqliteTracer.migrations).length);
      }),
    ).pipe(Effect.orDie),
  );

  it.live("adds the settlement column to an askings table written before it existed", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "kojo-trace-" });
      const path = `${root}/kojo.db`;

      // The file as wave 14 left it: `kojo_asked_gates` exists — its layer creates it outside the
      // ledger — and it has never heard of `expired_at`.
      yield* Effect.provide(
        Effect.flatMap(SqlClient.SqlClient, (sql) =>
          sql.unsafe(`
            create table kojo_asked_gates (
              token         text primary key,
              run_id        text    not null,
              gate          text    not null,
              asking        text    not null,
              description   text    not null,
              actor         text    not null,
              choices       text    not null,
              requested_at  integer not null,
              deadline_at   integer not null,
              on_expiry     text    not null,
              answerer      text,
              choice        text,
              reason        text,
              answered_at   integer
            )
          `),
        ),
        Layer.orDie(SqliteDatabase.layer({ path })),
      ).pipe(Effect.orDie);

      // The next write command opens the file and migrates. `0003` has to meet this table with
      // `alter`, because `create table if not exists` is a no-op against it.
      const columns = yield* Effect.provide(
        rows<{ readonly name: string }>("pragma table_info(kojo_asked_gates)"),
        Layer.orDie(SqliteTracer.layer).pipe(
          Layer.provideMerge(Layer.orDie(SqliteDatabase.layer({ path }))),
        ),
      ).pipe(Effect.orDie);

      expect(columns.map((column) => column.name)).toContain("expired_at");
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.orDie),
  );
});

/** One durable deferred, so the run below stops without needing a person or a terminal. */
const paused = DurableDeferred.make("paused", { success: Schema.String });

const ran = (name: string) =>
  code(
    { name, description: `the ${name} step`, success: Schema.Void, error: Schema.Never },
    Effect.void,
  );

/** A run that stops in the middle, on the real engine, writing to the real trace. */
const traced = workflow(
  {
    name: "traced",
    payload: { subject: Schema.String },
    success: Schema.String,
    error: Schema.Never,
    idempotencyKey: (payload) => `traced/${payload.subject}`,
  },
  () =>
    Effect.gen(function* () {
      yield* ran("prepare");
      const verdict = yield* DurableDeferred.await(paused);
      yield* ran("land");
      return verdict;
    }),
);

/**
 * The engine and the trace on one file and one client.
 *
 * The poll intervals are the cluster's own defaults compressed: ten seconds is right for a factory
 * and wrong for a test that would otherwise wait ten seconds to notice an answer it just wrote.
 */
const durably = (path: string) =>
  traced.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.orDie(SqliteTracer.layer),
        SingleNodeEngine.layer({
          shardingConfig: {
            entityMessagePollInterval: Duration.millis(100),
            entityReplyPollInterval: Duration.millis(100),
            refreshAssignmentsInterval: Duration.millis(100),
          },
        }),
      ),
    ),
    Layer.provideMerge(Layer.orDie(SqliteDatabase.layer({ path }))),
  );

const waitFor = (id: RunId, wanted: ReadonlyArray<RunStatus>) =>
  Effect.repeat(status(traced.definition, id), {
    schedule: Schedule.spaced(Duration.millis(50)),
    until: (reported: RunStatus) => wanted.includes(reported),
    times: 200,
  });

describe("a run that suspended and resumed", () => {
  it.live("leaves one row per phase, not one per replay", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "kojo-trace-run-" });

      yield* Effect.gen(function* () {
        const id = yield* start(traced.definition, { subject: "one" });
        expect(yield* waitFor(id, ["suspended"])).toBe("suspended");

        yield* DurableDeferred.succeed(paused, {
          token: DurableDeferred.tokenFromExecutionId(paused, {
            workflow: traced.definition,
            executionId: id,
          }),
          value: "approve",
        });
        expect(yield* waitFor(id, ["succeeded", "failed"])).toBe("succeeded");

        const phases = yield* rows<{ readonly name: string; readonly attempt: number }>(
          `select * from ${SqliteTracer.tables.phases} order by id`,
        );

        // The body executed twice — once before the wait and once on the resume — and the table
        // holds one row per phase.
        //
        // Be precise about what this grades. It proves the *table*, not the placement: the unique
        // constraint on `phase_id` means a second write would be refused and logged rather than
        // land, so this assertion cannot tell "not written twice" from "written twice and refused".
        // What grades the placement is the duplicate-row test in the unit durability suite, where
        // the tracer is an array with no constraint to save it.
        expect(phases.map((row) => row.name)).toEqual(["prepare", "land"]);
        expect(phases.map((row) => row.attempt)).toEqual([1, 1]);

        // One run row for a run that started once, and a run row that is not still claiming to be
        // suspended now that it has finished.
        const runs = yield* rows<{ readonly run_id: string; readonly outcome: string | null }>(
          `select * from ${SqliteTracer.tables.runs}`,
        );
        expect(runs).toHaveLength(1);
        expect(runs[0]?.run_id).toBe(id);
        expect(runs[0]?.outcome).toBe("succeeded");

        // A phase on the host records no sandbox, so the container question stays answerable.
        const hosted = yield* rows<{ readonly count: number }>(
          `select count(*) as count from ${SqliteTracer.tables.phases} where sandbox_id is null`,
        );
        expect(hosted[0]?.count).toBe(2);
      }).pipe(Effect.provide(durably(`${root}/kojo.db`)));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer), Effect.orDie),
  );
});
