// `@effect/platform-bun` is imported by deep path, never by its barrel: the barrel re-exports
// BunRedis, and loading it would end the run before a single test did anything.
import * as BunServices from "@effect/platform-bun/BunServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { DurableDeferred } from "effect/unstable/workflow";
import * as SqliteGateRepository from "../../../../../src/contexts/gate/adapters/SqliteGateRepository.ts";
import { GateRequest } from "../../../../../src/contexts/gate/models/GateRequest.ts";
import { GateRepository } from "../../../../../src/contexts/gate/ports/GateRepository.ts";
import * as SqliteDatabase from "../../../../../src/contexts/shared/adapters/SqliteDatabase.ts";
import { makePhaseId } from "../../../../../src/contexts/shared/models/PhaseId.ts";
import type { RunId } from "../../../../../src/contexts/shared/models/RunId.ts";
import * as SqliteTracer from "../../../../../src/contexts/trace/adapters/SqliteTracer.ts";
import { PhaseRecord } from "../../../../../src/contexts/trace/models/PhaseRecord.ts";
import { Tracer } from "../../../../../src/contexts/trace/ports/Tracer.ts";

/**
 * The two schemas this wave added, in the one file they are both aimed at.
 *
 * Ticket 12 creates `kojo_asked_gates` with a bare `create table if not exists`, deliberately
 * staying out of the ledger; ticket 24 creates the five `kojo_*` trace tables through
 * `SqliteDatabase.migrated`, which owns `kojo_migrations`. Each ticket proved its own half on its
 * own file, and neither could prove the pair — they were written in parallel worktrees, and the
 * CLI still wires an `InMemoryTracer`, so nothing in either branch ever opened one file with both
 * layers over it.
 *
 * That is the whole point of this file. The moment the trace stops being in-memory these two share
 * a database, and "the migrator does not trip over a table it did not create, and the bare
 * `create table` does not disturb the ledger" is an assumption until something runs it.
 */
const bothSchemas = (path: string) => {
  const database = SqliteDatabase.layer({ path }).pipe(Layer.provide(BunServices.layer));
  // `provideMerge` keeps the client in the output, so the tests can query the raw tables that
  // neither port exposes — which is the only way to see the two schemas side by side.
  return Layer.mergeAll(SqliteGateRepository.layer, SqliteTracer.layer).pipe(
    Layer.provideMerge(database),
  );
};

const phase = (name: string, runId: string) =>
  new PhaseRecord({
    runId: runId as RunId,
    phaseId: makePhaseId(runId as RunId, name, 1),
    name,
    description: `the ${name} phase`,
    kind: "code",
    outcome: "succeeded",
    attempt: 1,
    startedAt: 1_000,
    endedAt: 2_000,
  });

const asking = (gate: string, runId: string) =>
  new GateRequest({
    runId: runId as RunId,
    gate,
    asking: `gate/${gate}/1`,
    description: "does it land?",
    actor: "engineer",
    choices: ["approve", "reject"],
    token: `token-${gate}` as DurableDeferred.Token,
    requestedAt: 1_000,
    deadlineAt: 1_000 + 48 * 3_600_000,
    onExpiry: "fail",
  });

describe("the gate askings and the trace in one database", () => {
  it.effect("lets both schemas exist in one file, and each still reads its own rows back", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const path = `${directory}/both.db`;

      yield* Effect.gen(function* () {
        const repository = yield* GateRepository;
        const tracer = yield* Tracer;
        const sql = yield* SqlClient.SqlClient;

        // Both writers, against one file, in one runtime.
        yield* repository.asked(asking("approve", "run-a"));
        yield* tracer.phase(phase("build", "run-a"));

        const tables = yield* sql<{ name: string }>`
          select name from sqlite_master where type = 'table' order by name
        `;
        const names = tables.map((row) => row.name);

        // Ticket 12's table, ticket 24's five, and ticket 24's ledger — all present together.
        expect(names).toContain("kojo_asked_gates");
        expect(names).toContain("kojo_migrations");
        for (const table of Object.values(SqliteTracer.tables)) {
          expect(names).toContain(table);
        }

        // One ledger, one numbering. The bare `create table` the askings use stays out of it —
        // ticket 12 traded a migration for that, or the two tickets would disagree about which
        // migration `0001` is — and when the askings *did* need a column (ticket 46), it joined
        // this same record as `0003` rather than starting a second ledger.
        const ledger = yield* sql<{ name: string }>`
          select name from ${sql(SqliteDatabase.migrationsTable)} order by migration_id
        `;
        expect(ledger.map((row) => row.name)).toEqual(["trace", "in_flight", "asking_settlement"]);

        // And each side still reads back what it wrote, through the other side's tables.
        const askings = yield* repository.all;
        expect(askings.map((entry) => entry.request.gate)).toEqual(["approve"]);

        const phases = yield* sql<{ name: string }>`
          select name from ${sql(SqliteTracer.tables.phases)}
        `;
        expect(phases.map((row) => row.name)).toEqual(["build"]);
      }).pipe(Effect.provide(bothSchemas(path)));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.effect("re-opens the file without the migrator tripping over what is already there", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const path = `${directory}/both.db`;

      // First open: both schemas are created.
      yield* Effect.gen(function* () {
        const repository = yield* GateRepository;
        yield* repository.asked(asking("approve", "run-a"));
        const tracer = yield* Tracer;
        yield* tracer.phase(phase("build", "run-a"));
      }).pipe(Effect.provide(bothSchemas(path)));

      // Second open, a fresh client on the same file: the `create table if not exists` is a no-op
      // and the migrator finds its ledger already satisfied. Neither may fail, and neither may
      // wipe what the first open wrote.
      const seen = yield* Effect.gen(function* () {
        const repository = yield* GateRepository;
        const sql = yield* SqlClient.SqlClient;
        const askings = yield* repository.all;
        const phases = yield* sql<{ name: string }>`
          select name from ${sql(SqliteTracer.tables.phases)}
        `;
        const ledger = yield* sql<{ name: string }>`
          select name from ${sql(SqliteDatabase.migrationsTable)}
        `;
        return {
          askings: askings.map((entry) => entry.request.gate),
          phases: phases.map((row) => row.name),
          ledger: ledger.map((row) => row.name),
        };
      }).pipe(Effect.provide(bothSchemas(path)));

      expect(seen.askings).toEqual(["approve"]);
      expect(seen.phases).toEqual(["build"]);
      // Still one row per migration, never a second — the reopen re-ran nothing.
      expect(seen.ledger).toEqual(["trace", "in_flight", "asking_settlement"]);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );
});
