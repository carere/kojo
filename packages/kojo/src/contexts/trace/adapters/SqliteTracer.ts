import { Clock, Effect, Layer } from "effect";
import type { Migrator, SqlError } from "effect/unstable/sql";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { settlementMigration } from "../../gate/adapters/SqliteGateRepository.ts";
import { GateRecord } from "../../gate/models/GateRecord.ts";
import * as SqliteDatabase from "../../shared/adapters/SqliteDatabase.ts";
import type { RunId } from "../../shared/models/RunId.ts";
import type { InFlightPhase } from "../models/InFlightPhase.ts";
import { Occurrence } from "../models/Occurrence.ts";
import { PhaseRecord } from "../models/PhaseRecord.ts";
import { type RunOutcome, RunRecord } from "../models/RunRecord.ts";
import { SandboxRecord } from "../models/SandboxRecord.ts";
import { Tracer } from "../ports/Tracer.ts";

/**
 * The trace, in the one SQLite file the engine already writes its own state to.
 *
 * Five tables, one wide row per unit of work, written once. Everything about the shape follows from
 * that rule, and the things that make it survivable are recorded beside the code that needs them:
 *
 * - **The tables are prefixed.** The engine's cluster storage shares this file and names its own
 *   tables `cluster_*`, and Kojo's ledger is `kojo_migrations`. An unprefixed `runs` in a file that
 *   also holds a cluster's schema is a collision waiting for whichever package adds the name second.
 * - **Every table has an explicit `INTEGER PRIMARY KEY` named `id`.** `select *` never expands
 *   SQLite's implicit rowid, so a Console polling for new rows would get no cursor to advance and
 *   re-read row one forever. Naming the column is what makes `... where id > ?` possible at all, and
 *   the occurrences table is the one that genuinely needs it.
 * - **Nothing here opens a database.** The client is the shared one from ticket 10 — two layers on
 *   one path are two `bun:sqlite` handles with two independent write serializers, and the driver's
 *   serialization does not span them. Build `SqliteDatabase.layer` once and provide it to the
 *   engine and to this together.
 *
 * The wide-row rule shapes the columns too. The agent's half of a phase is six columns rather than
 * a JSON blob, because "which model burned the tokens" is a `group by`, not a text scan; the lists
 * that are genuinely lists — the checks, the claimed and changed paths, the breached paths and what
 * became of each — are JSON in one column, because a second table for them would be the join this
 * whole design exists to avoid.
 */

/** Every table this adapter owns. Named here so a reader — ticket 25 — has one place to read. */
export const tables = {
  runs: "kojo_runs",
  phases: "kojo_phases",
  gates: "kojo_gates",
  sandboxes: "kojo_sandboxes",
  occurrences: "kojo_occurrences",
} as const;

/**
 * The schema, as explicit migrations that only ever add.
 *
 * Additive for our own reader's sake: a Console built against an older engine keeps working when the
 * factory upgrades under it, because a column it does not know about is a column it does not select.
 * Never edit a migration that has shipped — the ledger records that it ran, not what it said, so a
 * changed body silently applies to new databases only.
 *
 * A migration that fails is `Effect.die` rather than a typed error, and its ledger row is inserted
 * *before* its body runs. Two processes migrating at once is therefore a real race, which is why the
 * shared client sets a busy timeout the driver leaves at zero.
 */
export const migrations: Record<string, Effect.Effect<void, unknown, SqlClient.SqlClient>> = {
  "0001_trace": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    // The run row is the only mutable one: it is stamped with what produced the run, and its
    // outcome is written again each time the body stops — `suspended` for as long as a human is
    // thinking, and a terminal answer when one arrives.
    yield* sql`
      create table if not exists ${sql(tables.runs)} (
        id integer primary key,
        run_id text not null unique,
        workflow text not null,
        idempotency_key text not null,
        started_at integer not null,
        engine_version text not null,
        engine_commit text not null,
        config_digest text not null,
        host text not null,
        image_digest text,
        outcome text,
        finished_at integer
      )
    `;

    // `phase_id` is unique, deliberately. The write sits inside the activity, so a resumed run
    // hands back the recorded result instead of writing again — and if that ever stops being true,
    // this constraint is what says so instead of the trace quietly gaining a row per replay.
    yield* sql`
      create table if not exists ${sql(tables.phases)} (
        id integer primary key,
        run_id text not null,
        phase_id text not null unique,
        name text not null,
        description text not null,
        kind text not null,
        outcome text not null,
        attempt integer not null,
        started_at integer not null,
        ended_at integer not null,
        duration_millis integer not null,
        error_tag text,
        sandbox_id text,
        agent text,
        model text,
        session text,
        resumed integer,
        tokens_in integer,
        tokens_out integer,
        context_tokens integer,
        envelope text,
        checks_ran text,
        checks_failed text,
        corrections integer,
        correctable integer,
        files_claimed text,
        files_changed text,
        commits text,
        breaches text
      )
    `;
    yield* sql`create index if not exists ${sql(`${tables.phases}_run`)} on ${sql(tables.phases)} (run_id)`;

    // One row per **asking**, carrying the latency as a column rather than as a subtraction every
    // reader has to remember to make. A gate that nobody answered has none, and a null is the
    // honest answer there — zero would read as an instant decision.
    yield* sql`
      create table if not exists ${sql(tables.gates)} (
        id integer primary key,
        run_id text not null,
        gate text not null,
        asking text not null,
        token text not null,
        description text not null,
        actor text not null,
        choices text not null,
        requested_at integer not null,
        deadline_at integer not null,
        on_expiry text not null,
        outcome text not null,
        answerer text,
        choice text,
        reason text,
        answered_at integer,
        latency_millis integer,
        unique (run_id, asking)
      )
    `;

    // One row per **acquisition**. A run that suspends at a gate tears its container down and builds
    // another on resume, and both are facts: the gap between two rows of one scope is what the
    // rebuild cost.
    yield* sql`
      create table if not exists ${sql(tables.sandboxes)} (
        id integer primary key,
        run_id text not null,
        sandbox_id text not null unique,
        name text not null,
        provider text not null,
        kind text not null,
        branch text not null,
        worktree_path text not null,
        environment text not null,
        acquired_at integer not null,
        released_at integer not null,
        lifetime_millis integer not null,
        outcome text not null
      )
    `;

    // The subordinate table, and the only one with many rows per unit of work. `id` is the cursor a
    // reader advances; nothing else in the trace needs one, because everything else is answerable
    // from a row a human can find by run.
    yield* sql`
      create table if not exists ${sql(tables.occurrences)} (
        id integer primary key,
        run_id text not null,
        phase_id text not null,
        kind text not null,
        name text not null,
        started_at integer not null,
        ended_at integer not null,
        duration_millis integer not null,
        outcome text not null,
        detail text
      )
    `;
    yield* sql`create index if not exists ${sql(`${tables.occurrences}_phase`)} on ${sql(tables.occurrences)} (phase_id)`;
  }),

  /**
   * The in-flight phase, on the run row — the migration ticket 24 said would follow.
   *
   * adr/trace/0002 puts the run's *current* phase beside its outcome, because a phase record is
   * written on exit and a run that has been executing one phase for four minutes therefore has
   * nothing a Console can draw. Five columns rather than a JSON blob, for the same reason the agent's
   * half of a phase is six: they are all written together and all cleared together, so a reader takes
   * them all or none.
   *
   * `alter table add column` and nothing else. The migrations are additive so that a Console built
   * against an older engine keeps working when the factory upgrades under it, and every one of these
   * columns is nullable — an older writer that never fills them leaves a run whose in-flight phase is
   * absent, which is exactly what a finished run looks like anyway.
   */
  "0002_in_flight": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`alter table ${sql(tables.runs)} add column in_flight_phase_id text`;
    yield* sql`alter table ${sql(tables.runs)} add column in_flight_name text`;
    yield* sql`alter table ${sql(tables.runs)} add column in_flight_kind text`;
    yield* sql`alter table ${sql(tables.runs)} add column in_flight_attempt integer`;
    yield* sql`alter table ${sql(tables.runs)} add column in_flight_started_at integer`;
    yield* sql`alter table ${sql(tables.runs)} add column in_flight_sandbox_id text`;
  }),

  /**
   * The gate context's settlement column, in the trace's record because there is **one ledger**.
   *
   * `kojo_asked_gates` predates the ledger and is still created by its own layer — see the comment
   * on `SqliteGateRepository` — but a column added to a table that already sits on somebody's disk
   * can only arrive as a migration, and two migrator layers over one ledger disagree about which
   * migration `0001` is. So the gate context owns the body and this record owns the number.
   */
  "0003_asking_settlement": settlementMigration,
};

/** A list or a nested block as one column. `null` rather than the string `"undefined"`. */
const json = (value: unknown): string | null =>
  value === undefined ? null : JSON.stringify(value);

/** SQLite has no boolean. `null` keeps "not applicable" apart from `false`. */
const flag = (value: boolean | undefined): number | null =>
  value === undefined ? null : value ? 1 : 0;

/** `undefined` is absent; SQL wants a value, and the value for absent is `null`. */
const orNull = <A>(value: A | undefined): A | null => (value === undefined ? null : value);

/**
 * Every trace write, made unable to take a run down with it.
 *
 * The trace is observability: losing a row loses nothing that cannot be rebuilt, and a factory that
 * dies mid-run because a `insert` lost a write lock would be trading the work for the record of it.
 * So the failure is retried where retrying is the answer — a writer that lost the file to another
 * writer — and then logged and swallowed, cause and all. `ignoreCause` rather than `ignore` because
 * a defect from the driver must not escape either; the port promises `Effect<void>` and this is what
 * makes that promise true rather than optimistic.
 */
const write = <A, E, R>(
  what: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<void, never, R> =>
  SqliteDatabase.retryOnLock(effect).pipe(
    Effect.ignoreCause({ log: "Error", message: `the trace could not record ${what}` }),
  );

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insertRun = SqlSchema.void({
    Request: RunRecord,
    execute: (record) =>
      sql`insert into ${sql(tables.runs)} ${sql.insert({
        run_id: record.runId,
        workflow: record.workflow,
        idempotency_key: record.idempotencyKey,
        started_at: record.startedAt,
        engine_version: record.engineVersion,
        engine_commit: record.engineCommit,
        config_digest: record.configDigest,
        host: record.host,
        image_digest: orNull(record.imageDigest),
      })}`,
  });

  const insertPhase = SqlSchema.void({
    Request: PhaseRecord,
    execute: (record) =>
      sql`insert into ${sql(tables.phases)} ${sql.insert({
        run_id: record.runId,
        phase_id: record.phaseId,
        name: record.name,
        description: record.description,
        kind: record.kind,
        outcome: record.outcome,
        attempt: record.attempt,
        started_at: record.startedAt,
        ended_at: record.endedAt,
        // Stored rather than derived: a duration is asked for far more often than it is computed
        // correctly, and this row is what a waterfall is drawn from.
        duration_millis: record.endedAt - record.startedAt,
        error_tag: orNull(record.errorTag),
        // The nullable column the whole "which phases needed a container" question rests on.
        sandbox_id: orNull(record.sandboxId),
        agent: orNull(record.agent?.agent),
        model: orNull(record.agent?.model),
        session: orNull(record.agent?.session),
        resumed: flag(record.agent?.resumed),
        tokens_in: orNull(record.agent?.tokensIn),
        tokens_out: orNull(record.agent?.tokensOut),
        context_tokens: orNull(record.agent?.contextTokens),
        envelope: orNull(record.verification?.envelope),
        checks_ran: json(record.verification?.ran),
        checks_failed: json(record.verification?.failed),
        corrections: orNull(record.verification?.corrections),
        correctable: flag(record.verification?.correctable),
        files_claimed: json(record.repo?.claimed),
        files_changed: json(record.repo?.changed),
        commits: json(record.repo?.commits),
        breaches: json(record.breaches),
      })}`,
  });

  const insertGate = SqlSchema.void({
    Request: GateRecord,
    execute: (record) =>
      sql`insert into ${sql(tables.gates)} ${sql.insert({
        run_id: record.runId,
        gate: record.gate,
        asking: record.asking,
        token: record.token,
        description: record.description,
        actor: record.actor,
        choices: json(record.choices),
        requested_at: record.requestedAt,
        deadline_at: record.deadlineAt,
        on_expiry: record.onExpiry,
        outcome: record.outcome,
        answerer: orNull(record.answerer),
        choice: orNull(record.choice),
        reason: orNull(record.reason),
        answered_at: orNull(record.answeredAt),
        // Human latency: the metric a factory lives or dies by, and nothing upstream measures it.
        latency_millis:
          record.answeredAt === undefined ? null : record.answeredAt - record.requestedAt,
      })}`,
  });

  const insertSandbox = SqlSchema.void({
    Request: SandboxRecord,
    execute: (record) =>
      sql`insert into ${sql(tables.sandboxes)} ${sql.insert({
        run_id: record.runId,
        sandbox_id: record.sandboxId,
        name: record.name,
        provider: record.provider,
        kind: record.kind,
        branch: record.branch,
        worktree_path: record.worktreePath,
        environment: json(record.environment),
        acquired_at: record.acquiredAt,
        released_at: record.releasedAt,
        lifetime_millis: record.releasedAt - record.acquiredAt,
        outcome: record.outcome,
      })}`,
  });

  const insertOccurrence = SqlSchema.void({
    Request: Occurrence,
    execute: (record) =>
      sql`insert into ${sql(tables.occurrences)} ${sql.insert({
        run_id: record.runId,
        phase_id: record.phaseId,
        kind: record.kind,
        name: record.name,
        started_at: record.startedAt,
        ended_at: record.endedAt,
        duration_millis: record.endedAt - record.startedAt,
        outcome: record.outcome,
        detail: orNull(record.detail),
      })}`,
  });

  return {
    runStarted: (record: RunRecord) => write("the start of a run", insertRun(record)),
    /**
     * The run row's status, written again on every execution of the body.
     *
     * An update rather than an insert, and the only mutation in this adapter. A run that suspends
     * three times passes through here four times, and each says where the run stands *now* —
     * `suspended` while a human thinks, then a terminal answer. D9 governs records of completed
     * work; this column is the run's status, which is a different thing.
     */
    runFinished: (runId: RunId, outcome: RunOutcome) =>
      write(
        "the end of a run",
        Effect.flatMap(
          Clock.currentTimeMillis,
          (finishedAt) =>
            sql`update ${sql(tables.runs)} set outcome = ${outcome}, finished_at = ${finishedAt} where run_id = ${runId}`,
        ),
      ),
    /**
     * The run's current phase, stamped on the run row.
     *
     * The second mutation in this adapter, and the second thing that is a *status* rather than a
     * record of completed work. It overwrites whatever was there: a run executes one phase at a time
     * on any one path through its body, and a value left by a phase that has already exited would be
     * a lie the next `phase` write corrects a moment later anyway.
     */
    phaseEntered: (runId: RunId, phase: InFlightPhase) =>
      write(
        `the start of the phase ${phase.name}`,
        sql`update ${sql(tables.runs)} set ${sql.update({
          in_flight_phase_id: phase.phaseId,
          in_flight_name: phase.name,
          in_flight_kind: phase.kind,
          in_flight_attempt: phase.attempt,
          in_flight_started_at: phase.startedAt,
          in_flight_sandbox_id: orNull(phase.sandboxId),
        })} where run_id = ${runId}`,
      ),
    /**
     * The phase record, and the clearing of the in-flight phase it replaces.
     *
     * One `write` around both, because they are one fact: the phase has ended. Splitting them would
     * let the row keep claiming a phase is running after its record has been written, and a Console
     * would draw the same phase twice — once as a finished span and once as a span still growing.
     */
    phase: (record: PhaseRecord) =>
      write(
        `the phase ${record.name}`,
        Effect.andThen(
          insertPhase(record),
          sql`update ${sql(tables.runs)} set ${sql.update({
            in_flight_phase_id: null,
            in_flight_name: null,
            in_flight_kind: null,
            in_flight_attempt: null,
            in_flight_started_at: null,
            in_flight_sandbox_id: null,
          })} where run_id = ${record.runId}`,
        ),
      ),
    gate: (record: GateRecord) => write(`the gate ${record.gate}`, insertGate(record)),
    sandbox: (record: SandboxRecord) => write(`the sandbox ${record.name}`, insertSandbox(record)),
    occurrence: (record: Occurrence) =>
      write(`an occurrence in ${record.phaseId}`, insertOccurrence(record)),
  };
});

/**
 * The trace writer, over the shared client, with Kojo's own schema migrated first.
 *
 * `Layer.provide` rather than a merge: the migrations must have run before the first insert, and
 * this is what orders them. `SqlClient` stays in the requirement channel on purpose — see the note
 * on the module above about what two clients on one file cost.
 */
export const layer: Layer.Layer<
  Tracer,
  SqlError.SqlError | Migrator.MigrationError,
  SqlClient.SqlClient
> = Layer.effect(Tracer, make).pipe(Layer.provide(SqliteDatabase.migrated(migrations)));
