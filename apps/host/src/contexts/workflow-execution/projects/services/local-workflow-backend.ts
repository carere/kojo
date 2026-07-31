import { Database } from "bun:sqlite";
import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BunCrypto } from "@effect/platform-bun";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import type { ProjectSnapshot } from "@kojo/control";
import type {
  AcquiredWorkflowSandbox,
  Command,
  CommandFailure,
  CommandResult,
  WorkflowChildInvocation,
  WorkflowDeferred,
  WorkflowSandboxDefinition,
} from "@kojo/workflow";
import {
  AcquiredWorkflowSandbox as AcquiredWorkflowSandboxSchema,
  CommandFailure as CommandFailureSchema,
  CommandResult as CommandResultSchema,
  SandboxProviderFailure as SandboxProviderFailureSchema,
  type WorkflowActivityAttempt,
  type WorkflowActivityOptions,
  WorkflowActivityRuntime,
  WorkflowChildFailure,
  WorkflowChildRuntime,
  WorkflowCommandRuntime,
  WorkflowSandboxRuntime,
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
import * as DurableDeferred from "effect/unstable/workflow/DurableDeferred";
import * as Workflow from "effect/unstable/workflow/Workflow";
import * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine";
import { workflowActivityIdempotencyKey } from "../../runs/models/workflow-activity";
import type {
  WorkflowActivityAttemptRecord,
  WorkflowActivityOperation,
  WorkflowRunRepository,
} from "../../runs/repositories/workflow-run-repository";
import {
  ProviderRuntime,
  ProviderRuntimeUnavailable,
} from "../../sandboxes/services/provider-runtime";
import {
  type AnyLocalWorkflowDefinition,
  type LocalWorkflowOperations,
  WorkflowBackend,
  type WorkflowBackendAssessment,
  type WorkflowBackendDeferredCompletionResult,
  type WorkflowBackendReference,
  type WorkflowBackendResumeResult,
  type WorkflowBackendState,
  type WorkflowBackendSuspension,
  type WorkflowScheduleWakeup,
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
  providerRuntime: ProviderRuntime["Service"] = ProviderRuntimeUnavailable,
) => {
  return Layer.effect(
    WorkflowBackend,
    Effect.gen(function* () {
      const selectedProviderRuntime = Option.getOrElse(
        yield* Effect.serviceOption(ProviderRuntime),
        () => providerRuntime,
      );
      const defaultEntries = makeEntries(
        definitions,
        undefined,
        undefined,
        selectedProviderRuntime,
      );
      const registrationLayer = defaultEntries.reduce<
        Layer.Layer<never, never, WorkflowEngine.WorkflowEngine>
      >((layer, entry) => Layer.merge(layer, entry.registration), Layer.empty);
      const parentScope = yield* Effect.scope;
      const active = new Map<string, ActiveBackend>();
      const ownership = new Map<string, Database>();
      const dueScheduleWakeups = new Map<string, Map<string, WorkflowScheduleWakeup>>();
      const scheduleWakeupWorkflow = Workflow.make("Kojo/ScheduleWakeup/v1", {
        payload: Schema.Struct({
          projectIdentity: Schema.String,
          scheduleKey: Schema.String,
          scheduledAtMs: Schema.Number,
          scheduleRevision: Schema.String,
        }),
        success: Schema.Void,
        error: Schema.Never,
        idempotencyKey: ({ projectIdentity, scheduleKey, scheduledAtMs }) =>
          `${projectIdentity}:${scheduleKey}:${scheduledAtMs}`,
      });
      const scheduleWakeupRegistration = scheduleWakeupWorkflow.toLayer((wakeup) =>
        Effect.gen(function* () {
          yield* DurableClock.sleep({
            name: "wait-for-occurrence",
            duration: Duration.millis(Math.max(0, wakeup.scheduledAtMs - Date.now())),
            inMemoryThreshold: Duration.zero,
          });
          yield* Effect.sync(() => {
            const wakeups = dueScheduleWakeups.get(wakeup.projectIdentity) ?? new Map();
            wakeups.set(`${wakeup.scheduleKey}:${wakeup.scheduledAtMs}`, {
              scheduleKey: wakeup.scheduleKey,
              scheduledAtMs: wakeup.scheduledAtMs,
              scheduleRevision: wakeup.scheduleRevision,
            });
            dueScheduleWakeups.set(wakeup.projectIdentity, wakeups);
          });
        }),
      );
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
              Layer.merge(registrationLayer, scheduleWakeupRegistration).pipe(
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
        quiesce(project.path).pipe(
          Effect.andThen(selectedProviderRuntime.releaseProject(project)),
          Effect.andThen(releaseOwnership(project.path)),
        );

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
          const childDispatcher: ChildRunDispatcher = {
            invoke: (parentRunId, parent, invocation) =>
              invokeChildWorkflowRun(
                backend,
                project,
                activityRepository,
                parentRunId,
                parent,
                invocation,
              ),
          };
          for (const entry of makeEntries(
            definitions,
            project,
            activityRepository,
            selectedProviderRuntime,
            childDispatcher,
          )) {
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

      const currentEngineGeneration = (
        backend: ActiveBackend,
        project: ProjectSnapshot,
        runId: string,
      ) =>
        backend.activityRepository?.engineGeneration === undefined
          ? Effect.succeed(1)
          : backend.activityRepository
              .engineGeneration(project, runId)
              .pipe(Effect.map((value) => value ?? 1));

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
        armScheduleWakeup: (project, wakeup) =>
          Effect.suspend(() => {
            const backend = getActiveBackend(active, project);
            const payload = {
              projectIdentity: project.identity,
              scheduleKey: wakeup.scheduleKey,
              scheduledAtMs: wakeup.scheduledAtMs,
              scheduleRevision: wakeup.scheduleRevision,
            };
            return scheduleWakeupWorkflow.executionId(payload).pipe(
              Effect.flatMap((executionId) =>
                backend.engine.execute(scheduleWakeupWorkflow, {
                  executionId,
                  payload,
                  discard: true,
                }),
              ),
              Effect.orDie,
              Effect.asVoid,
            ) as unknown as Effect.Effect<void>;
          }),
        takeDueScheduleWakeups: (project) =>
          Effect.sync(() => {
            const wakeups = dueScheduleWakeups.get(project.identity);
            if (wakeups === undefined) return [];
            dueScheduleWakeups.delete(project.identity);
            return [...wakeups.values()];
          }),
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
            return currentEngineGeneration(backend, project, reference.runId).pipe(
              Effect.flatMap((engineGeneration) =>
                entry.observe(backend.engine, reference.runId, engineGeneration),
              ),
            );
          }),
        resume: (project, reference, value) =>
          Effect.suspend(() => {
            const backend = getActiveBackend(active, project);
            const entry = getEntry(
              backend.entries,
              reference.workflowKey,
              reference.workflowRevision,
            );
            return currentEngineGeneration(backend, project, reference.runId).pipe(
              Effect.flatMap((engineGeneration) =>
                entry.resume(backend.engine, reference.runId, engineGeneration, value),
              ),
            );
          }),
        completeDeferred: (project, reference, token, value) =>
          Effect.suspend(() => {
            const backend = getActiveBackend(active, project);
            const entry = getEntry(
              backend.entries,
              reference.workflowKey,
              reference.workflowRevision,
            );
            return currentEngineGeneration(backend, project, reference.runId).pipe(
              Effect.flatMap((engineGeneration) =>
                entry.completeDeferred(
                  backend.engine,
                  reference.runId,
                  engineGeneration,
                  token,
                  value,
                ),
              ),
            );
          }),
        rehydrate: (project, reference) =>
          Effect.suspend(() => {
            const backend = getActiveBackend(active, project);
            const entry = getEntry(
              backend.entries,
              reference.workflowKey,
              reference.workflowRevision,
            );
            return currentEngineGeneration(backend, project, reference.runId).pipe(
              Effect.flatMap((engineGeneration) =>
                entry.rehydrate(backend.engine, reference.runId, engineGeneration),
              ),
            );
          }),
      };
    }),
  );
};

interface Entry {
  readonly definition: AnyLocalWorkflowDefinition;
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
  readonly resume: (
    engine: WorkflowEngine.WorkflowEngine["Service"],
    runId: string,
    engineGeneration: number,
    value: unknown,
  ) => Effect.Effect<WorkflowBackendResumeResult>;
  readonly completeDeferred: (
    engine: WorkflowEngine.WorkflowEngine["Service"],
    runId: string,
    engineGeneration: number,
    token: string,
    value: unknown,
  ) => Effect.Effect<WorkflowBackendDeferredCompletionResult>;
  readonly rehydrate: (
    engine: WorkflowEngine.WorkflowEngine["Service"],
    runId: string,
    engineGeneration: number,
  ) => Effect.Effect<void>;
  readonly registration: Layer.Layer<never, never, WorkflowEngine.WorkflowEngine>;
}

interface ChildRunDispatcher {
  readonly invoke: (
    parentRunId: string,
    parent: AnyLocalWorkflowDefinition,
    invocation: WorkflowChildInvocation,
  ) => Effect.Effect<unknown, WorkflowChildFailure>;
}

const makeEntries = (
  definitions: ReadonlyArray<AnyLocalWorkflowDefinition>,
  project?: ProjectSnapshot,
  activityRepository?: WorkflowRunRepository["Service"],
  providerRuntime: ProviderRuntime["Service"] = ProviderRuntimeUnavailable,
  childDispatcher?: ChildRunDispatcher,
): ReadonlyArray<Entry> => {
  const identities = new Set<string>();
  return definitions.map((definition) => {
    const workflowRevision = definition.revision ?? "default";
    const identity = `${definition.workflowKey}:${workflowRevision}`;
    if (identities.has(identity)) {
      throw new Error(`Duplicate Workflow Definition: ${identity}`);
    }
    identities.add(identity);

    // An unhandled child failure is still a valid terminal failure for the parent,
    // even when the parent's declared failure schema does not describe it. Keep the
    // structured error in the engine so callers may catch it in workflow code; once
    // it reaches the workflow boundary, the Host records the parent as failed.
    const workflow = Workflow.make(`Kojo/${definition.workflowKey}/${workflowRevision}`, {
      payload: {
        engineGeneration: Schema.Number,
        runId: Schema.String,
        input: Schema.Unknown,
      },
      success: definition.successSchema,
      error: Schema.Union([
        definition.failureSchema ?? Schema.Never,
        Schema.Struct({
          _tag: Schema.Literal("WorkflowChildFailure"),
          invocationKey: Schema.String,
          runId: Schema.String,
          workflowKey: Schema.String,
        }),
      ]),
      idempotencyKey: ({ runId, engineGeneration }) => `${runId}:${engineGeneration}`,
    });
    const waits = new Map<string, RegisteredWait>();
    const operations = makeOperations(waits);
    const registration = workflow.toLayer(({ input, runId }) =>
      Schema.decodeUnknownEffect(definition.inputSchema)(input).pipe(
        Effect.orDie,
        Effect.flatMap((decoded) => {
          const sandboxDefinitions = new Map<string, WorkflowSandboxDefinition>();
          const activityRuntime = makeWorkflowActivityRuntime(project, runId, activityRepository);
          return definition
            .execute(decoded as never, operations)
            .pipe(
              Effect.provideService(WorkflowActivityRuntime, activityRuntime),
              Effect.provideService(
                WorkflowSandboxRuntime,
                makeWorkflowSandboxRuntime(
                  project,
                  runId,
                  activityRuntime,
                  activityRepository,
                  providerRuntime,
                  sandboxDefinitions,
                ),
              ),
              Effect.provideService(
                WorkflowCommandRuntime,
                makeWorkflowCommandRuntime(
                  project,
                  runId,
                  activityRuntime,
                  activityRepository,
                  providerRuntime,
                  sandboxDefinitions,
                ),
              ),
              Effect.provideService(
                WorkflowChildRuntime,
                makeWorkflowChildRuntime(runId, definition, childDispatcher),
              ),
            );
        }),
        Effect.flatMap((result) =>
          Schema.encodeUnknownEffect(definition.successSchema)(result).pipe(
            Effect.orDie,
            Effect.as(result),
          ),
        ),
      ),
    );

    return {
      definition,
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
          Effect.flatMap((executionId) =>
            engine
              .poll(workflow, executionId)
              .pipe(Effect.map((state) => toBackendState(state, waits.get(executionId)))),
          ),
          Effect.catchCause(() => Effect.succeed({ _tag: "Failed" } as const)),
        ) as unknown as Effect.Effect<WorkflowBackendState>,
      resume: (engine, runId, engineGeneration, value) =>
        workflow.executionId({ engineGeneration, runId, input: undefined }).pipe(
          Effect.flatMap(
            (executionId): Effect.Effect<WorkflowBackendResumeResult, never, unknown> => {
              const wait = waits.get(executionId);
              if (wait === undefined || wait.suspension.kind !== "manual") {
                return Effect.succeed({ _tag: "not-manually-suspended" } as const);
              }
              return completeWait(engine, wait, value).pipe(
                Effect.map((result) =>
                  result ? ({ _tag: "resumed" } as const) : ({ _tag: "invalid-value" } as const),
                ),
              );
            },
          ),
        ) as unknown as Effect.Effect<WorkflowBackendResumeResult>,
      completeDeferred: (engine, runId, engineGeneration, token, value) =>
        workflow.executionId({ engineGeneration, runId, input: undefined }).pipe(
          Effect.flatMap(
            (
              executionId,
            ): Effect.Effect<WorkflowBackendDeferredCompletionResult, never, unknown> => {
              const wait = waits.get(executionId);
              if (
                wait === undefined ||
                wait.suspension.kind !== "deferred" ||
                wait.completionToken !== token
              ) {
                return Effect.succeed({ _tag: "not-deferred" } as const);
              }
              return completeWait(engine, wait, value).pipe(
                Effect.map((result) =>
                  result ? ({ _tag: "completed" } as const) : ({ _tag: "invalid-value" } as const),
                ),
              );
            },
          ),
        ) as unknown as Effect.Effect<WorkflowBackendDeferredCompletionResult>,
      rehydrate: (engine, runId, engineGeneration) =>
        workflow.executionId({ engineGeneration, runId, input: undefined }).pipe(
          Effect.flatMap((executionId) =>
            waits.has(executionId) ? Effect.void : engine.resume(workflow, executionId),
          ),
          Effect.catchCause(() => Effect.void),
        ) as unknown as Effect.Effect<void>,
      registration: registration as unknown as Layer.Layer<
        never,
        never,
        WorkflowEngine.WorkflowEngine
      >,
    };
  });
};

interface RegisteredWait {
  readonly deferred: DurableDeferred.DurableDeferred<Schema.Top>;
  readonly engineToken: string;
  readonly suspension: WorkflowBackendSuspension;
  readonly completionToken?: WorkflowDeferred<Schema.Top>["token"];
  readonly valueSchema: Schema.Top;
}

const deferredTokenPrefix = "kojo.deferred.v1.";

const toWorkflowDeferredToken = (engineToken: string): WorkflowDeferred<Schema.Top>["token"] =>
  `${deferredTokenPrefix}${Buffer.from(engineToken).toString("base64url")}` as WorkflowDeferred<Schema.Top>["token"];

const toEngineDeferredToken = (token: string): string | undefined => {
  if (!token.startsWith(deferredTokenPrefix)) return undefined;
  try {
    const engineToken = Buffer.from(
      token.slice(deferredTokenPrefix.length),
      "base64url",
    ).toString();
    return engineToken.length === 0 ? undefined : engineToken;
  } catch {
    return undefined;
  }
};

const validOperationKey = (operationKey: string) =>
  operationKey.length > 0 && operationKey.length <= 200;

const assertOperationKey = (operationKey: string) => {
  if (!validOperationKey(operationKey)) {
    throw new Error("A Durable Operation Key must contain from 1 to 200 characters.");
  }
};

const completeWait = (
  engine: WorkflowEngine.WorkflowEngine["Service"],
  wait: RegisteredWait,
  value: unknown,
) =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(wait.valueSchema as typeof Schema.Unknown)(value),
    catch: () => undefined,
  }).pipe(
    Effect.matchEffect({
      onFailure: () => Effect.succeed(false),
      onSuccess: (decoded) =>
        DurableDeferred.succeed(wait.deferred, {
          token: wait.engineToken as never,
          value: decoded,
        }).pipe(Effect.provideService(WorkflowEngine.WorkflowEngine, engine), Effect.as(true)),
    }),
  );

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
        definitionIdentity: options.definitionIdentity,
        execute: options.execute.toString(),
        failure: schema(options.failureSchema ?? Schema.Never),
        retry: options.retry ?? { idempotency: "stable", maxRetries: 0 },
        success: schema(options.successSchema),
      }),
    )
    .digest("hex");
};

const sandboxDefinitionIdentity = (sandbox: WorkflowSandboxDefinition) =>
  createHash("sha256")
    .update(
      JSON.stringify({
        image:
          sandbox.image === undefined
            ? undefined
            : {
                imageKey: sandbox.image.imageKey,
                revision: sandbox.image.revision,
                source: sandbox.image.source,
              },
        provider: {
          kind: sandbox.provider.kind,
          providerKey: sandbox.provider.providerKey,
          revision: sandbox.provider.revision,
        },
        revision: sandbox.revision,
        sandboxKey: sandbox.sandboxKey,
      }),
    )
    .digest("hex");

const workflowSandboxIdentity = (runId: string, operationKey: string) =>
  createHash("sha256").update(`${runId}:${operationKey}`).digest("hex");

const acquiredSandbox = (
  runId: string,
  operationKey: string,
  definition: WorkflowSandboxDefinition,
): AcquiredWorkflowSandbox => ({
  _tag: "workflow-sandbox",
  identity: workflowSandboxIdentity(runId, operationKey),
  operationKey,
  providerKind: definition.provider.kind,
  providerKey: definition.provider.providerKey,
  providerRevision: definition.provider.revision,
  sandboxKey: definition.sandboxKey,
  revision: definition.revision,
  ...(definition.image === undefined
    ? {}
    : { imageKey: definition.image.imageKey, imageRevision: definition.image.revision }),
});

const commandDefinitionIdentity = (command: Command, sandbox: AcquiredWorkflowSandbox) =>
  createHash("sha256")
    .update(
      JSON.stringify({
        arguments: command.arguments,
        commandKey: command.commandKey,
        environment: command.environment,
        nonZeroExit: command.nonZeroExit ?? "fail",
        revision: command.revision,
        sandboxIdentity: sandbox.identity,
        shell: command.shell ?? "none",
        timeout: command.timeout,
        workingDirectory: command.workingDirectory,
      }),
    )
    .digest("hex");

const artifactDirectory = (project: ProjectSnapshot, runId: string) =>
  join(project.path, ".kojo", "artifacts", runId);

const writeSandboxArtifact = (
  project: ProjectSnapshot,
  runId: string,
  displayName: string,
  content: unknown,
) =>
  Effect.tryPromise({
    try: async () => {
      if (!/^[0-9a-f-]{36}$/.test(runId)) throw new Error("Workflow Run Identity is invalid.");
      const artifactId = randomUUID();
      const directory = artifactDirectory(project, runId);
      const storageKey = `${runId}/${artifactId}.json`;
      const encoded = `${JSON.stringify(content)}\n`;
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(join(directory, `${artifactId}.json`), encoded, { mode: 0o600 });
      return {
        artifactId,
        byteSize: Buffer.byteLength(encoded),
        displayName,
        mediaType: "application/json",
        sha256: createHash("sha256").update(encoded).digest(),
        storageKey,
      };
    },
    catch: () => ({
      _tag: "sandbox-provider-failure" as const,
      message: "Workflow Sandbox Artifact could not be recorded.",
    }),
  });

const makeWorkflowSandboxRuntime = (
  project: ProjectSnapshot | undefined,
  runId: string,
  activityRuntime: WorkflowActivityRuntime["Service"],
  repository: WorkflowRunRepository["Service"] | undefined,
  providerRuntime: ProviderRuntime["Service"],
  definitions: Map<string, WorkflowSandboxDefinition>,
): WorkflowSandboxRuntime["Service"] => ({
  acquire: ({ operationKey, sandbox }) => {
    if (project === undefined || repository === undefined || !validOperationKey(operationKey)) {
      return Effect.fail({
        _tag: "sandbox-provider-failure" as const,
        message: "Workflow Sandbox is not configured for durable execution.",
      });
    }
    const logical = acquiredSandbox(runId, operationKey, sandbox);
    definitions.set(logical.identity, sandbox);
    return activityRuntime.execute({
      definitionIdentity: sandboxDefinitionIdentity(sandbox),
      failureSchema: SandboxProviderFailureSchema,
      name: `Acquire Sandbox ${sandbox.sandboxKey}@${sandbox.revision}`,
      operationKey,
      successSchema: AcquiredWorkflowSandboxSchema,
      execute: () =>
        providerRuntime
          .acquire({
            definition: sandbox,
            project,
            runId,
            sandbox: logical,
          })
          .pipe(
            Effect.flatMap((acquisition) =>
              Effect.gen(function* () {
                const artifact = yield* writeSandboxArtifact(
                  project,
                  runId,
                  "sandbox-worktree.json",
                  {
                    providerKind: acquisition.providerKind,
                    sandboxIdentity: logical.identity,
                    worktreeBranch: acquisition.worktreeBranch,
                  },
                );
                yield* repository.recordSandboxTrace(project, runId, {
                  artifactIds: [artifact.artifactId],
                  artifacts: [artifact],
                  durationMs: null,
                  exitCode: null,
                  kind: "sandbox.acquired",
                  operationKey,
                  providerKind: acquisition.providerKind,
                  recordedAtMs: Date.now(),
                  sandboxIdentity: logical.identity,
                });
                return logical;
              }),
            ),
          ),
    });
  },
});

const commandFailure = (
  sandboxIdentity: string,
  message: string,
  tag: CommandFailure["_tag"],
  exitCode?: number,
): CommandFailure => ({
  _tag: tag,
  ...(exitCode === undefined ? {} : { exitCode }),
  message,
  sandboxIdentity,
});

const makeWorkflowCommandRuntime = (
  project: ProjectSnapshot | undefined,
  runId: string,
  activityRuntime: WorkflowActivityRuntime["Service"],
  repository: WorkflowRunRepository["Service"] | undefined,
  providerRuntime: ProviderRuntime["Service"],
  definitions: ReadonlyMap<string, WorkflowSandboxDefinition>,
): WorkflowCommandRuntime["Service"] => ({
  run: ({ command, operationKey, sandbox }) => {
    if (project === undefined || repository === undefined || !validOperationKey(operationKey)) {
      return Effect.fail(
        commandFailure(
          sandbox.identity,
          "Command execution is not configured for durable execution.",
          "sandbox-provider-failure",
        ),
      );
    }
    const definition = definitions.get(sandbox.identity);
    if (definition === undefined) {
      return Effect.fail(
        commandFailure(
          sandbox.identity,
          "Workflow Sandbox was not acquired in this Workflow Run.",
          "sandbox-provider-failure",
        ),
      );
    }
    return activityRuntime.execute({
      definitionIdentity: commandDefinitionIdentity(command, sandbox),
      failureSchema: CommandFailureSchema,
      name: `Run Command ${command.commandKey}@${command.revision}`,
      operationKey,
      successSchema: CommandResultSchema,
      execute: () => {
        const invocation = providerRuntime
          .runCommand({
            command,
            definition,
            project,
            runId,
            sandbox,
          })
          .pipe(
            Effect.mapError((error) =>
              commandFailure(sandbox.identity, error.message, "sandbox-provider-failure"),
            ),
          );
        const timed =
          command.timeout === undefined
            ? invocation
            : invocation.pipe(
                Effect.timeoutOrElse({
                  duration: command.timeout,
                  orElse: () =>
                    Effect.fail(
                      commandFailure(
                        sandbox.identity,
                        "Command execution exceeded its declared timeout.",
                        "command-timed-out",
                      ),
                    ),
                }),
              );
        return timed.pipe(
          Effect.matchEffect({
            onFailure: (failure) =>
              repository
                .recordSandboxTrace(project, runId, {
                  artifactIds: [],
                  artifacts: [],
                  durationMs: null,
                  exitCode: failure.exitCode ?? null,
                  kind:
                    failure._tag === "command-timed-out" ? "command.timed-out" : "command.failed",
                  operationKey,
                  providerKind: sandbox.providerKind,
                  recordedAtMs: Date.now(),
                  sandboxIdentity: sandbox.identity,
                })
                .pipe(Effect.andThen(Effect.fail(failure))),
            onSuccess: (result) =>
              Effect.gen(function* () {
                if (result.sessionRecreated) {
                  yield* repository.recordSandboxTrace(project, runId, {
                    artifactIds: [],
                    artifacts: [],
                    durationMs: null,
                    exitCode: null,
                    kind: "sandbox.session-recreated",
                    operationKey: sandbox.operationKey,
                    providerKind: sandbox.providerKind,
                    recordedAtMs: Date.now(),
                    sandboxIdentity: sandbox.identity,
                  });
                }
                const artifact = yield* writeSandboxArtifact(
                  project,
                  runId,
                  "command-output.json",
                  {
                    commandKey: command.commandKey,
                    exitCode: result.exitCode,
                    stderr: result.stderr,
                    stdout: result.stdout,
                  },
                ).pipe(
                  Effect.mapError((error) =>
                    commandFailure(sandbox.identity, error.message, "sandbox-provider-failure"),
                  ),
                );
                const commandResult: CommandResult = {
                  artifactIds: [artifact.artifactId],
                  durationMs: result.durationMs,
                  exitCode: result.exitCode,
                  sandboxIdentity: sandbox.identity,
                  stderr: result.stderr,
                  stdout: result.stdout,
                };
                const failed = result.exitCode !== 0 && (command.nonZeroExit ?? "fail") === "fail";
                yield* repository.recordSandboxTrace(project, runId, {
                  artifactIds: commandResult.artifactIds,
                  artifacts: [artifact],
                  durationMs: commandResult.durationMs,
                  exitCode: commandResult.exitCode,
                  kind: failed ? "command.failed" : "command.completed",
                  operationKey,
                  providerKind: sandbox.providerKind,
                  recordedAtMs: Date.now(),
                  sandboxIdentity: sandbox.identity,
                });
                if (failed) {
                  return yield* Effect.fail(
                    commandFailure(
                      sandbox.identity,
                      `Command exited with code ${result.exitCode}.`,
                      "command-failed",
                      result.exitCode,
                    ),
                  );
                }
                return commandResult;
              }),
          }),
        );
      },
    });
  },
});

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

const childInvocationRequestKey = (
  parentRunId: string,
  workflowKey: string,
  invocationKey: string,
) =>
  `child:${createHash("sha256")
    .update(JSON.stringify({ parentRunId, workflowKey, invocationKey }))
    .digest("hex")}`;

const childInvocationHash = (
  parentRunId: string,
  workflowKey: string,
  workflowRevision: string,
  invocationKey: string,
  input: unknown,
) =>
  createHash("sha256")
    .update(JSON.stringify({ parentRunId, workflowKey, workflowRevision, invocationKey, input }))
    .digest();

const makeWorkflowChildRuntime = (
  parentRunId: string,
  parent: AnyLocalWorkflowDefinition,
  dispatcher: ChildRunDispatcher | undefined,
): WorkflowChildRuntime["Service"] => ({
  invoke: (invocation) =>
    dispatcher === undefined
      ? Effect.die("Workflow Child Runs are not configured for durable execution")
      : dispatcher.invoke(parentRunId, parent, invocation),
});

const invokeChildWorkflowRun = (
  backend: ActiveBackend,
  project: ProjectSnapshot,
  repository: WorkflowRunRepository["Service"] | undefined,
  parentRunId: string,
  parent: AnyLocalWorkflowDefinition,
  invocation: WorkflowChildInvocation,
): Effect.Effect<unknown, WorkflowChildFailure> =>
  Effect.suspend(() => {
    if (repository === undefined) {
      return Effect.die("Workflow Child Runs require a durable Workflow Run Repository");
    }
    if (
      invocation.invocationKey.trim().length === 0 ||
      invocation.invocationKey.length > 200 ||
      !parent.childWorkflowKeys?.includes(invocation.workflowKey)
    ) {
      return Effect.die(
        "Child Workflow invocation requires a declared target Workflow Key and a Durable Invocation Key.",
      );
    }
    const target = [...backend.entries.values()].find(
      (entry) => entry.workflowKey === invocation.workflowKey,
    );
    if (target === undefined)
      return Effect.die(`Unknown Child Workflow Key: ${invocation.workflowKey}`);
    let encodedInput: unknown;
    try {
      const inputSchema = target.definition.inputSchema as typeof Schema.Unknown;
      encodedInput = Schema.encodeSync(inputSchema)(
        Schema.decodeUnknownSync(inputSchema)(invocation.input),
      );
    } catch {
      return Effect.die(`Child Workflow input is invalid: ${invocation.workflowKey}`);
    }
    const requestKey = childInvocationRequestKey(
      parentRunId,
      target.workflowKey,
      invocation.invocationKey,
    );
    const acceptedAtMs = Date.now();
    const start = Activity.make({
      name: `Kojo/Child/${invocation.invocationKey}/${childInvocationHash(
        parentRunId,
        target.workflowKey,
        target.workflowRevision,
        invocation.invocationKey,
        encodedInput,
      ).toString("hex")}`,
      success: Schema.Struct({
        kind: Schema.Literals(["completed", "failed", "stopped"]),
        runId: Schema.String,
        value: Schema.optionalKey(Schema.Unknown),
      }),
      error: Schema.Never,
      execute: repository
        .acceptChildStart({
          project,
          parentRunId,
          invocationKey: invocation.invocationKey,
          requestKey: requestKey as never,
          requestHash: childInvocationHash(
            parentRunId,
            target.workflowKey,
            target.workflowRevision,
            invocation.invocationKey,
            encodedInput,
          ),
          runId: randomUUID(),
          workflowKey: target.workflowKey,
          workflowRevision: target.workflowRevision,
          encodedInput,
          inputSensitivityPaths: target.definition.sensitivity?.input ?? [],
          startSnapshot: {
            workflow: {
              workflowKey: target.workflowKey,
              workflowRevision: target.workflowRevision,
              sourceIdentity: target.definition.sourceIdentity ?? target.identity,
              inputSchemaFingerprint: target.definition.inputSchemaFingerprint ?? "unavailable",
            },
            trigger: {
              kind: "child" as const,
              parentRunId: parentRunId as never,
              invocationKey: invocation.invocationKey,
            },
            environment: {
              projectIdentity: project.identity,
              definitionSnapshotId: target.definition.definitionSnapshotId ?? "unavailable",
              runtimeKind: "local-effect-workflow" as const,
            },
            input: encodedInput,
            inputSensitivityPaths: target.definition.sensitivity?.input ?? [],
          },
          acceptedAtMs,
        })
        .pipe(
          Effect.flatMap((accepted) => {
            if (accepted._tag === "invocation-key-conflict") {
              return Effect.die(`Conflicting Child Invocation Key: ${invocation.invocationKey}`);
            }
            if (accepted._tag === "request-key-conflict") {
              return Effect.die(
                `Conflicting Child Workflow start request: ${invocation.invocationKey}`,
              );
            }
            const childRunId = accepted.run.run.runId;
            return Effect.gen(function* () {
              for (;;) {
                const stored = yield* repository.show(project, childRunId);
                if (stored === undefined)
                  return yield* Effect.die("Child Workflow Run disappeared");
                if (stored.run.state === "completed") {
                  return {
                    kind: "completed" as const,
                    runId: childRunId,
                    ...(stored.run.outcome !== null && "value" in stored.run.outcome
                      ? { value: stored.run.outcome.value }
                      : {}),
                  };
                }
                if (stored.run.state === "failed" || stored.run.state === "stopped") {
                  return { kind: stored.run.state, runId: childRunId } as const;
                }
                yield* Effect.sleep("25 millis");
              }
            });
          }),
        ),
    });
    return Effect.flatMap(start, (result) => {
      if (result.kind !== "completed") {
        return Effect.fail(
          new WorkflowChildFailure({
            invocationKey: invocation.invocationKey,
            runId: result.runId,
            workflowKey: target.workflowKey,
          }),
        );
      }
      try {
        const successSchema = target.definition.successSchema as typeof Schema.Unknown;
        return Effect.succeed(
          result.value === undefined
            ? undefined
            : Schema.decodeUnknownSync(successSchema)(result.value),
        );
      } catch {
        return Effect.die("Child Workflow outcome is invalid");
      }
    });
  }) as Effect.Effect<unknown, WorkflowChildFailure>;

const makeOperations = (waits: Map<string, RegisteredWait>): LocalWorkflowOperations => ({
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
    Effect.suspend(() => {
      assertOperationKey(operationKey);
      return DurableClock.sleep({
        name: `Kojo/Clock/${operationKey}`,
        duration,
        inMemoryThreshold: Duration.zero,
      }) as never;
    }),
  deferred: <Success extends Schema.Top>({
    operationKey,
    successSchema,
  }: {
    readonly operationKey: string;
    readonly successSchema: Success;
  }) =>
    Effect.suspend(() => {
      assertOperationKey(operationKey);
      const deferred = DurableDeferred.make(`Kojo/Deferred/${operationKey}`, {
        success: successSchema,
      });
      return DurableDeferred.token(deferred).pipe(
        Effect.map((engineToken) => {
          const parsed = DurableDeferred.TokenParsed.fromString(engineToken);
          const completionToken = toWorkflowDeferredToken(engineToken);
          waits.set(parsed.executionId, {
            deferred: deferred as DurableDeferred.DurableDeferred<Schema.Top>,
            engineToken,
            suspension: { kind: "deferred", operationKey, completionToken },
            completionToken,
            valueSchema: successSchema,
          });
          return { token: completionToken } as WorkflowDeferred<Success["Type"]>;
        }),
      );
    }) as unknown as Effect.Effect<WorkflowDeferred<Success["Type"]>>,
  awaitDeferred: <Success>(deferred: WorkflowDeferred<Success>) =>
    Effect.suspend(() => {
      const engineToken = toEngineDeferredToken(deferred.token);
      if (engineToken === undefined) {
        return Effect.die("Workflow Deferred token is invalid.");
      }
      const parsed = DurableDeferred.TokenParsed.fromString(engineToken);
      const wait = waits.get(parsed.executionId);
      if (
        wait === undefined ||
        wait.suspension.kind !== "deferred" ||
        wait.completionToken !== deferred.token
      ) {
        return Effect.die("Workflow Deferred was not created in this Workflow Run.");
      }
      return DurableDeferred.await(wait.deferred) as Effect.Effect<Success>;
    }),
  waitForResume: <Success extends Schema.Top>({
    operationKey,
    valueSchema,
  }: {
    readonly operationKey: string;
    readonly valueSchema: Success;
  }) =>
    Effect.suspend(() => {
      assertOperationKey(operationKey);
      const deferred = DurableDeferred.make(`Kojo/Resume/${operationKey}`, {
        success: valueSchema,
      });
      return DurableDeferred.token(deferred).pipe(
        Effect.flatMap((engineToken) => {
          const parsed = DurableDeferred.TokenParsed.fromString(engineToken);
          waits.set(parsed.executionId, {
            deferred: deferred as DurableDeferred.DurableDeferred<Schema.Top>,
            engineToken,
            suspension: { kind: "manual", operationKey },
            valueSchema,
          });
          return DurableDeferred.await(deferred) as Effect.Effect<Success["Type"]>;
        }),
      );
    }) as unknown as Effect.Effect<Success["Type"]>,
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
  wait: RegisteredWait | undefined,
): WorkflowBackendState => {
  if (Option.isNone(result)) return { _tag: "Pending" };
  if (result.value._tag === "Suspended") {
    return {
      _tag: "Waiting",
      suspension: wait?.suspension ?? { kind: "clock", operationKey: "durable-clock" },
    };
  }
  if (Exit.isSuccess(result.value.exit)) {
    return { _tag: "Completed", result: result.value.exit.value };
  }
  return { _tag: "Failed" };
};
