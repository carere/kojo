import { Effect, Layer, Option, type SchemaError } from "effect";
import { SqlClient, type SqlError } from "effect/unstable/sql";
import type { DurableDeferred } from "effect/unstable/workflow";
import { decodeUnknown } from "../../shared/lib/decode.ts";
import { AskedGate } from "../models/AskedGate.ts";
import { GateRequest } from "../models/GateRequest.ts";
import { GateStoreError, type GateStoreOperation } from "../models/GateStoreError.ts";
import { Verdict } from "../models/Verdict.ts";
import { GateRepository } from "../ports/GateRepository.ts";

/**
 * The askings, on the same file the engine suspends into.
 *
 * The same file and the **same client**: this layer takes `SqlClient` from the requirement channel
 * exactly as `SingleNodeEngine` does, so `kojo run` opens one `bun:sqlite` handle rather than two
 * with two independent write serializers.
 *
 * **The table is created here rather than through `SqliteDatabase.migrated`, and that is a
 * deliberate, temporary choice.** The migrator writes one ledger, `kojo_migrations`, and the trace
 * schema — a different ticket, landing in the same wave — owns that ledger. Two migrator layers over
 * one ledger disagree about which migration `0001` is. `create table if not exists` is idempotent,
 * costs one statement at startup, and folds into the ledger the moment there is one ledger to fold
 * into. The `expired_at` column *did* fold in — see `settlementMigration` below — because a column
 * added to a table that already exists on somebody's disk can only arrive as a migration.
 */
const createTable = `
  create table if not exists kojo_asked_gates (
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
    answered_at   integer,
    expired_at    integer
  )
`;

/**
 * Migration `0003`: the settlement column, on askings tables written before it existed.
 *
 * Registered in the one ledger (`SqliteTracer.migrations`, under `kojo_migrations`) rather than
 * through a second migrator, because two migrator layers over one ledger disagree about which
 * migration `0001` is. The body lives here so the gate context keeps owning its own schema.
 *
 * It has to meet the table in two states, because the layer above creates it outside the ledger:
 * a fresh file gets the full shape from `createTable` — run first here or first there, both are
 * `if not exists` of the same statement — and a file from before this wave has the table without
 * the column, which only `alter table` can fix. The `pragma` read is what tells the two apart;
 * a bare `alter` would die on the fresh file with *duplicate column name*.
 */
export const settlementMigration: Effect.Effect<void, unknown, SqlClient.SqlClient> = Effect.gen(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe(createTable);
    const columns = yield* sql.unsafe<{ readonly name: string }>(
      "pragma table_info(kojo_asked_gates)",
    );
    if (!columns.some((column) => column.name === "expired_at")) {
      yield* sql.unsafe("alter table kojo_asked_gates add column expired_at integer");
    }
  },
);

/** One row of the table, as SQLite hands it back. */
interface Row {
  readonly token: string;
  readonly run_id: string;
  readonly gate: string;
  readonly asking: string;
  readonly description: string;
  readonly actor: string;
  readonly choices: string;
  readonly requested_at: number;
  readonly deadline_at: number;
  readonly on_expiry: string;
  readonly answerer: string | null;
  readonly choice: string | null;
  readonly reason: string | null;
  readonly answered_at: number | null;
  /** Optional as well as nullable: a file from before migration 0003 has no such column at all. */
  readonly expired_at?: number | null;
}

const failed =
  (operation: GateStoreOperation) =>
  (error: SqlError.SqlError | SchemaError.SchemaError): GateStoreError =>
    new GateStoreError({ operation, reason: error.message, cause: error });

/**
 * A row back into the two values it holds.
 *
 * Decoded rather than cast, through the one decode path: the columns come from outside this process
 * — another `kojo` invocation wrote them, possibly an older one — so a `runId` that is not a run id
 * or an `on_expiry` that names a fourth branch has to fail as a decode rather than as a wrong answer
 * three screens later.
 */
const decodeRow = (row: Row): Effect.Effect<AskedGate, GateStoreError> =>
  Effect.gen(function* () {
    const request = yield* decodeUnknown(GateRequest)({
      runId: row.run_id,
      gate: row.gate,
      asking: row.asking,
      description: row.description,
      actor: row.actor,
      choices: JSON.parse(row.choices),
      token: row.token,
      requestedAt: row.requested_at,
      deadlineAt: row.deadline_at,
      onExpiry: row.on_expiry,
    });

    // Absent and null are one condition here: null is what the column holds before the settlement
    // was written, and absent is a file from before the column existed — both mean *not settled*.
    const settlement = row.expired_at == null ? {} : { expiredAt: row.expired_at };

    // All four answer columns are written in one statement, so one of them being present is the
    // whole verdict being present. `answerer` is the one asked for, because a verdict with nobody
    // attached is the one thing a gate record must never claim.
    if (row.answerer === null) return new AskedGate({ request, ...settlement });

    const verdict = yield* decodeUnknown(Verdict)({
      choice: row.choice,
      reason: row.reason,
      answerer: row.answerer,
      answeredAt: row.answered_at,
    });

    return new AskedGate({ request, verdict, ...settlement });
  }).pipe(Effect.mapError(failed("read")));

export const layer: Layer.Layer<GateRepository, GateStoreError, SqlClient.SqlClient> = Layer.effect(
  GateRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe(createTable).pipe(Effect.mapError(failed("ask")));

    const select = (where: Effect.Effect<ReadonlyArray<Row>, SqlError.SqlError>) =>
      where.pipe(
        Effect.mapError(failed("read")),
        Effect.flatMap((rows) => Effect.forEach(rows, decodeRow)),
      );

    return {
      /**
       * Written from inside the request activity, so once per asking however often the body
       * replays. `on conflict do nothing` is the belt to that brace: the token is unique to one
       * asking, and re-asking must never overwrite a verdict that has already been written.
       */
      asked: (request: GateRequest) =>
        sql`
          insert into kojo_asked_gates
            (token, run_id, gate, asking, description, actor, choices,
             requested_at, deadline_at, on_expiry)
          values
            (${request.token}, ${request.runId}, ${request.gate}, ${request.asking},
             ${request.description}, ${request.actor}, ${JSON.stringify(request.choices)},
             ${request.requestedAt}, ${request.deadlineAt}, ${request.onExpiry})
          on conflict (token) do nothing
        `.pipe(Effect.mapError(failed("ask")), Effect.asVoid),

      /**
       * Keeps the first answer, exactly as the engine does.
       *
       * `where answerer is null` is not an optimisation: `DurableDeferred.succeed` refuses to
       * overwrite a recorded result, so a second answer changes nothing about the run. A list that
       * showed the second answerer would be reporting a decision the run never took.
       */
      recorded: (options: { readonly token: DurableDeferred.Token; readonly verdict: Verdict }) =>
        sql<Row>`
          update kojo_asked_gates
             set answerer    = ${options.verdict.answerer},
                 choice      = ${options.verdict.choice},
                 reason      = ${options.verdict.reason},
                 answered_at = ${options.verdict.answeredAt}
           where token = ${options.token}
             and answerer is null
          returning *
        `.pipe(
          Effect.mapError(failed("record")),
          Effect.map((rows) => rows.length > 0),
        ),

      /**
       * Keeps the first settlement, like `recorded` keeps the first answer. A verdict already on
       * the row stays beside it — somebody answered and the run settled without an answer are two
       * different facts, and `AskedGate.state` is where they are ranked, not here.
       */
      expired: (options: { readonly token: DurableDeferred.Token; readonly expiredAt: number }) =>
        sql<Row>`
          update kojo_asked_gates
             set expired_at = ${options.expiredAt}
           where token = ${options.token}
             and expired_at is null
          returning *
        `.pipe(
          Effect.mapError(failed("expire")),
          Effect.map((rows) => rows.length > 0),
        ),

      byToken: (token: DurableDeferred.Token) =>
        select(sql<Row>`select * from kojo_asked_gates where token = ${token}`).pipe(
          Effect.map((gates) => Option.fromUndefinedOr(gates[0])),
        ),

      all: select(sql<Row>`select * from kojo_asked_gates order by requested_at`),
    };
  }),
);
