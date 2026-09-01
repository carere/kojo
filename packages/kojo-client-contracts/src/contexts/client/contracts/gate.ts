export type GateExpiryBranch = "fail" | "reject" | "escalate";
export type AskingState = "unanswered" | "recorded" | "applied" | "expired";

export interface AskingIdentity {
  readonly identityVersion: 1;
  readonly runId: string;
  readonly gatePath: string;
  readonly askingNumber: number;
  readonly escalationStage: number;
}

export interface GateVerdict {
  readonly choice: string;
  readonly reason: string;
  readonly answerer: string;
  readonly recordedAt: string;
}

export interface AskingDocument {
  readonly identity: AskingIdentity;
  /** Opaque authority to answer this exact Asking. It is not part of the Asking route. */
  readonly token: string;
  readonly projectId: string;
  readonly workflowName: string;
  readonly description: string;
  readonly actor: string;
  readonly choices: ReadonlyArray<string>;
  readonly createdAt: string;
  readonly deadline: string;
  readonly expiryBranch: GateExpiryBranch;
  readonly state: AskingState;
  readonly verdict?: GateVerdict;
  readonly appliedAt?: string;
  readonly expiredAt?: string;
  readonly expiryAppliedAt?: string;
  readonly terminalInability?: "run-cancelled" | "run-failed";
}

export interface AskingSnapshot {
  readonly observationVersion: 1;
  readonly instanceId: string;
  readonly dataIdentity: string;
  readonly snapshotVersion: number;
  readonly observedAt: string;
  readonly refreshAfterMillis: number;
  readonly askings: ReadonlyArray<AskingDocument>;
  readonly counts: {
    readonly total: number;
    readonly unanswered: number;
    readonly recorded: number;
    readonly applied: number;
    readonly expired: number;
  };
}

export interface RecordVerdictRequest {
  readonly requestId: string;
  readonly dataIdentity: string;
  readonly token: string;
  readonly choice: string;
  readonly reason: string;
  readonly answerer?: string;
}

export interface RecordVerdictResult {
  readonly asking: AskingDocument;
  readonly receipt: {
    readonly requestId: string;
    readonly state: "committed";
    readonly duplicate: boolean;
  };
}
