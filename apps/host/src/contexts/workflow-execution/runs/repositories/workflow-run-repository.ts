import type {
  ProjectSnapshot,
  RequestKey,
  WorkflowRunListInput,
  WorkflowRunListItem,
  WorkflowRunSnapshot,
  WorkflowRunStartSnapshot,
  WorkflowRunSuspension,
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

/** A due Workflow Schedule Occurrence uses its composite identity as its stable Start Request. */
export interface WorkflowRunScheduleStartRecord extends WorkflowRunStartRecord {
  readonly scheduleKey: string;
  readonly scheduledAtMs: number;
  readonly scheduleRevision: string;
}

/** A child invocation is identified by its parent, target Workflow Key, and stable invocation key. */
export interface WorkflowRunChildStartRecord extends WorkflowRunStartRecord {
  readonly parentRunId: string;
  readonly invocationKey: string;
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
  readonly state: "running" | "suspended" | "stopping";
  readonly suspensionKind: WorkflowRunSuspension["kind"] | null;
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

export interface WorkflowSandboxTraceRecord {
  readonly artifactIds: ReadonlyArray<string>;
  readonly artifacts: ReadonlyArray<{
    readonly artifactId: string;
    readonly byteSize: number;
    readonly displayName: string;
    readonly mediaType: string;
    readonly sha256: Uint8Array;
    readonly storageKey: string;
  }>;
  readonly durationMs: number | null;
  readonly exitCode: number | null;
  readonly kind:
    | "sandbox.acquired"
    | "sandbox.session-recreated"
    | "command.completed"
    | "command.failed"
    | "command.timed-out";
  readonly operationKey: string;
  readonly providerKind: string;
  readonly recordedAtMs: number;
  readonly sandboxIdentity: string;
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

export type WorkflowRunScheduleStartAcceptance =
  | WorkflowRunStartAcceptance
  | { readonly _tag: "occurrence-not-planned" };

export type WorkflowRunChildStartAcceptance =
  | WorkflowRunStartAcceptance
  | { readonly _tag: "invocation-key-conflict" };

export interface WorkflowRunRepositoryShape {
  readonly acceptManualStart: (
    start: WorkflowRunStartRecord,
  ) => Effect.Effect<WorkflowRunStartAcceptance>;
  readonly acceptScheduledStart: (
    start: WorkflowRunScheduleStartRecord,
  ) => Effect.Effect<WorkflowRunScheduleStartAcceptance>;
  readonly acceptChildStart: (
    start: WorkflowRunChildStartRecord,
  ) => Effect.Effect<WorkflowRunChildStartAcceptance>;
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
  readonly recordSuspension: (
    project: ProjectSnapshot,
    runId: string,
    suspension: WorkflowRunSuspension,
    suspendedAtMs: number,
  ) => Effect.Effect<void>;
  readonly reserveControl: (
    project: ProjectSnapshot,
    options: {
      readonly kind: "run.resume" | "run.deferred-complete";
      readonly requestHash: Uint8Array;
      readonly requestKey: RequestKey;
      readonly runId: string;
      readonly requestedAtMs: number;
    },
  ) => Effect.Effect<
    | { readonly _tag: "accepted" }
    | { readonly _tag: "already-applied"; readonly run: StoredWorkflowRunSnapshot }
    | { readonly _tag: "request-key-conflict" }
  >;
  readonly completeControl: (
    project: ProjectSnapshot,
    options: {
      readonly kind: "run.resume" | "run.deferred-complete";
      readonly requestKey: RequestKey;
      readonly runId: string;
      readonly resumedAtMs: number;
      readonly expectedSuspension: WorkflowRunSuspension["kind"];
    },
  ) => Effect.Effect<StoredWorkflowRunSnapshot | undefined>;
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
  readonly recordSandboxTrace: (
    project: ProjectSnapshot,
    runId: string,
    trace: WorkflowSandboxTraceRecord,
  ) => Effect.Effect<void>;
}

export class WorkflowRunRepository extends Context.Service<
  WorkflowRunRepository,
  WorkflowRunRepositoryShape
>()("kojo/host/WorkflowRunRepository") {}
