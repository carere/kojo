import { Database } from "bun:sqlite";
import { chmodSync, existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { BunCrypto } from "@effect/platform-bun";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import type { ProjectSnapshot } from "@kojo/control";
import { Context, Effect, Exit, Layer, Option, Scope } from "effect";
import {
  ClusterWorkflowEngine,
  RunnerAddress,
  ShardId,
  Sharding,
  SingleRunner,
} from "effect/unstable/cluster";
import { SqlClient } from "effect/unstable/sql";
import { WorkflowEngine } from "effect/unstable/workflow";
import {
  WorkflowBackend,
  type WorkflowBackendAssessment,
} from "../../contexts/workflow-execution/projects/services/workflow-backend";

const databasePath = (project: ProjectSnapshot) => join(project.path, ".kojo", "kojo.sqlite");
const ownershipPath = (project: ProjectSnapshot) =>
  join(project.path, ".kojo", "project-runtime-lock.sqlite");

const configure = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    yield* sql.unsafe("PRAGMA foreign_keys = ON");
    yield* sql.unsafe("PRAGMA busy_timeout = 5000");
    yield* sql.unsafe("PRAGMA synchronous = FULL");
    const settings = yield* sql.unsafe<{
      readonly foreign_keys: number;
      readonly synchronous: number;
    }>(
      "SELECT (SELECT foreign_keys FROM pragma_foreign_keys) AS foreign_keys, (SELECT synchronous FROM pragma_synchronous) AS synchronous",
    );
    if (settings[0]?.foreign_keys !== 1 || settings[0]?.synchronous !== 2) {
      return yield* Effect.die("Effect Workflow database safety settings are unavailable");
    }
  });

interface ActiveBackend {
  readonly engine: WorkflowEngine.WorkflowEngine["Service"];
  readonly scope: Scope.Closeable;
  readonly sharding: Sharding.Sharding["Service"];
}

const waitForOwnership = (sharding: Sharding.Sharding["Service"]) =>
  Effect.gen(function* () {
    const probe = ShardId.make("default", 1);
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (sharding.hasShardId(probe)) return true;
      yield* Effect.sleep("25 millis");
    }
    return false;
  });

export const makeLocalWorkflowBackendLayer = (hostIdentity: string) =>
  Layer.effect(
    WorkflowBackend,
    Effect.gen(function* () {
      const parentScope = yield* Effect.scope;
      const active = new Map<string, ActiveBackend>();
      const ownership = new Map<string, Database>();
      const ownerAddress = RunnerAddress.make(hostIdentity, 34_431);

      const quiesce = (path: string) =>
        Effect.gen(function* () {
          const backend = active.get(path);
          if (backend === undefined) return;
          active.delete(path);
          yield* Scope.close(backend.scope, Exit.void);
        });

      const acquireOwnership = (project: ProjectSnapshot) =>
        Effect.sync(() => {
          if (ownership.has(project.path)) return true;
          const path = ownershipPath(project);
          if (existsSync(path)) {
            const information = lstatSync(path);
            const userId = process.getuid?.();
            if (
              information.isSymbolicLink() ||
              !information.isFile() ||
              (userId !== undefined && information.uid !== userId) ||
              (information.mode & 0o777) !== 0o600
            ) {
              return false;
            }
          }
          const connection = new Database(path, { create: true, strict: true });
          try {
            chmodSync(path, 0o600);
            connection.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE");
            ownership.set(project.path, connection);
            return true;
          } catch {
            connection.close();
            return false;
          }
        }).pipe(Effect.catchCause(() => Effect.succeed(false)));

      const releaseOwnership = (path: string) =>
        Effect.sync(() => {
          const connection = ownership.get(path);
          if (connection === undefined) return;
          ownership.delete(path);
          try {
            connection.exec("ROLLBACK");
          } finally {
            connection.close();
          }
        }).pipe(Effect.catchCause(() => Effect.void));

      const initialize = (project: ProjectSnapshot) =>
        Effect.gen(function* () {
          const current = active.get(project.path);
          if (current !== undefined) return yield* waitForOwnership(current.sharding);

          const scope = yield* Scope.fork(parentScope, "sequential");
          return yield* Effect.gen(function* () {
            const sqlContext = yield* Layer.buildWithScope(
              SqliteClient.layer({ filename: databasePath(project), create: false }),
              scope,
            );
            const sql = Context.get(sqlContext, SqlClient.SqlClient);
            yield* configure(sql);
            const support = SingleRunner.layer({
              runnerStorage: "sql",
              shardingConfig: { runnerAddress: Option.some(ownerAddress) },
            }).pipe(Layer.provideMerge([Layer.succeedContext(sqlContext), BunCrypto.layer]));
            const context = yield* Layer.buildWithScope(
              ClusterWorkflowEngine.layer.pipe(Layer.provideMerge(support)),
              scope,
            );
            const sharding = Context.get(context, Sharding.Sharding);
            const engine = Context.get(context, WorkflowEngine.WorkflowEngine);
            if (!(yield* waitForOwnership(sharding))) {
              yield* Scope.close(scope, Exit.void);
              return false;
            }
            active.set(project.path, { engine, scope, sharding });
            return true;
          }).pipe(Effect.onError(() => Scope.close(scope, Exit.void)));
        }).pipe(Effect.catchCause(() => quiesce(project.path).pipe(Effect.as(false))));

      const postflight = (project: ProjectSnapshot) =>
        Effect.gen(function* () {
          const backend = active.get(project.path);
          if (backend === undefined || (yield* backend.sharding.isShutdown)) return false;
          if (!(yield* waitForOwnership(backend.sharding))) return false;
          yield* backend.sharding.getSnowflake;
          return backend.engine !== undefined;
        }).pipe(Effect.catchCause(() => Effect.succeed(false)));

      const release = (project: ProjectSnapshot) =>
        quiesce(project.path).pipe(Effect.andThen(releaseOwnership(project.path)));

      yield* Effect.addFinalizer(() =>
        Effect.forEach(Array.from(ownership.keys()), releaseOwnership, { discard: true }),
      );

      return {
        acquire: acquireOwnership,
        quiesce: (project: ProjectSnapshot) => quiesce(project.path),
        initialize,
        postflight,
        readiness: (project: ProjectSnapshot): Effect.Effect<WorkflowBackendAssessment> =>
          Effect.gen(function* () {
            const backend = active.get(project.path);
            if (backend === undefined) return "uninitialized";
            return (yield* postflight(project)) ? "ready" : "needs-attention";
          }).pipe(Effect.catchCause(() => Effect.succeed("needs-attention" as const))),
        release,
      };
    }),
  );
