import { BunCrypto } from "@effect/platform-bun";
import * as SqliteClient from "@effect/sql-sqlite-bun/SqliteClient";
import { Context, Duration, Effect, Exit, Layer, Option, Schema } from "effect";
import * as ClusterWorkflowEngine from "effect/unstable/cluster/ClusterWorkflowEngine";
import * as SingleRunner from "effect/unstable/cluster/SingleRunner";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Activity from "effect/unstable/workflow/Activity";
import * as DurableClock from "effect/unstable/workflow/DurableClock";
import * as Workflow from "effect/unstable/workflow/Workflow";
import * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine";
import {
  type AnyLocalWorkflowDefinition,
  LocalWorkflowBackend,
  type LocalWorkflowOperations,
  type WorkflowBackendReference,
  type WorkflowBackendState,
} from "./local-workflow-backend";

export interface LocalWorkflowBackendLayerOptions {
  readonly databasePath: string;
  readonly definitions: ReadonlyArray<AnyLocalWorkflowDefinition>;
}

export const makeLocalWorkflowBackendLayer = ({
  databasePath,
  definitions,
}: LocalWorkflowBackendLayerOptions): Layer.Layer<LocalWorkflowBackend> => {
  const entries = makeEntries(definitions);
  const sqlLayer = SqliteClient.layer({ filename: databasePath }).pipe(
    Layer.tap((context) => {
      const sql = Context.get(context, SqlClient.SqlClient);
      return Effect.all([
        sql.unsafe("PRAGMA foreign_keys = ON"),
        sql.unsafe("PRAGMA busy_timeout = 5000"),
        sql.unsafe("PRAGMA synchronous = FULL"),
      ]);
    }),
    Layer.orDie,
  );
  const persistenceLayer = Layer.merge(sqlLayer, BunCrypto.layer);
  const runnerLayer = SingleRunner.layer({
    shardingConfig: {
      entityMessagePollInterval: Duration.millis(25),
      entityReplyPollInterval: Duration.millis(25),
      refreshAssignmentsInterval: Duration.millis(25),
    },
  }).pipe(Layer.provide(persistenceLayer), Layer.orDie);
  const engineLayer = ClusterWorkflowEngine.layer.pipe(Layer.provide(runnerLayer));
  const registrationLayer = entries.reduce<
    Layer.Layer<never, never, WorkflowEngine.WorkflowEngine>
  >((layer, entry) => Layer.merge(layer, entry.registration), Layer.empty);
  const backendLayer = Layer.effect(
    LocalWorkflowBackend,
    Effect.map(WorkflowEngine.WorkflowEngine, (engine) =>
      LocalWorkflowBackend.of({
        submit: ({ workflowKey, runId, input }) =>
          Effect.suspend(() => {
            const entry = getEntry(entries, workflowKey);
            return entry
              .submit(engine, runId, input)
              .pipe(Effect.as(makeReference(workflowKey, runId)));
          }),
        observe: (reference) =>
          Effect.suspend(() => {
            const entry = getEntry(entries, reference.workflowKey);
            return entry.observe(engine, reference.runId);
          }),
      }),
    ),
  );

  return Layer.merge(registrationLayer, backendLayer).pipe(
    Layer.provide(engineLayer),
  ) as Layer.Layer<LocalWorkflowBackend>;
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

const getEntry = (entries: ReadonlyArray<Entry>, workflowKey: string): Entry => {
  const entry = entries.find((candidate) => candidate.workflowKey === workflowKey);
  if (!entry) {
    throw new Error(`Unknown Workflow Key: ${workflowKey}`);
  }
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
