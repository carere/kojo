import { Database } from "bun:sqlite";
import { chmodSync, existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { BunCrypto } from "@effect/platform-bun";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import type { ProjectSnapshot } from "@kojo/control";
import { Context, Duration, Effect, Exit, Layer, Option, Schema, Scope } from "effect";
import {
  ClusterWorkflowEngine,
  RunnerAddress,
  ShardId,
  Sharding,
  SingleRunner,
} from "effect/unstable/cluster";
import { SqlClient } from "effect/unstable/sql";
import * as Activity from "effect/unstable/workflow/Activity";
import * as DurableClock from "effect/unstable/workflow/DurableClock";
import * as Workflow from "effect/unstable/workflow/Workflow";
import * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine";
import {
  type AnyLocalWorkflowDefinition,
  type LocalWorkflowOperations,
  WorkflowBackend,
  type WorkflowBackendAssessment,
  type WorkflowBackendReference,
  type WorkflowBackendState,
} from "./workflow-backend";

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

export const makeLocalWorkflowBackendLayer = (
  hostIdentity: string,
  definitions: ReadonlyArray<AnyLocalWorkflowDefinition> = [],
) => {
  const entries = makeEntries(definitions);
  const registrationLayer = entries.reduce<
    Layer.Layer<never, never, WorkflowEngine.WorkflowEngine>
  >((layer, entry) => Layer.merge(layer, entry.registration), Layer.empty);

  return Layer.effect(
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

      const tryAcquireOwnership = (project: ProjectSnapshot) =>
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

      const acquireOwnership = (project: ProjectSnapshot) =>
        Effect.gen(function* () {
          for (let attempt = 0; attempt < 5; attempt += 1) {
            if (yield* tryAcquireOwnership(project)) return true;
            if (attempt < 4) yield* Effect.sleep("25 millis");
          }
          return false;
        });

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
              shardingConfig: {
                entityMessagePollInterval: Duration.millis(25),
                entityReplyPollInterval: Duration.millis(25),
                refreshAssignmentsInterval: Duration.millis(25),
                runnerAddress: Option.some(ownerAddress),
              },
            }).pipe(Layer.provideMerge([Layer.succeedContext(sqlContext), BunCrypto.layer]));
            const context = yield* Layer.buildWithScope(
              ClusterWorkflowEngine.layer.pipe(Layer.provideMerge(support)),
              scope,
            );
            const sharding = Context.get(context, Sharding.Sharding);
            const engine = Context.get(context, WorkflowEngine.WorkflowEngine);
            yield* Layer.buildWithScope(
              registrationLayer.pipe(
                Layer.provide(Layer.succeed(WorkflowEngine.WorkflowEngine, engine)),
              ),
              scope,
            );
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
        submit: (project, { workflowKey, runId, input }) =>
          Effect.suspend(() => {
            const backend = getActiveBackend(active, project);
            const entry = getEntry(entries, workflowKey);
            return entry
              .submit(backend.engine, runId, input)
              .pipe(Effect.as(makeReference(workflowKey, runId)));
          }),
        observe: (project, reference) =>
          Effect.suspend(() => {
            const backend = getActiveBackend(active, project);
            const entry = getEntry(entries, reference.workflowKey);
            return entry.observe(backend.engine, reference.runId);
          }),
      };
    }),
  );
};

interface Entry {
  readonly workflowKey: string;
  readonly submit: (
    engine: WorkflowEngine.WorkflowEngine["Service"],
    runId: string,
    input: unknown,
  ) => Effect.Effect<void>;
  readonly observe: (
    engine: WorkflowEngine.WorkflowEngine["Service"],
    runId: string,
  ) => Effect.Effect<WorkflowBackendState>;
  readonly registration: Layer.Layer<never, never, WorkflowEngine.WorkflowEngine>;
}

const makeEntries = (
  definitions: ReadonlyArray<AnyLocalWorkflowDefinition>,
): ReadonlyArray<Entry> => {
  const workflowKeys = new Set<string>();
  return definitions.map((definition) => {
    if (workflowKeys.has(definition.workflowKey)) {
      throw new Error(`Duplicate Workflow Key: ${definition.workflowKey}`);
    }
    workflowKeys.add(definition.workflowKey);

    const workflow = Workflow.make(`Kojo/${definition.workflowKey}`, {
      payload: {
        runId: Schema.String,
        input: Schema.Unknown,
      },
      success: definition.successSchema,
      error: definition.failureSchema ?? Schema.Never,
      idempotencyKey: ({ runId }) => runId,
    });
    const operations = makeOperations();
    const registration = workflow.toLayer(({ input }) =>
      Schema.decodeUnknownEffect(definition.inputSchema)(input).pipe(
        Effect.orDie,
        Effect.flatMap((decoded) => definition.execute(decoded as never, operations)),
      ),
    );

    return {
      workflowKey: definition.workflowKey,
      submit: (engine, runId, input) =>
        workflow.executionId({ runId, input }).pipe(
          Effect.flatMap((executionId) =>
            engine.execute(workflow, {
              executionId,
              payload: { runId, input },
              discard: true,
            }),
          ),
          Effect.orDie,
          Effect.asVoid,
        ) as unknown as Effect.Effect<void>,
      observe: (engine, runId) =>
        workflow.executionId({ runId, input: undefined }).pipe(
          Effect.flatMap((executionId) => engine.poll(workflow, executionId)),
          Effect.map(toBackendState),
        ) as unknown as Effect.Effect<WorkflowBackendState>,
      registration: registration as unknown as Layer.Layer<
        never,
        never,
        WorkflowEngine.WorkflowEngine
      >,
    };
  });
};

const makeOperations = (): LocalWorkflowOperations => ({
  activity: <
    Success extends Schema.Top,
    Failure extends Schema.Top = typeof Schema.Never,
  >(options: {
    readonly operationKey: string;
    readonly successSchema: Success;
    readonly failureSchema?: Failure;
    readonly execute: Effect.Effect<Success["Type"], Failure["Type"]>;
  }) => {
    const failureSchema = options.failureSchema ?? (Schema.Never as unknown as Failure);
    return Activity.make({
      name: options.operationKey,
      success: options.successSchema,
      error: failureSchema,
      execute: options.execute,
    }) as unknown as Effect.Effect<Success["Type"], Failure["Type"]>;
  },
  sleep: ({ operationKey, duration }) =>
    DurableClock.sleep({
      name: operationKey,
      duration,
      inMemoryThreshold: Duration.zero,
    }) as never,
});

const getActiveBackend = (
  active: ReadonlyMap<string, ActiveBackend>,
  project: ProjectSnapshot,
): ActiveBackend => {
  const backend = active.get(project.path);
  if (backend === undefined) {
    throw new Error(`Project Workflow Backend is not active: ${project.identity}`);
  }
  return backend;
};

const getEntry = (entries: ReadonlyArray<Entry>, workflowKey: string): Entry => {
  const entry = entries.find((candidate) => candidate.workflowKey === workflowKey);
  if (entry === undefined) throw new Error(`Unknown Workflow Key: ${workflowKey}`);
  return entry;
};

const makeReference = (workflowKey: string, runId: string): WorkflowBackendReference =>
  ({ workflowKey, runId }) as WorkflowBackendReference;

const toBackendState = (
  result: Option.Option<Workflow.Result<unknown, unknown>>,
): WorkflowBackendState => {
  if (Option.isNone(result)) return { _tag: "Pending" };
  if (result.value._tag === "Suspended") return { _tag: "Waiting" };
  if (Exit.isSuccess(result.value.exit)) {
    return { _tag: "Completed", result: result.value.exit.value };
  }
  return { _tag: "Failed" };
};
