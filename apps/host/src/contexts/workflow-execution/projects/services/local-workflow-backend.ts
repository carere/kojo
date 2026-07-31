import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { BunCrypto } from "@effect/platform-bun";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import type { ProjectSnapshot } from "@kojo/control";
import {
  type WorkflowActivityAttempt,
  type WorkflowActivityOptions,
  WorkflowActivityRuntime,
} from "@kojo/workflow";
import { Cause, Context, Duration, Effect, Exit, Layer, Option, Schema, Scope } from "effect";
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
import { workflowActivityIdempotencyKey } from "../../runs/models/workflow-activity";
import type {
  WorkflowActivityAttemptRecord,
  WorkflowActivityOperation,
  WorkflowRunRepository,
} from "../../runs/repositories/workflow-run-repository";
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
    const journal = yield* sql.unsafe<{ readonly journal_mode: string }>(
      "PRAGMA journal_mode = WAL",
    );
    const settings = yield* sql.unsafe<{
      readonly foreign_keys: number;
      readonly synchronous: number;
    }>(
      "SELECT (SELECT foreign_keys FROM pragma_foreign_keys) AS foreign_keys, (SELECT synchronous FROM pragma_synchronous) AS synchronous",
    );
    if (
      journal[0]?.journal_mode.toLowerCase() !== "wal" ||
      settings[0]?.foreign_keys !== 1 ||
      settings[0]?.synchronous !== 2
    ) {
      return yield* Effect.die("Effect Workflow database safety settings are unavailable");
    }
  });

interface ActiveBackend {
  activityRepository?: WorkflowRunRepository["Service"];
  readonly engine: WorkflowEngine.WorkflowEngine["Service"];
  readonly entries: Map<string, Entry>;
  readonly recoveredRuns: Set<string>;
  readonly scope: Scope.Closeable;
  readonly sharding: Sharding.Sharding["Service"];
  readonly startedAtMs: number;
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
  const defaultEntries = makeEntries(definitions);
  const registrationLayer = defaultEntries.reduce<
    Layer.Layer<never, never, WorkflowEngine.WorkflowEngine>
  >((layer, entry) => Layer.merge(layer, entry.registration), Layer.empty);

  return Layer.effect(
    WorkflowBackend,
    Effect.gen(function* () {
      const parentScope = yield* Effect.scope;
      const active = new Map<string, ActiveBackend>();
      const ownership = new Map<string, Database>();
      // Host identity is stable for diagnostics, but a Cluster runner address
      // identifies one live process. A new address after a crash lets the
      // replacement Host acquire the abandoned mailbox shards.
      const ownerAddress = RunnerAddress.make(`${hostIdentity}:${randomUUID()}`, 34_431);

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
                // A local Host is the sole runner for a Project. Keep the recovery
                // lease short so an abrupt process loss does not strand an active
                // Activity behind the cluster default's 35-second lock expiry.
                shardLockExpiration: Duration.seconds(1),
                shardLockRefreshInterval: Duration.millis(25),
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
            active.set(project.path, {
              engine,
              entries: new Map(defaultEntries.map((entry) => [entry.identity, entry])),
              recoveredRuns: new Set(),
              scope,
              sharding,
              startedAtMs: Date.now(),
            });
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

      const register = (
        project: ProjectSnapshot,
        definitions: ReadonlyArray<AnyLocalWorkflowDefinition>,
        activityRepository?: WorkflowRunRepository["Service"],
      ) =>
        Effect.gen(function* () {
          const backend = getActiveBackend(active, project);
          if (activityRepository !== undefined) {
            backend.activityRepository = activityRepository;
            if (activityRepository.recoverActivitySubmission !== undefined) {
              for (const activeRun of yield* activityRepository.activeRuns(project)) {
                if (backend.recoveredRuns.has(activeRun.runId)) continue;
                yield* activityRepository
                  .recoverActivitySubmission(project, activeRun.runId, backend.startedAtMs)
                  .pipe(
                    Effect.tap(() => Effect.sync(() => backend.recoveredRuns.add(activeRun.runId))),
                  );
              }
            }
          }
          for (const entry of makeEntries(definitions, project, activityRepository)) {
            if (backend.entries.has(entry.identity)) continue;
            yield* Layer.buildWithScope(
              entry.registration.pipe(
                Layer.provide(Layer.succeed(WorkflowEngine.WorkflowEngine, backend.engine)),
              ),
              backend.scope,
            );
            backend.entries.set(entry.identity, entry);
          }
        });

      yield* Effect.addFinalizer(() =>
        Effect.forEach(Array.from(ownership.keys()), releaseOwnership, { discard: true }),
      );

      return {
        hostIdentity,
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
        register,
        submit: (project, { workflowKey, workflowRevision, runId, input, engineGeneration }) =>
          Effect.suspend(() => {
            const backend = getActiveBackend(active, project);
            const entry = getEntry(backend.entries, workflowKey, workflowRevision);
            return entry
              .submit(backend.engine, runId, input, engineGeneration ?? 1)
              .pipe(Effect.as(makeReference(workflowKey, workflowRevision, runId)));
          }),
        observe: (project, reference) =>
          Effect.suspend(() => {
            const backend = getActiveBackend(active, project);
            const entry = getEntry(
              backend.entries,
              reference.workflowKey,
              reference.workflowRevision,
            );
            const generation =
              backend.activityRepository?.engineGeneration === undefined
                ? Effect.succeed(1)
                : backend.activityRepository
                    .engineGeneration(project, reference.runId)
                    .pipe(Effect.map((value) => value ?? 1));
            return generation.pipe(
              Effect.flatMap((engineGeneration) =>
                entry.observe(backend.engine, reference.runId, engineGeneration),
              ),
            );
          }),
      };
    }),
  );
};

interface Entry {
  readonly identity: string;
  readonly workflowKey: string;
  readonly workflowRevision: string;
  readonly submit: (
    engine: WorkflowEngine.WorkflowEngine["Service"],
    runId: string,
    input: unknown,
    engineGeneration: number,
  ) => Effect.Effect<void>;
  readonly observe: (
    engine: WorkflowEngine.WorkflowEngine["Service"],
    runId: string,
    engineGeneration: number,
  ) => Effect.Effect<WorkflowBackendState>;
  readonly registration: Layer.Layer<never, never, WorkflowEngine.WorkflowEngine>;
}

const makeEntries = (
  definitions: ReadonlyArray<AnyLocalWorkflowDefinition>,
  project?: ProjectSnapshot,
  activityRepository?: WorkflowRunRepository["Service"],
): ReadonlyArray<Entry> => {
  const identities = new Set<string>();
  return definitions.map((definition) => {
    const workflowRevision = definition.revision ?? "default";
    const identity = `${definition.workflowKey}:${workflowRevision}`;
    if (identities.has(identity)) {
      throw new Error(`Duplicate Workflow Definition: ${identity}`);
    }
    identities.add(identity);

    const workflow = Workflow.make(`Kojo/${definition.workflowKey}/${workflowRevision}`, {
      payload: {
        engineGeneration: Schema.Number,
        runId: Schema.String,
        input: Schema.Unknown,
      },
      success: definition.successSchema,
      error: definition.failureSchema ?? Schema.Never,
      idempotencyKey: ({ runId, engineGeneration }) => `${runId}:${engineGeneration}`,
    });
    const operations = makeOperations();
    const registration = workflow.toLayer(({ input, runId }) =>
      Schema.decodeUnknownEffect(definition.inputSchema)(input).pipe(
        Effect.orDie,
        Effect.flatMap((decoded) =>
          definition
            .execute(decoded as never, operations)
            .pipe(
              Effect.provideService(
                WorkflowActivityRuntime,
                makeWorkflowActivityRuntime(project, runId, activityRepository),
              ),
            ),
        ),
        Effect.flatMap((result) =>
          Schema.encodeUnknownEffect(definition.successSchema)(result).pipe(
            Effect.orDie,
            Effect.as(result),
          ),
        ),
      ),
    );

    return {
      identity,
      workflowKey: definition.workflowKey,
      workflowRevision,
      submit: (engine, runId, input, engineGeneration) =>
        workflow.executionId({ engineGeneration, runId, input }).pipe(
          Effect.flatMap((executionId) =>
            engine.execute(workflow, {
              executionId,
              payload: { engineGeneration, runId, input },
              discard: true,
            }),
          ),
          Effect.orDie,
          Effect.asVoid,
        ) as unknown as Effect.Effect<void>,
      observe: (engine, runId, engineGeneration) =>
        workflow.executionId({ engineGeneration, runId, input: undefined }).pipe(
          Effect.flatMap((executionId) => engine.poll(workflow, executionId)),
          Effect.map(toBackendState),
          Effect.catchCause(() => Effect.succeed({ _tag: "Failed" } as const)),
        ) as unknown as Effect.Effect<WorkflowBackendState>,
      registration: registration as unknown as Layer.Layer<
        never,
        never,
        WorkflowEngine.WorkflowEngine
      >,
    };
  });
};

const activityFingerprint = <Success extends Schema.Top, Failure extends Schema.Top>(
  options: WorkflowActivityOptions<Success, Failure>,
  activityName: string,
) => {
  const schema = (value: Schema.Top) => {
    try {
      return JSON.stringify((value as { readonly ast?: unknown }).ast ?? null);
    } catch {
      return "unencodable-schema";
    }
  };
  return createHash("sha256")
    .update(
      JSON.stringify({
        activityName,
        execute: options.execute.toString(),
        failure: schema(options.failureSchema ?? Schema.Never),
        retry: options.retry ?? { idempotency: "stable", maxRetries: 0 },
        success: schema(options.successSchema),
      }),
    )
    .digest("hex");
};

const makeWorkflowActivityRuntime = (
  project: ProjectSnapshot | undefined,
  runId: string,
  repository: WorkflowRunRepository["Service"] | undefined,
): WorkflowActivityRuntime["Service"] => ({
  execute: <Success extends Schema.Top, Failure extends Schema.Top = typeof Schema.Never>(
    options: WorkflowActivityOptions<Success, Failure>,
  ) => {
    const activityName = options.name ?? options.operationKey;
    if (
      project === undefined ||
      repository === undefined ||
      options.operationKey.trim().length === 0 ||
      activityName.trim().length === 0 ||
      (options.retry !== undefined &&
        (!Number.isInteger(options.retry.maxRetries) || options.retry.maxRetries < 0))
    ) {
      return Effect.die(
        "Workflow Activity is not configured for durable execution",
      ) as Effect.Effect<Success["Type"], Failure["Type"]>;
    }
    const operation: WorkflowActivityOperation = {
      activityName,
      definitionFingerprint: activityFingerprint(options, activityName),
      durableOperationKey: options.operationKey,
    };
    return Effect.suspend(() =>
      Effect.gen(function* () {
        const prepared = yield* Effect.gen(function* () {
          for (let poll = 0; poll < 100; poll += 1) {
            const preparation = yield* repository.prepareActivity(
              project,
              runId,
              operation,
              Date.now(),
            );
            if (preparation._tag !== "awaiting-confirmation") return preparation;
            yield* Effect.sleep("10 millis");
          }
          return yield* Effect.die(
            `Workflow Activity confirmation stalled: ${operation.durableOperationKey}`,
          );
        });
        if (prepared._tag === "conflict") {
          return yield* Effect.die(
            `Conflicting Durable Operation Key: ${operation.durableOperationKey}`,
          );
        }
        if (prepared._tag === "completed") {
          yield* repository.recordActivityReplayReuse(
            project,
            runId,
            operation,
            prepared.confirmedAttemptId,
            Date.now(),
          );
          return prepared.result as Success["Type"];
        }

        let lastAttempt: WorkflowActivityAttemptRecord | undefined;
        let observed = false;
        const invoke = Effect.suspend(() =>
          Effect.gen(function* () {
            const effectRetryNumber = yield* Activity.CurrentAttempt;
            const activityIdempotencyKey = workflowActivityIdempotencyKey(
              runId,
              operation.durableOperationKey,
              options.retry?.idempotency ?? "stable",
              effectRetryNumber,
            );
            const attempt = yield* repository.startActivityAttempt(
              project,
              runId,
              operation,
              {
                activityIdempotencyKey,
                effectRetryNumber,
                executionGeneration: prepared.executionGeneration,
              },
              Date.now(),
            );
            lastAttempt = attempt;
            const externalAttempt: WorkflowActivityAttempt = {
              attemptId: attempt.attemptId,
              effectRetryNumber: attempt.effectRetryNumber,
              idempotencyKey: attempt.activityIdempotencyKey,
              invocationNumber: attempt.invocationNumber,
            };
            return yield* options.execute(externalAttempt).pipe(
              Effect.onExit((exit) => {
                if (Exit.isSuccess(exit)) {
                  return repository
                    .observeActivityAttempt(
                      project,
                      runId,
                      attempt.attemptId,
                      "success",
                      Date.now(),
                    )
                    .pipe(
                      Effect.tap(() =>
                        Effect.sync(() => {
                          observed = true;
                        }),
                      ),
                    );
                }
                if (Cause.hasInterrupts(exit.cause)) return Effect.void;
                return repository
                  .observeActivityAttempt(project, runId, attempt.attemptId, "failure", Date.now())
                  .pipe(
                    Effect.tap(() =>
                      Effect.sync(() => {
                        observed = true;
                      }),
                    ),
                  );
              }),
            );
          }),
        );
        const execute =
          options.retry === undefined
            ? invoke
            : Activity.retry(invoke, { times: options.retry.maxRetries });
        const durable = Activity.make({
          name: `${activityName}/${prepared.executionGeneration}`,
          success: options.successSchema,
          error: options.failureSchema ?? (Schema.Never as unknown as Failure),
          execute,
        });
        const exit = yield* Effect.exit(durable);
        if (lastAttempt !== undefined && observed && Exit.isSuccess(exit)) {
          yield* repository.confirmActivityAttempt(
            project,
            runId,
            lastAttempt.attemptId,
            exit.value,
            Date.now(),
          );
        }
        return yield* exit;
      }),
    ) as Effect.Effect<Success["Type"], Failure["Type"]>;
  },
});

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

const getEntry = (
  entries: ReadonlyMap<string, Entry>,
  workflowKey: string,
  workflowRevision: string,
): Entry => {
  const entry = entries.get(`${workflowKey}:${workflowRevision}`);
  if (entry === undefined) throw new Error(`Unknown Workflow Key: ${workflowKey}`);
  return entry;
};

const makeReference = (
  workflowKey: string,
  workflowRevision: string,
  runId: string,
): WorkflowBackendReference =>
  ({ workflowKey, workflowRevision, runId }) as WorkflowBackendReference;

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
