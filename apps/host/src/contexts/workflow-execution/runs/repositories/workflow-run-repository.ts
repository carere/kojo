import type {
  ProjectSnapshot,
  RequestKey,
  WorkflowRunListInput,
  WorkflowRunListItem,
  WorkflowRunSnapshot,
  WorkflowRunStartSnapshot,
} from "@kojo/control";
import { Context, type Effect } from "effect";

export interface WorkflowRunStartRecord {
  readonly project: ProjectSnapshot;
  readonly requestKey: RequestKey;
  readonly requestHash: Uint8Array;
  readonly runId: string;
  readonly workflowKey: string;
  readonly workflowRevision: string;
  readonly encodedInput: unknown;
  readonly startSnapshot: WorkflowRunStartSnapshot;
  readonly acceptedAtMs: number;
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
}

export interface WorkflowRunOutcome {
  readonly kind: "completed" | "failed";
  readonly value?: unknown;
}

export type WorkflowRunStartAcceptance =
  | {
      readonly _tag: "accepted";
      readonly run: WorkflowRunSnapshot;
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
  ) => Effect.Effect<WorkflowRunSnapshot | undefined>;
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
}

export class WorkflowRunRepository extends Context.Service<
  WorkflowRunRepository,
  WorkflowRunRepositoryShape
>()("kojo/host/WorkflowRunRepository") {}
