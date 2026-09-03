import type { MutationEnvelope } from "@carere/kojo-client-contracts/contexts/client/contracts/mutation";
import type { OperationReceipt } from "@carere/kojo-client-contracts/contexts/client/contracts/operation";

/** Daemon-owned operation outcomes. A domain adapter calls record inside its own transaction. */
export interface OperationRepository {
  readonly read: (dataIdentity: string, requestId: string) => OperationReceipt | undefined;
  readonly readExact: (request: MutationEnvelope) => OperationReceipt | undefined;
  readonly record: (
    request: MutationEnvelope,
    receipt: OperationReceipt,
    recordedAt: string,
  ) => OperationReceipt;
}
