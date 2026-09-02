import { LifecycleError } from "../models/LifecycleError.ts";
import type { LifecycleOperation, LifecycleOperationKind } from "../models/LifecycleOperation.ts";
import type { LifecycleJournalRepository } from "../ports/LifecycleJournalRepository.ts";

/** Select only an exact pending lifecycle operation of the requested kind. */
export const plannedLifecycleResume = (
  journal: LifecycleJournalRepository,
  kind: LifecycleOperationKind,
  pendingOperationId?: string,
): LifecycleOperation | undefined => {
  const operation =
    pendingOperationId === undefined ? journal.current() : journal.read(pendingOperationId);
  if (operation === undefined || operation.outcome !== undefined) {
    if (pendingOperationId !== undefined) {
      throw new LifecycleError(
        "LIFECYCLE_OPERATION_NOT_PENDING",
        `--pending must name a pending ${kind} operation`,
      );
    }
    return undefined;
  }
  if (operation.kind !== kind) {
    throw new LifecycleError(
      "LIFECYCLE_OPERATION_PENDING",
      `lifecycle operation ${operation.operationId} is pending as ${operation.kind}, not ${kind}`,
    );
  }
  return operation;
};
