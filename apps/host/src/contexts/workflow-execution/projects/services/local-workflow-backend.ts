import { Database } from "bun:sqlite";
import { Buffer } from "node:buffer";
import { chmodSync, existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { BunCrypto } from "@effect/platform-bun";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import type { ProjectSnapshot } from "@kojo/control";
import type { WorkflowDeferred } from "@kojo/workflow";
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
import * as DurableDeferred from "effect/unstable/workflow/DurableDeferred";
import * as Workflow from "effect/unstable/workflow/Workflow";
import * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine";
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
  readonly engine: WorkflowEngine.WorkflowEngine["Service"];
  readonly entries: Map<string, Entry>;
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
            active.set(project.path, {
              engine,
              entries: new Map(defaultEntries.map((entry) => [entry.identity, entry])),
              scope,
              sharding,
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
      ) =>
        Effect.gen(function* () {
          const backend = getActiveBackend(active, project);
          for (const entry of makeEntries(definitions)) {
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
        submit: (project, { workflowKey, workflowRevision, runId, input }) =>
          Effect.suspend(() => {
            const backend = getActiveBackend(active, project);
            const entry = getEntry(backend.entries, workflowKey, workflowRevision);
            return entry
              .submit(backend.engine, runId, input)
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
            return entry.observe(backend.engine, reference.runId);
          }),
        resume: (project, reference, value) =>
          Effect.suspend(() => {
            const backend = getActiveBackend(active, project);
            const entry = getEntry(
              backend.entries,
              reference.workflowKey,
              reference.workflowRevision,
            );
            return entry.resume(backend.engine, reference.runId, value);
          }),
        completeDeferred: (project, reference, token, value) =>
          Effect.suspend(() => {
            const backend = getActiveBackend(active, project);
            const entry = getEntry(
              backend.entries,
              reference.workflowKey,
              reference.workflowRevision,
            );
            return entry.completeDeferred(backend.engine, reference.runId, token, value);
          }),
        rehydrate: (project, reference) =>
          Effect.suspend(() => {
            const backend = getActiveBackend(active, project);
            const entry = getEntry(
              backend.entries,
              reference.workflowKey,
              reference.workflowRevision,
            );
            return entry.rehydrate(backend.engine, reference.runId);
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
  ) => Effect.Effect<void>;
  readonly observe: (
    engine: WorkflowEngine.WorkflowEngine["Service"],
    runId: string,
  ) => Effect.Effect<WorkflowBackendState>;
  readonly resume: (
    engine: WorkflowEngine.WorkflowEngine["Service"],
    runId: string,
    value: unknown,
  ) => Effect.Effect<WorkflowBackendResumeResult>;
  readonly completeDeferred: (
    engine: WorkflowEngine.WorkflowEngine["Service"],
    runId: string,
    token: string,
    value: unknown,
  ) => Effect.Effect<WorkflowBackendDeferredCompletionResult>;
  readonly rehydrate: (
    engine: WorkflowEngine.WorkflowEngine["Service"],
    runId: string,
  ) => Effect.Effect<void>;
  readonly registration: Layer.Layer<never, never, WorkflowEngine.WorkflowEngine>;
}

const makeEntries = (
  definitions: ReadonlyArray<AnyLocalWorkflowDefinition>,
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
        runId: Schema.String,
        input: Schema.Unknown,
      },
      success: definition.successSchema,
      error: definition.failureSchema ?? Schema.Never,
      idempotencyKey: ({ runId }) => runId,
    });
    const waits = new Map<string, RegisteredWait>();
    const operations = makeOperations(waits);
    const registration = workflow.toLayer(({ input }) =>
      Schema.decodeUnknownEffect(definition.inputSchema)(input).pipe(
        Effect.orDie,
        Effect.flatMap((decoded) => definition.execute(decoded as never, operations)),
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
          Effect.flatMap((executionId) =>
            engine
              .poll(workflow, executionId)
              .pipe(Effect.map((state) => toBackendState(state, waits.get(executionId)))),
          ),
          Effect.catchCause(() => Effect.succeed({ _tag: "Failed" } as const)),
        ) as unknown as Effect.Effect<WorkflowBackendState>,
      resume: (engine, runId, value) =>
        workflow.executionId({ runId, input: undefined }).pipe(
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
      completeDeferred: (engine, runId, token, value) =>
        workflow.executionId({ runId, input: undefined }).pipe(
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
      rehydrate: (engine, runId) =>
        workflow.executionId({ runId, input: undefined }).pipe(
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
