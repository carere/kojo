import type {
  ProjectSnapshot,
  RequestKey,
  WorkflowRunListInput,
  WorkflowRunListItem,
  WorkflowRunSnapshot,
  WorkflowRunStartSnapshot,
} from "@kojo/control";
import { Context, type Effect } from "effect";
import type { StoredSensitivityMap } from "../models/sensitivity-map";

export interface StoredWorkflowRunSnapshot {
  readonly outcomeSensitivityMap: StoredSensitivityMap;
  readonly run: WorkflowRunSnapshot;
  readonly startSnapshotSensitivityMap: StoredSensitivityMap;
}

export interface WorkflowRunStartRecord {
  readonly project: ProjectSnapshot;
  readonly requestKey: RequestKey;
  readonly requestHash: Uint8Array;
  readonly runId: string;
  readonly workflowKey: string;
  readonly workflowRevision: string;
  readonly encodedInput: unknown;
  readonly inputSensitivityPaths: ReadonlyArray<string>;
  readonly startSnapshot: WorkflowRunStartSnapshot;
  readonly acceptedAtMs: number;
}

export interface PendingWorkflowRunSubmission {
  readonly engineGeneration: number;
  readonly project: ProjectSnapshot;
  readonly runId: string;
  readonly workflowKey: string;
  readonly workflowRevision: string;
  readonly input: unknown;
}

export interface ActiveWorkflowRun {
  readonly project: ProjectSnapshot;
  readonly runId: string;
  readonly workflowKey: string;
  readonly workflowRevision: string;
}

export interface WorkflowRunOutcome {
  readonly kind: "completed" | "failed";
  readonly sensitivityPaths: ReadonlyArray<string>;
  readonly value?: unknown;
}

export interface WorkflowActivityOperation {
  readonly activityName: string;
  readonly definitionFingerprint: string;
  readonly durableOperationKey: string;
}

export interface WorkflowActivityAttemptRecord extends WorkflowActivityOperation {
  readonly activityIdempotencyKey: string;
  readonly attemptId: string;
  readonly executionGeneration: number;
  readonly effectRetryNumber: number;
  readonly invocationNumber: number;
}

export type WorkflowActivityPreparation =
  | { readonly _tag: "ready"; readonly executionGeneration: number }
  | { readonly _tag: "awaiting-confirmation" }
  | {
      readonly _tag: "completed";
      readonly confirmedAttemptId: string;
      readonly executionGeneration: number;
      readonly result: unknown;
    }
  | { readonly _tag: "conflict" };

export type WorkflowRunStartAcceptance =
  | {
      readonly _tag: "accepted";
      readonly run: StoredWorkflowRunSnapshot;
      readonly alreadyApplied: boolean;
    }
  | { readonly _tag: "request-key-conflict" };

export interface WorkflowRunRepositoryShape {
  readonly acceptManualStart: (
    start: WorkflowRunStartRecord,
  ) => Effect.Effect<WorkflowRunStartAcceptance>;
  readonly list: (
    project: ProjectSnapshot,
    input: WorkflowRunListInput,
  ) => Effect.Effect<ReadonlyArray<WorkflowRunListItem>>;
  readonly show: (
    project: ProjectSnapshot,
    runId: string,
  ) => Effect.Effect<StoredWorkflowRunSnapshot | undefined>;
  readonly pendingSubmissions: (
    project: ProjectSnapshot,
    runId?: string,
  ) => Effect.Effect<ReadonlyArray<PendingWorkflowRunSubmission>>;
  readonly recoverActivitySubmission?: (
    project: ProjectSnapshot,
    runId: string,
    hostStartedAtMs: number,
  ) => Effect.Effect<boolean>;
  readonly engineGeneration?: (
    project: ProjectSnapshot,
    runId: string,
  ) => Effect.Effect<number | undefined>;
  readonly activeRuns: (
    project: ProjectSnapshot,
  ) => Effect.Effect<ReadonlyArray<ActiveWorkflowRun>>;
  readonly confirmSubmission: (
    project: ProjectSnapshot,
    runId: string,
    confirmedAtMs: number,
  ) => Effect.Effect<void>;
  readonly recordOutcome: (
    project: ProjectSnapshot,
    runId: string,
    outcome: WorkflowRunOutcome,
    finalizedAtMs: number,
  ) => Effect.Effect<void>;
  readonly prepareActivity: (
    project: ProjectSnapshot,
    runId: string,
    operation: WorkflowActivityOperation,
    preparedAtMs: number,
  ) => Effect.Effect<WorkflowActivityPreparation>;
  readonly startActivityAttempt: (
    project: ProjectSnapshot,
    runId: string,
    operation: WorkflowActivityOperation,
    options: {
      readonly activityIdempotencyKey: string;
      readonly effectRetryNumber: number;
      readonly executionGeneration: number;
    },
    startedAtMs: number,
  ) => Effect.Effect<WorkflowActivityAttemptRecord>;
  readonly observeActivityAttempt: (
    project: ProjectSnapshot,
    runId: string,
    attemptId: string,
    outcomeCode: "success" | "failure",
    observedAtMs: number,
  ) => Effect.Effect<void>;
  readonly confirmActivityAttempt: (
    project: ProjectSnapshot,
    runId: string,
    attemptId: string,
    result: unknown,
    confirmedAtMs: number,
  ) => Effect.Effect<void>;
  readonly recordActivityReplayReuse: (
    project: ProjectSnapshot,
    runId: string,
    operation: WorkflowActivityOperation,
    confirmedAttemptId: string,
    recordedAtMs: number,
  ) => Effect.Effect<void>;
}

export class WorkflowRunRepository extends Context.Service<
  WorkflowRunRepository,
  WorkflowRunRepositoryShape
>()("kojo/host/WorkflowRunRepository") {}
