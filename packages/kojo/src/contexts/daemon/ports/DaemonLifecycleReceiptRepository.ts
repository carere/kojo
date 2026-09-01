import type { Effect } from "effect";
import type {
  DaemonLifecycleReceipt,
  DaemonLifecycleReceiptStage,
} from "../models/DaemonLifecycleReceipt.ts";
import type { LifecycleError } from "../models/LifecycleError.ts";
import type { LifecycleRecordedOwner } from "../models/LifecycleOperation.ts";

export interface DaemonLifecycleReceiptRepository {
  readonly activeDrainHeld: () => boolean;
  readonly read: (
    operationId: string,
  ) => Effect.Effect<DaemonLifecycleReceipt | undefined, LifecycleError>;
  readonly prepare: (request: {
    readonly operationId: string;
    readonly dataIdentity: string;
    readonly requestHash: string;
    readonly owner: LifecycleRecordedOwner;
  }) => Effect.Effect<DaemonLifecycleReceipt, LifecycleError>;
  readonly advance: (request: {
    readonly operationId: string;
    readonly expectedRevision: number;
    readonly stage: DaemonLifecycleReceiptStage;
    readonly owner: LifecycleRecordedOwner;
    readonly handoffDigest?: string;
    readonly forceAuthorizationId?: string;
    readonly drainHeld?: boolean;
  }) => Effect.Effect<DaemonLifecycleReceipt, LifecycleError>;
}
