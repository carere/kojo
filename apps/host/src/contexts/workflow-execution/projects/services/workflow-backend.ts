import type { ProjectSnapshot } from "@kojo/control";
import { Context, type Duration, type Effect, type Schema } from "effect";

declare const WorkflowBackendReferenceTypeId: unique symbol;

export interface WorkflowBackendReference {
  readonly [WorkflowBackendReferenceTypeId]: typeof WorkflowBackendReferenceTypeId;
  readonly workflowKey: string;
  readonly workflowRevision: string;
  readonly runId: string;
}

export const workflowBackendReference = (
  workflowKey: string,
  workflowRevision: string,
  runId: string,
): WorkflowBackendReference =>
  ({ workflowKey, workflowRevision, runId }) as WorkflowBackendReference;

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
  /** A missing revision is retained for legacy backend fixtures only. */
  readonly revision?: string;
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
  readonly revision?: string;
  readonly inputSchema: Schema.Top;
  readonly successSchema: Schema.Top;
  readonly failureSchema?: Schema.Top;
  readonly execute: (
    input: never,
    operations: LocalWorkflowOperations,
  ) => Effect.Effect<unknown, unknown>;
}

export type WorkflowBackendAssessment = "ready" | "uninitialized" | "needs-attention";

export interface WorkflowBackendShape {
  readonly acquire: (project: ProjectSnapshot) => Effect.Effect<boolean>;
  readonly quiesce: (project: ProjectSnapshot) => Effect.Effect<void>;
  readonly initialize: (project: ProjectSnapshot) => Effect.Effect<boolean>;
  readonly postflight: (project: ProjectSnapshot) => Effect.Effect<boolean>;
  readonly readiness: (project: ProjectSnapshot) => Effect.Effect<WorkflowBackendAssessment>;
  readonly release: (project: ProjectSnapshot) => Effect.Effect<void>;
  readonly register: (
    project: ProjectSnapshot,
    definitions: ReadonlyArray<AnyLocalWorkflowDefinition>,
  ) => Effect.Effect<void>;
  readonly submit: (
    project: ProjectSnapshot,
    options: {
      readonly workflowKey: string;
      readonly workflowRevision: string;
      readonly runId: string;
      readonly input: unknown;
    },
  ) => Effect.Effect<WorkflowBackendReference>;
  readonly observe: (
    project: ProjectSnapshot,
    reference: WorkflowBackendReference,
  ) => Effect.Effect<WorkflowBackendState>;
}

export class WorkflowBackend extends Context.Service<WorkflowBackend, WorkflowBackendShape>()(
  "kojo/host/WorkflowBackend",
) {}
