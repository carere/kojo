import type {
  AskingDocument,
  AskingIdentity,
  GateExpiryBranch,
  GateVerdict,
} from "@carere/kojo-client-contracts/contexts/client/contracts/gate";

export interface DaemonAsking extends AskingDocument {
  readonly token: string;
  readonly internalDeferredName: string;
  readonly createdAt: string;
}

export interface CreateAsking {
  readonly identity: AskingIdentity;
  readonly projectId: string;
  readonly workflowName: string;
  readonly description: string;
  readonly actor: string;
  readonly choices: ReadonlyArray<string>;
  readonly deadline: string;
  readonly expiryBranch: GateExpiryBranch;
  readonly internalDeferredName: string;
  readonly createdAt: string;
  readonly token: string;
}

export interface RecordVerdictTransition {
  readonly dataIdentity: string;
  readonly requestId: string;
  readonly canonicalRequest: string;
  readonly token: string;
  readonly choice: string;
  readonly reason: string;
  readonly answerer: string;
  readonly now: string;
}

export interface GateTransitionReceipt {
  readonly asking: DaemonAsking;
  readonly requestId: string;
  readonly duplicate: boolean;
}

export interface DeferredApplication {
  readonly deferredName: string;
  readonly result: GateVerdict | null;
  readonly wakeupId: string;
  readonly kind: "verdict" | "expiry";
}
