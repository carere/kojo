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

export interface PendingWorkflowRunSubmission {
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
}

export interface WorkflowRunOutcome {
  readonly kind: "completed" | "failed";
  readonly sensitivityPaths: ReadonlyArray<string>;
  readonly value?: unknown;
}

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

export interface WorkflowRunRepositoryShape {
  readonly acceptManualStart: (
    start: WorkflowRunStartRecord,
  ) => Effect.Effect<WorkflowRunStartAcceptance>;
  readonly acceptScheduledStart: (
    start: WorkflowRunScheduleStartRecord,
  ) => Effect.Effect<WorkflowRunScheduleStartAcceptance>;
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
}

export class WorkflowRunRepository extends Context.Service<
  WorkflowRunRepository,
  WorkflowRunRepositoryShape
>()("kojo/host/WorkflowRunRepository") {}
