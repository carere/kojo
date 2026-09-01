import type { LifecycleRecordedOwner } from "./LifecycleOperation.ts";

export type DaemonLifecycleReceiptStage =
  | "prepared"
  | "draining"
  | "handoff-prepared"
  | "controller-accepted"
  | "cleanup-started"
  | "process-stopped"
  | "replacement-ready";

export interface DaemonLifecycleReceipt {
  readonly operationId: string;
  readonly dataIdentity: string;
  readonly requestHash: string;
  readonly stage: DaemonLifecycleReceiptStage;
  readonly revision: number;
  readonly drainHeld: boolean;
  readonly owner: LifecycleRecordedOwner;
  readonly handoffDigest?: string;
  readonly forceAuthorizationId?: string;
}
