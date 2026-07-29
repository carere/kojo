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

      return {
        initialize: acquire,
        readiness: (project: ProjectSnapshot): Effect.Effect<WorkflowBackendAssessment> =>
          Effect.gen(function* () {
            const backend = active.get(project.path);
            if (backend === undefined) return "uninitialized";
            if (yield* backend.sharding.isShutdown) return "needs-attention";
            if (!(yield* waitForOwnership(backend.sharding))) return "needs-attention";
            return backend.engine === undefined ? "needs-attention" : "ready";
          }).pipe(Effect.catchCause(() => Effect.succeed("needs-attention" as const))),
        release: (project: ProjectSnapshot) => close(project.path),
      };
    }),
  );
