#!/usr/bin/env bun
// Deep paths only. `@effect/platform-bun`'s barrel re-exports BunRedis, and this file is spawned by
// a Vitest test that must survive importing it.
import * as BunServices from "@effect/platform-bun/BunServices";
import { Cause, Effect, Exit, Layer } from "effect";
import { created } from "../../src/cli/factory.ts";
import * as SqliteGateRepository from "../../src/contexts/gate/adapters/SqliteGateRepository.ts";
import * as SqliteDatabase from "../../src/contexts/shared/adapters/SqliteDatabase.ts";
import * as SqliteTracer from "../../src/contexts/trace/adapters/SqliteTracer.ts";
import * as SingleNodeEngine from "../../src/contexts/workflow/adapters/SingleNodeEngine.ts";

/**
 * One whole cold start, as a command performs it: ready the file, then open it.
 *
 * `created` is the guard, and the three layers under it are every writer of the file a command
 * builds afterwards — the trace, the askings, and the cluster's own storage, whose lost lock is the
 * one that arrives as a defect. All three, not the engine alone: the losses this ticket is about
 * only appear when every migrator in the file is contended at once, and a reproduction that builds
 * fewer of them measures nothing. Spawned many at once against one absent database, this is the
 * fault in ticket 42 reproduced or refused.
 */
const database = process.argv[2] ?? "";

const program = Effect.gen(function* () {
  yield* created(database);
  yield* Effect.void.pipe(
    Effect.provide(
      Layer.mergeAll(SqliteTracer.layer, SqliteGateRepository.layer, SingleNodeEngine.layer()).pipe(
        Layer.provideMerge(SqliteDatabase.layer({ path: database })),
      ),
    ),
  );
}).pipe(Effect.scoped, Effect.provide(BunServices.layer));

const exit = await Effect.runPromiseExit(program);
if (Exit.isFailure(exit)) {
  console.error(Cause.hasDies(exit.cause) ? "defect" : "failure");
  console.error(Cause.pretty(exit.cause));
  process.exit(1);
}
