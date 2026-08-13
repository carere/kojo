import { Effect, Layer, Option, Schema, type SchemaError } from "effect";
import { SqlClient, type SqlError, SqlSchema } from "effect/unstable/sql";
import { DurableDeferred } from "effect/unstable/workflow";
import { GateOutcome, GateRecord } from "../../gate/models/GateRecord.ts";
import { ExpiryBranch } from "../../gate/models/OnExpiry.ts";
import { SandboxKind } from "../../sandbox/models/SandboxProvider.ts";
import { present } from "../../shared/lib/present.ts";
import { PathRollback } from "../../shared/models/PathRollback.ts";
import { PhaseId } from "../../shared/models/PhaseId.ts";
import { RunId } from "../../shared/models/RunId.ts";
import { SandboxId } from "../../shared/models/SandboxId.ts";
import { AgentCallRecord } from "../models/AgentCallRecord.ts";
import { InFlightPhase } from "../models/InFlightPhase.ts";
import { Occurrence, OccurrenceKind, OccurrenceOutcome } from "../models/Occurrence.ts";
import { defaultPageSize, OccurrenceCursor, OccurrencePage } from "../models/OccurrencePage.ts";
import { PhaseKind, PhaseOutcome, PhaseRecord } from "../models/PhaseRecord.ts";
import { RepoEffect } from "../models/RepoEffect.ts";
import { RunDocument } from "../models/RunDocument.ts";
import { RunOutcome, RunRecord } from "../models/RunRecord.ts";
import { RunSummary } from "../models/RunSummary.ts";
import { SandboxOutcome, SandboxRecord } from "../models/SandboxRecord.ts";
import { TraceReadError, type TraceReadOperation } from "../models/TraceReadError.ts";
import { Verification } from "../models/Verification.ts";
import { TraceReader } from "../ports/TraceReader.ts";
import { tables } from "./SqliteTracer.ts";

/**
 * The query side of the trace, over the same file and the same client the writer uses.
 *
 * Three shapes, one per question the Console asks, and every one of them decoded through `Schema`.
 * The rules that make this survivable are the writer's own, read from the other end:
 *
 * - **Every row is decoded, never cast.** `SqlSchema.findAll` encodes the request and decodes the
 *   rows, so a `run_id` that is not a run id or an `outcome` that names a fourth state lands in the
 *   typed error channel as a `SchemaError` rather than as a wrong answer three screens later. The
 *   columns come from outside this process — another `kojo` invocation wrote them, possibly an
 *   older one — which is exactly the case a cast cannot cover.
 * - **A column this reader does not know about is a column it does not select.** The migrations are
 *   additive and every query here names its table rather than its columns; the row schemas name
 *   what they need, and `Schema.Struct` ignores the rest. That is what makes a Console keep working
 *   when the factory upgrades under it.
 * - **Only `occurrences` takes a cursor**, and it is the reason the table names an `INTEGER PRIMARY
 *   KEY`. Everything else is polled whole — see `RunDocument`.
 * - **Nothing here opens a database.** `SqlClient` stays in the requirement channel, exactly as the
 *   writer leaves it: two layers on one path are two `bun:sqlite` handles with two independent write
 *   serializers.
 *
 * There are no streaming reads on this driver — `executeStream` is `Stream.die` — so a cursor is
 * polled and never subscribed. `SqlClient.reactive` exists and is process-local, which cannot serve
 * a Console running in its own process.
 */

/**
 * A nullable column read as an optional field — **omitted, never present holding `undefined`.**
 *
 * `present` is what carries that, and adr/trace/0003 is why it has to: a record built with
 * `{ sandboxId: undefined }` encodes to `"sandboxId": null` on the wire, and a record built without
 * the key encodes to nothing at all. This reader is the producer that used to send the first shape
 * while the fixtures sent the second, so the Console was tested against a document this file could
 * never produce.
 */

/** A list stored as one column. `null` is the column the writer never filled. */
const list = Schema.NullOr(Schema.fromJsonString(Schema.Array(Schema.String)));

const RunRow = Schema.Struct({
  run_id: RunId,
  workflow: Schema.String,
  idempotency_key: Schema.String,
  started_at: Schema.Finite,
  engine_version: Schema.String,
  engine_commit: Schema.String,
  config_digest: Schema.String,
  host: Schema.String,
  image_digest: Schema.NullOr(Schema.String),
  outcome: Schema.NullOr(RunOutcome),
  finished_at: Schema.NullOr(Schema.Finite),
  in_flight_phase_id: Schema.NullOr(PhaseId),
  in_flight_name: Schema.NullOr(Schema.String),
  in_flight_kind: Schema.NullOr(PhaseKind),
  in_flight_attempt: Schema.NullOr(Schema.Finite),
  in_flight_started_at: Schema.NullOr(Schema.Finite),
  in_flight_sandbox_id: Schema.NullOr(SandboxId),
});

/**
 * The run's current phase, or nothing.
 *
 * All-or-nothing on the same terms as the agent half of a phase row: the writer sets these five
 * columns in one statement and clears them in one statement, so a row with a phase id and no start
 * time is a row nothing in this codebase can produce. Reading such a row as a phase that began at
 * zero would put a span across the whole waterfall — inventing a fact, which in a trace is worse
 * than having none.
 *
 * `in_flight_sandbox_id` is genuinely optional: a phase on the host has no acquisition.
 */
const inFlightOf = (row: typeof RunRow.Type): InFlightPhase | undefined =>
  row.in_flight_phase_id === null ||
  row.in_flight_name === null ||
  row.in_flight_kind === null ||
  row.in_flight_attempt === null ||
  row.in_flight_started_at === null
    ? undefined
    : new InFlightPhase({
        phaseId: row.in_flight_phase_id,
        name: row.in_flight_name,
        kind: row.in_flight_kind,
        attempt: row.in_flight_attempt,
        startedAt: row.in_flight_started_at,
        ...present("sandboxId", row.in_flight_sandbox_id),
      });

const summaryOf = (row: typeof RunRow.Type): RunSummary =>
  new RunSummary({
    run: new RunRecord({
      runId: row.run_id,
      workflow: row.workflow,
      idempotencyKey: row.idempotency_key,
      startedAt: row.started_at,
      engineVersion: row.engine_version,
      engineCommit: row.engine_commit,
      configDigest: row.config_digest,
      host: row.host,
      ...present("imageDigest", row.image_digest),
    }),
    ...present("outcome", row.outcome),
    ...present("finishedAt", row.finished_at),
    ...present("inFlight", inFlightOf(row)),
  });

const PhaseRow = Schema.Struct({
  run_id: RunId,
  phase_id: PhaseId,
  name: Schema.String,
  description: Schema.String,
  kind: PhaseKind,
  outcome: PhaseOutcome,
  attempt: Schema.Finite,
  started_at: Schema.Finite,
  ended_at: Schema.Finite,
  error_tag: Schema.NullOr(Schema.String),
  sandbox_id: Schema.NullOr(SandboxId),
  agent: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
  session: Schema.NullOr(Schema.String),
  resumed: Schema.NullOr(Schema.Finite),
  tokens_in: Schema.NullOr(Schema.Finite),
  tokens_out: Schema.NullOr(Schema.Finite),
  context_tokens: Schema.NullOr(Schema.Finite),
  envelope: Schema.NullOr(Schema.String),
  checks_ran: list,
  checks_failed: list,
  corrections: Schema.NullOr(Schema.Finite),
  correctable: Schema.NullOr(Schema.Finite),
  files_claimed: list,
  files_changed: list,
  commits: list,
  breaches: Schema.NullOr(Schema.fromJsonString(Schema.Array(PathRollback))),
});

/**
 * The agent half of a phase row, or nothing.
 *
 * **Every member is required, and no member is defaulted.** The writer spreads one block across
 * these columns in one statement, so they are all present or all null; a row where `agent` is set
 * and `model` is not is a row nothing in this codebase can produce. Reading that row as an agent
 * call with an empty model would invent a fact — and inventing one in the trace is worse than
 * having none, because the trace is what a human checks their belief against. So the honest answer
 * to a half-written row is that the block is absent.
 *
 * `contextTokens` is genuinely optional: most invokers do not report occupancy, and the writer
 * stores null for them.
 */
const callOf = (row: typeof PhaseRow.Type): AgentCallRecord | undefined =>
  row.agent === null ||
  row.model === null ||
  row.session === null ||
  row.resumed === null ||
  row.tokens_in === null ||
  row.tokens_out === null
    ? undefined
    : new AgentCallRecord({
        agent: row.agent,
        model: row.model,
        session: row.session as AgentCallRecord["session"],
        resumed: row.resumed !== 0,
        tokensIn: row.tokens_in,
        tokensOut: row.tokens_out,
        ...present("contextTokens", row.context_tokens),
      });

/** The verdict half, on the same all-or-nothing terms as the call above. */
const verdictOf = (row: typeof PhaseRow.Type): Verification | undefined =>
  row.envelope === null ||
  row.checks_ran === null ||
  row.checks_failed === null ||
  row.corrections === null ||
  row.correctable === null
    ? undefined
    : new Verification({
        envelope: row.envelope,
        ran: row.checks_ran,
        failed: row.checks_failed,
        corrections: row.corrections,
        correctable: row.correctable !== 0,
      });

/** What the phase was allowed to do to the repository — three lists, written together. */
const repoOf = (row: typeof PhaseRow.Type): RepoEffect | undefined =>
  row.files_claimed === null || row.files_changed === null || row.commits === null
    ? undefined
    : new RepoEffect({
        claimed: row.files_claimed,
        changed: row.files_changed,
        commits: row.commits,
      });

/**
 * A phase row back into the record it was written from.
 *
 * The wide row's three nested blocks are reassembled above, each as a whole. What is flat on the
 * record stays flat here, including `sandbox_id` — the nullable column the whole *"which phases
 * needed a container"* question rests on.
 */
const phaseOf = (row: typeof PhaseRow.Type): PhaseRecord =>
  new PhaseRecord({
    runId: row.run_id,
    phaseId: row.phase_id,
    name: row.name,
    description: row.description,
    kind: row.kind,
    outcome: row.outcome,
    attempt: row.attempt,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    ...present("sandboxId", row.sandbox_id),
    ...present("errorTag", row.error_tag),
    ...present("breaches", row.breaches),
    ...present("agent", callOf(row)),
    ...present("verification", verdictOf(row)),
    ...present("repo", repoOf(row)),
  });

const GateRow = Schema.Struct({
  run_id: RunId,
  gate: Schema.String,
  asking: Schema.String,
  token: DurableDeferred.Token,
  description: Schema.String,
  actor: Schema.String,
  choices: Schema.fromJsonString(Schema.Array(Schema.String)),
  requested_at: Schema.Finite,
  deadline_at: Schema.Finite,
  on_expiry: ExpiryBranch,
  outcome: GateOutcome,
  answerer: Schema.NullOr(Schema.String),
  choice: Schema.NullOr(Schema.String),
  reason: Schema.NullOr(Schema.String),
  answered_at: Schema.NullOr(Schema.Finite),
});

const gateOf = (row: typeof GateRow.Type): GateRecord =>
  new GateRecord({
    runId: row.run_id,
    gate: row.gate,
    asking: row.asking,
    token: row.token,
    description: row.description,
    actor: row.actor,
    choices: row.choices,
    requestedAt: row.requested_at,
    deadlineAt: row.deadline_at,
    onExpiry: row.on_expiry,
    outcome: row.outcome,
    ...present("answerer", row.answerer),
    ...present("choice", row.choice),
    ...present("reason", row.reason),
    ...present("answeredAt", row.answered_at),
  });

const SandboxRow = Schema.Struct({
  run_id: RunId,
  sandbox_id: SandboxId,
  name: Schema.String,
  provider: Schema.String,
  kind: SandboxKind,
  branch: Schema.String,
  worktree_path: Schema.String,
  environment: Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
  acquired_at: Schema.Finite,
  released_at: Schema.Finite,
  outcome: SandboxOutcome,
});

const sandboxOf = (row: typeof SandboxRow.Type): SandboxRecord =>
  new SandboxRecord({
    runId: row.run_id,
    sandboxId: row.sandbox_id,
    name: row.name,
    provider: row.provider,
    kind: row.kind,
    branch: row.branch,
    worktreePath: row.worktree_path,
    environment: row.environment,
    acquiredAt: row.acquired_at,
    releasedAt: row.released_at,
    outcome: row.outcome,
  });

const OccurrenceRow = Schema.Struct({
  /** The cursor itself. Selected by name, because `select *` never expands the implicit rowid. */
  id: OccurrenceCursor,
  run_id: RunId,
  phase_id: PhaseId,
  kind: OccurrenceKind,
  name: Schema.String,
  started_at: Schema.Finite,
  ended_at: Schema.Finite,
  outcome: OccurrenceOutcome,
  detail: Schema.NullOr(Schema.String),
});

const occurrenceOf = (row: typeof OccurrenceRow.Type): Occurrence =>
  new Occurrence({
    runId: row.run_id,
    phaseId: row.phase_id,
    kind: row.kind,
    name: row.name,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    outcome: row.outcome,
    ...present("detail", row.detail),
  });

/** What the file could not answer, or answered in a shape the schema refuses. One error for both. */
const failed =
  (operation: TraceReadOperation) =>
  (error: SqlError.SqlError | SchemaError.SchemaError): TraceReadError =>
    new TraceReadError({ operation, reason: error.message, cause: error });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const everyRun = SqlSchema.findAll({
    Request: Schema.Void,
    Result: RunRow,
    execute: () => sql`select * from ${sql(tables.runs)} order by started_at desc`,
  });

  const runById = SqlSchema.findAll({
    Request: RunId,
    Result: RunRow,
    execute: (runId) => sql`select * from ${sql(tables.runs)} where run_id = ${runId}`,
  });

  const phasesOfRun = SqlSchema.findAll({
    Request: RunId,
    Result: PhaseRow,
    execute: (runId) =>
      sql`select * from ${sql(tables.phases)} where run_id = ${runId} order by started_at, id`,
  });

  const gatesOfRun = SqlSchema.findAll({
    Request: RunId,
    Result: GateRow,
    execute: (runId) =>
      sql`select * from ${sql(tables.gates)} where run_id = ${runId} order by requested_at, id`,
  });

  const sandboxesOfRun = SqlSchema.findAll({
    Request: RunId,
    Result: SandboxRow,
    execute: (runId) =>
      sql`select * from ${sql(tables.sandboxes)} where run_id = ${runId} order by acquired_at, id`,
  });

  const occurrencesAfter = SqlSchema.findAll({
    Request: Schema.Struct({
      phaseId: PhaseId,
      since: OccurrenceCursor,
      limit: Schema.Finite,
    }),
    Result: OccurrenceRow,
    execute: (request) =>
      sql`
        select * from ${sql(tables.occurrences)}
         where phase_id = ${request.phaseId}
           and id > ${request.since}
         order by id
         limit ${request.limit}
      `,
  });

  return {
    runs: everyRun(undefined).pipe(
      Effect.map((rows) => rows.map(summaryOf)),
      Effect.mapError(failed("runs")),
    ),

    run: (runId: RunId) =>
      Effect.gen(function* () {
        // The run row first, and nothing else when it is not there. A URL with one character wrong
        // must not cost three more queries, and `None` is the answer rather than an error.
        const rows = yield* runById(runId);
        const row = rows[0];
        if (row === undefined) return Option.none<RunDocument>();

        const [phases, gates, sandboxes] = yield* Effect.all(
          [phasesOfRun(runId), gatesOfRun(runId), sandboxesOfRun(runId)],
          { concurrency: "unbounded" },
        );

        return Option.some(
          new RunDocument({
            run: summaryOf(row),
            phases: phases.map(phaseOf),
            gates: gates.map(gateOf),
            sandboxes: sandboxes.map(sandboxOf),
          }),
        );
      }).pipe(Effect.mapError(failed("run"))),

    occurrences: (options: {
      readonly phaseId: PhaseId;
      readonly since: OccurrenceCursor;
      readonly limit?: number | undefined;
    }) =>
      occurrencesAfter({
        phaseId: options.phaseId,
        since: options.since,
        limit: options.limit ?? defaultPageSize,
      }).pipe(
        Effect.map(
          (rows) =>
            new OccurrencePage({
              occurrences: rows.map(occurrenceOf),
              // The last row's own id, so the next poll starts after it. An empty page leaves the
              // cursor untouched — answering zero would re-read row one forever.
              cursor: rows[rows.length - 1]?.id ?? options.since,
            }),
        ),
        Effect.mapError(failed("occurrences")),
      ),
  };
});

/**
 * The trace reader over the shared client.
 *
 * No migration runs here, and that is the point of a read port: reading must never be an act of
 * writing. The schema is the writer's, and a Console pointed at a file no factory has written to
 * yet finds no tables — which is *"no factory in this repo"*, a message rather than an error page.
 */
export const layer: Layer.Layer<TraceReader, never, SqlClient.SqlClient> = Layer.effect(
  TraceReader,
  make,
);
