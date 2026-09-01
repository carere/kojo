import type { JsonValue } from "@carere/kojo-client-contracts/contexts/shared/codecs/json";

export type DaemonRunState =
  | "queued"
  | "executing"
  | "suspended"
  | "held"
  | "succeeded"
  | "failed"
  | "cancelled";
export type RunQueueKind = "new" | "continuation";
export type RunQueueReason =
  | "execution-capacity"
  | "project-capacity"
  | "runner-starting"
  | "package-switch"
  | "pinned-content";

export interface RunExecutionFault {
  readonly code:
    | "RETAINED_CONTENT_MISSING"
    | "RETAINED_CONTENT_CORRUPT"
    | "RETAINED_HOST_INCOMPATIBLE"
    | "RETAINED_PROTOCOL_INCOMPATIBLE";
  readonly detail: string;
  readonly remedy: string;
}

export interface DaemonRun {
  readonly runId: string;
  readonly projectId: string;
  readonly workflowName: string;
  readonly idempotencyKey: string;
  readonly payload: JsonValue;
  readonly revisionId: string;
  readonly packageGraphId: string;
  readonly state: DaemonRunState;
  readonly queueKind?: RunQueueKind;
  readonly queueReason?: RunQueueReason;
  readonly executionFault?: RunExecutionFault;
  readonly admissionSequence: number;
  readonly admittedAt: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
}

export interface ClaimedRun {
  readonly run: DaemonRun;
  readonly authority: RunAuthority;
}

export interface ReservedRun {
  readonly run: DaemonRun;
  readonly reservationId: string;
}

export interface RunAuthority {
  readonly runId: string;
  readonly runnerInstanceId: string;
  readonly generation: number;
  readonly revisionId: string;
}

export interface PhaseResult {
  readonly phasePath: string;
  readonly attempt: number;
  readonly kind: "actor" | "code" | "agent";
  readonly outcome: "succeeded" | "failed" | "interrupted";
  readonly description: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly encodedResult: JsonValue;
}
