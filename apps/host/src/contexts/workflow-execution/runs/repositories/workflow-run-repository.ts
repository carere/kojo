import type {
  ExecutionTraceFilters,
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

/** The adapter returns the durable payload and its map; the use case masks it. */
export interface StoredExecutionTraceEvent {
  readonly activityAttemptId: string | null;
  readonly boundaryId: string | null;
  readonly childRunId: string | null;
  readonly engineOperationId: string | null;
  readonly envelopeVersion: number;
  readonly eventId: string;
  readonly kind: string;
  readonly kindVersion: number;
  readonly observedAtMs: number | null;
  readonly payload: unknown;
  readonly payloadSensitivityMap: StoredSensitivityMap;
  readonly recordedAtMs: number;
  readonly runId: string;
  readonly sequence: number;
}

export interface StoredExecutionTracePage {
  readonly events: ReadonlyArray<StoredExecutionTraceEvent>;
  readonly hasMore: boolean;
  readonly highWaterSequence: number;
  readonly runState: "running" | "suspended" | "stopping" | "stopped" | "failed" | "completed";
}

/** The durable Artifact record, including the storage identity the Host verifies. */
export interface StoredExecutionArtifact {
  readonly artifactId: string;
  readonly byteSize: number;
  readonly condition: "available" | "missing" | "expired";
  readonly createdAtMs: number;
  readonly displayName: string;
  readonly mediaType: string;
  readonly sha256: Uint8Array;
  readonly storageKey: string;
  readonly unavailableAtMs: number | null;
  readonly unavailableReasonCode: string | null;
}

/** A single database snapshot used to create a portable Trace export. */
export interface StoredExecutionTraceExport {
  readonly artifacts: ReadonlyArray<StoredExecutionArtifact>;
  readonly events: ReadonlyArray<StoredExecutionTraceEvent>;
  readonly highWaterSequence: number;
  readonly runState: "running" | "suspended" | "stopping" | "stopped" | "failed" | "completed";
}

export interface ExecutionTraceRead {
  readonly afterSequence?: number;
  readonly beforeSequence?: number;
  readonly filters: ExecutionTraceFilters;
  readonly limit: number;
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
  readonly parentRunId: string | null;
  readonly project: ProjectSnapshot;
  readonly runId: string;
  readonly workflowKey: string;
  readonly workflowRevision: string;
  readonly state: "running" | "suspended" | "stopping";
  readonly suspensionKind: WorkflowRunSuspension["kind"] | null;
}

export interface StoppingWorkflowRun extends ActiveWorkflowRun {}

export type WorkflowRunStopAcceptance =
  | {
      readonly _tag: "accepted";
      readonly run: StoredWorkflowRunSnapshot;
      readonly runs: ReadonlyArray<StoppingWorkflowRun>;
      readonly alreadyApplied: boolean;
    }
  | { readonly _tag: "request-key-conflict" }
  | { readonly _tag: "not-found" }
  | { readonly _tag: "not-stoppable"; readonly run: StoredWorkflowRunSnapshot };

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

export interface WorkflowAgentTraceRecord {
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
  readonly kind:
    | "agent.started"
    | "agent.completed"
    | "agent.failed"
    | "agent.session-continued"
    | "agent.replayed";
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
  /** The durable Run can no longer accept this Activity. Do not wait for a claim. */
  | {
      readonly _tag: "run-not-running";
      readonly state: "suspended" | "stopping" | "stopped" | "failed" | "completed" | "missing";
    }
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
  /** A complete project-level revision used by advisory resource subscriptions. */
  readonly revision: (project: ProjectSnapshot) => Effect.Effect<string>;
  readonly show: (
    project: ProjectSnapshot,
    runId: string,
  ) => Effect.Effect<StoredWorkflowRunSnapshot | undefined>;
  /**
   * Reads the append-only trace in one Run's sequence order. It deliberately
   * does not project current state from Events.
   */
  readonly readTrace: (
    project: ProjectSnapshot,
    runId: string,
    input: ExecutionTraceRead,
  ) => Effect.Effect<StoredExecutionTracePage | undefined>;
  /**
   * Reads all durable Event evidence and its referenced Artifact metadata at
   * one per-Run high-water mark. Later writes never enter this snapshot.
   */
  readonly exportTrace: (
    project: ProjectSnapshot,
    runId: string,
  ) => Effect.Effect<StoredExecutionTraceExport | undefined>;
  /** Resolves exactly one Artifact identity under one Run. */
  readonly findArtifact: (
    project: ProjectSnapshot,
    runId: string,
    artifactId: string,
  ) => Effect.Effect<StoredExecutionArtifact | undefined>;
  /** Records newly observed unavailable content as later, immutable evidence. */
  readonly recordArtifactUnavailable: (
    project: ProjectSnapshot,
    runId: string,
    artifactId: string,
    reasonCode: string,
    recordedAtMs: number,
  ) => Effect.Effect<void>;
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
  /**
   * Atomically records the first stop intent for a non-final Run and every
   * non-final descendant before any backend interruption begins.
   */
  readonly acceptStop: (
    project: ProjectSnapshot,
    options: {
      readonly requestHash: Uint8Array;
      readonly requestKey: RequestKey;
      readonly runId: string;
      readonly requestedAtMs: number;
    },
  ) => Effect.Effect<WorkflowRunStopAcceptance>;
  /** Finalizes one stopping Run only after all of its children are final. */
  readonly recordStopped: (
    project: ProjectSnapshot,
    runId: string,
    stoppedAtMs: number,
  ) => Effect.Effect<void>;
  /** Records an interrupt or cleanup failure while keeping the Run stopping. */
  readonly recordStopAttention: (
    project: ProjectSnapshot,
    runId: string,
    message: string,
    recordedAtMs: number,
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
  ) => Effect.Effect<WorkflowActivityAttemptRecord | undefined>;
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
  readonly recordAgentTrace: (
    project: ProjectSnapshot,
    runId: string,
    trace: WorkflowAgentTraceRecord,
  ) => Effect.Effect<void>;
}

export class WorkflowRunRepository extends Context.Service<
  WorkflowRunRepository,
  WorkflowRunRepositoryShape
>()("kojo/host/WorkflowRunRepository") {}
