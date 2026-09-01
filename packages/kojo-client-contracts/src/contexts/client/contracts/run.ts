import type { JsonValue } from "../../shared/codecs/json.ts";

export type RunExecutionState =
  | "queued"
  | "executing"
  | "suspended"
  | "held"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface RunPhaseDocument {
  readonly phasePath: string;
  readonly attempt: number;
  readonly kind: "actor" | "code" | "agent";
  readonly outcome: "succeeded" | "failed" | "interrupted";
  readonly description: string;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly result?: JsonValue;
}

/** One Daemon-owned Run observation. The authored payload is intentionally not exposed. */
export interface RunDocument {
  readonly runId: string;
  readonly projectId: string;
  readonly workflowName: string;
  readonly revisionId: string;
  readonly packageGraphId: string;
  readonly state: RunExecutionState;
  readonly queueReason?:
    | "execution-capacity"
    | "project-capacity"
    | "runner-starting"
    | "package-switch"
    | "pinned-content";
  readonly executionFault?: {
    readonly code:
      | "RETAINED_CONTENT_MISSING"
      | "RETAINED_CONTENT_CORRUPT"
      | "RETAINED_HOST_INCOMPATIBLE"
      | "RETAINED_BUN_INCOMPATIBLE"
      | "RETAINED_EFFECT_INCOMPATIBLE"
      | "RETAINED_PROTOCOL_INCOMPATIBLE";
    readonly detail: string;
    readonly remedy: string;
    readonly retry?: "after-repair" | "after-compatible-release";
    readonly scope?: {
      readonly projectId: string;
      readonly workflowName: string;
      readonly revisionId: string;
      readonly packageGraphId: string;
    };
    readonly diagnostic?: string;
  };
  readonly admittedAt: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly phases: ReadonlyArray<RunPhaseDocument>;
}

export interface RunSnapshot {
  readonly observationVersion: 1;
  readonly instanceId: string;
  readonly dataIdentity: string;
  readonly snapshotVersion: number;
  readonly observedAt: string;
  readonly refreshAfterMillis: number;
  readonly runs: ReadonlyArray<RunDocument>;
}

export interface StartRunResult {
  readonly kind: "run";
  readonly runId: string;
  readonly duplicate: boolean;
  readonly revisionId: string;
  readonly state: RunExecutionState;
}
