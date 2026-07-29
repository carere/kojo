import { Context, type Duration, type Effect, type Schema } from "effect";

declare const WorkflowBackendReferenceTypeId: unique symbol;

export interface WorkflowBackendReference {
  readonly [WorkflowBackendReferenceTypeId]: typeof WorkflowBackendReferenceTypeId;
  readonly workflowKey: string;
  readonly runId: string;
}

export type WorkflowBackendState =
  | { readonly _tag: "Pending" }
  | { readonly _tag: "Waiting" }
  | { readonly _tag: "Completed"; readonly result: unknown }
  | { readonly _tag: "Failed" };

export interface LocalWorkflowOperations {
  readonly activity: <
    Success extends Schema.Top,
    Failure extends Schema.Top = typeof Schema.Never,
  >(options: {
    readonly operationKey: string;
    readonly successSchema: Success;
    readonly failureSchema?: Failure;
    readonly execute: Effect.Effect<Success["Type"], Failure["Type"]>;
  }) => Effect.Effect<Success["Type"], Failure["Type"]>;
  readonly sleep: (options: {
    readonly operationKey: string;
    readonly duration: Duration.Input;
  }) => Effect.Effect<void>;
}

export interface LocalWorkflowDefinition<
  Input extends Schema.Top = Schema.Top,
  Success extends Schema.Top = Schema.Top,
  Failure extends Schema.Top = typeof Schema.Never,
> {
  readonly workflowKey: string;
  readonly inputSchema: Input;
  readonly successSchema: Success;
  readonly failureSchema?: Failure;
  readonly execute: (
    input: Input["Type"],
    operations: LocalWorkflowOperations,
  ) => Effect.Effect<Success["Type"], Failure["Type"]>;
}

export interface AnyLocalWorkflowDefinition {
  readonly workflowKey: string;
  readonly inputSchema: Schema.Top;
  readonly successSchema: Schema.Top;
  readonly failureSchema?: Schema.Top;
  readonly execute: (
    input: never,
    operations: LocalWorkflowOperations,
  ) => Effect.Effect<unknown, unknown>;
}

export class LocalWorkflowBackend extends Context.Service<
  LocalWorkflowBackend,
  {
    readonly submit: (options: {
      readonly workflowKey: string;
      readonly runId: string;
      readonly input: unknown;
    }) => Effect.Effect<WorkflowBackendReference>;
    readonly observe: (reference: WorkflowBackendReference) => Effect.Effect<WorkflowBackendState>;
  }
>()("@kojo/host/LocalWorkflowBackend") {}
