import { Database } from "bun:sqlite";
import { join } from "node:path";
import { BunCrypto } from "@effect/platform-bun";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import type { ProjectSnapshot } from "@kojo/control";
import { Context, Duration, Effect, Exit, Layer, Option, Scope } from "effect";
import {
  ClusterWorkflowEngine,
  RunnerAddress,
  ShardId,
  Sharding,
  ShardingConfig,
  SingleRunner,
} from "effect/unstable/cluster";
import { SqlClient } from "effect/unstable/sql";
import { WorkflowEngine } from "effect/unstable/workflow";
import {
  WorkflowBackend,
  type WorkflowBackendAssessment,
} from "../../contexts/workflow-execution/projects/services/workflow-backend";

const databasePath = (project: ProjectSnapshot) => join(project.path, ".kojo", "kojo.sqlite");
const shardLockExpirationSeconds = Math.ceil(
  Duration.toSeconds(ShardingConfig.defaults.shardLockExpiration),
);

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
      const ownerAddress = RunnerAddress.make(hostIdentity, 34_431);

      const close = (path: string) =>
        Effect.gen(function* () {
          const backend = active.get(path);
          if (backend === undefined) return;
          active.delete(path);
          yield* Scope.close(backend.scope, Exit.void);
        });

      const acquire = (project: ProjectSnapshot) =>
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
        }).pipe(Effect.catchCause(() => close(project.path).pipe(Effect.as(false))));

      const postflight = (project: ProjectSnapshot) =>
        Effect.gen(function* () {
          const backend = active.get(project.path);
          if (backend === undefined || (yield* backend.sharding.isShutdown)) return false;
          if (!(yield* waitForOwnership(backend.sharding))) return false;
          yield* backend.sharding.getSnowflake;
          return backend.engine !== undefined;
        }).pipe(Effect.catchCause(() => Effect.succeed(false)));

      const hasForeignOwnership = (project: ProjectSnapshot) =>
        Effect.sync(() => {
          const connection = new Database(databasePath(project), {
            create: false,
            readonly: true,
            strict: true,
          });
          try {
            const lockTable = connection
              .query(
                "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'cluster_locks'",
              )
              .get() as { readonly present: number } | undefined;
            if (lockTable?.present !== 1) return false;
            const lock = connection
              .query(
                "SELECT 1 AS present FROM cluster_locks WHERE address <> ? AND acquired_at >= datetime('now', ?) LIMIT 1",
              )
              .get(
                `${ownerAddress.host}:${ownerAddress.port}`,
                `-${shardLockExpirationSeconds} seconds`,
              ) as { readonly present: number } | undefined;
            return lock?.present === 1;
          } finally {
            connection.close();
          }
        }).pipe(Effect.catchCause(() => Effect.succeed(true)));

      return {
        initialize: acquire,
        postflight,
        readiness: (project: ProjectSnapshot): Effect.Effect<WorkflowBackendAssessment> =>
          Effect.gen(function* () {
            const backend = active.get(project.path);
            if (backend === undefined) {
              return (yield* hasForeignOwnership(project)) ? "needs-attention" : "uninitialized";
            }
            return (yield* postflight(project)) ? "ready" : "needs-attention";
          }).pipe(Effect.catchCause(() => Effect.succeed("needs-attention" as const))),
        release: (project: ProjectSnapshot) => close(project.path),
      };
    }),
  );
