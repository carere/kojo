import type { JsonValue } from "@carere/kojo-client-contracts/contexts/shared/codecs/json";

export type DaemonRunState = "queued" | "executing" | "succeeded" | "failed";

export interface DaemonRun {
  readonly runId: string;
  readonly projectId: string;
  readonly workflowName: string;
  readonly idempotencyKey: string;
  readonly payload: JsonValue;
  readonly revisionId: string;
  readonly packageGraphId: string;
  readonly state: DaemonRunState;
  readonly admissionSequence: number;
  readonly admittedAt: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
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
