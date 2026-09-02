import type { OperationReceipt } from "@carere/kojo-client-contracts/contexts/client/contracts/operation";
import type {
  ProjectDocument,
  ProjectLocationAction,
  ProjectLocationResult,
} from "@carere/kojo-client-contracts/contexts/client/contracts/project";
import type { WorkflowDocument } from "@carere/kojo-client-contracts/contexts/client/contracts/workflow";
import type { Effect } from "effect";
import type {
  TriggerPoller,
  WorkflowActivityReceipt,
} from "../../workflow/models/WorkflowActivity.ts";
import type { RegisteredProject, RegisterProjectRequest } from "../models/Project.ts";
import type { ProjectStoreError } from "../models/ProjectStoreError.ts";

export interface ExecutionRevision {
  readonly projectId: string;
  readonly location: string;
  readonly workflowName: string;
  readonly revisionId: string;
  readonly packageGraphId: string;
  readonly publishedPath: string;
  readonly entrySource: string;
}

/** Complete Daemon-facing Project data port. */
export interface DaemonProjectRepository {
  readonly register: (
    request: RegisterProjectRequest,
  ) => Effect.Effect<RegisteredProject, ProjectStoreError>;
  readonly projects: Effect.Effect<ReadonlyArray<ProjectDocument>, ProjectStoreError>;
  readonly receipt: (
    dataIdentity: string,
    requestId: string,
  ) => Effect.Effect<OperationReceipt | undefined, ProjectStoreError>;
  readonly snapshotVersion: Effect.Effect<number, ProjectStoreError>;
  readonly markMissingLocations: (
    locations: ReadonlyArray<string>,
    observedAt: string,
  ) => Effect.Effect<number, ProjectStoreError>;
  readonly beginLocationChange: (request: {
    readonly requestId: string;
    readonly requestBody: string;
    readonly dataIdentity: string;
    readonly projectId: string;
    readonly action: ProjectLocationAction;
    readonly requestedLocation?: string;
    readonly changedAt: string;
  }) => Effect.Effect<OperationReceipt, ProjectStoreError>;
  readonly commitLocationChange: (request: {
    readonly requestId: string;
    readonly dataIdentity: string;
    readonly projectId: string;
    readonly action: ProjectLocationAction;
    readonly changedAt: string;
  }) => Effect.Effect<ProjectLocationResult, ProjectStoreError>;
  readonly workflows: Effect.Effect<ReadonlyArray<WorkflowDocument>, ProjectStoreError>;
  readonly workflow: (
    projectId: string,
    workflowName: string,
  ) => Effect.Effect<WorkflowDocument | undefined, ProjectStoreError>;
  readonly startActivity: (request: {
    readonly dataIdentity: string;
    readonly requestId: string;
    readonly projectId: string;
    readonly workflowName: string;
    readonly changedAt: string;
  }) => Effect.Effect<WorkflowActivityReceipt, ProjectStoreError>;
  readonly stopActivity: (request: {
    readonly dataIdentity: string;
    readonly requestId: string;
    readonly projectId: string;
    readonly workflowName: string;
    readonly changedAt: string;
  }) => Effect.Effect<WorkflowActivityReceipt, ProjectStoreError>;
  readonly triggerPollers: Effect.Effect<ReadonlyArray<TriggerPoller>, ProjectStoreError>;
  readonly observeTrigger: (request: {
    readonly projectId: string;
    readonly workflowName: string;
    readonly state: "polling" | "delayed" | "failed";
    readonly detail: string;
    readonly observedAt: string;
  }) => Effect.Effect<void, ProjectStoreError>;
  readonly executionRevision: (
    projectId: string,
    workflowName: string,
  ) => Effect.Effect<ExecutionRevision, ProjectStoreError>;
  readonly retainedExecutionRevision: (
    projectId: string,
    workflowName: string,
    revisionId: string,
    packageGraphId: string,
  ) => Effect.Effect<ExecutionRevision, ProjectStoreError>;
  readonly settleManualActivity: (
    projectId: string,
    workflowName: string,
  ) => Effect.Effect<void, ProjectStoreError>;
}
