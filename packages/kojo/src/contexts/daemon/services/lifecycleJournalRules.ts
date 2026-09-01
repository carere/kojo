import { LifecycleError } from "../models/LifecycleError.ts";
import { type LifecycleOperation, lifecycleStageOrder } from "../models/LifecycleOperation.ts";
import type {
  AdvanceLifecycleOperation,
  BeginLifecycleOperation,
} from "../ports/LifecycleJournalRepository.ts";

const terminal = (operation: LifecycleOperation): boolean => operation.outcome !== undefined;
const validReleaseId = (value: string): boolean =>
  value !== "." && value !== ".." && /^[A-Za-z0-9._-]+$/.test(value);

export const beginLifecycleOperation = (
  request: BeginLifecycleOperation,
  existing: LifecycleOperation | undefined,
  current: LifecycleOperation | undefined,
): LifecycleOperation => {
  if (
    !/^[A-Za-z0-9_-]+$/.test(request.operationId) ||
    request.dataIdentity.length === 0 ||
    !/^[a-f0-9]{64}$/.test(request.originalRequestHash) ||
    !validReleaseId(request.sourceReleaseId) ||
    !Number.isFinite(Date.parse(request.startedAt))
  ) {
    throw new LifecycleError(
      "INVALID_LIFECYCLE_REQUEST",
      "the lifecycle request identity, hash, release, or time is invalid",
    );
  }
  if (existing !== undefined) {
    if (
      existing.dataIdentity !== request.dataIdentity ||
      existing.originalRequestHash !== request.originalRequestHash ||
      existing.kind !== request.kind ||
      existing.sourceReleaseId !== request.sourceReleaseId
    ) {
      throw new LifecycleError(
        "LIFECYCLE_REQUEST_CONFLICT",
        "the lifecycle operation ID already names different request content",
      );
    }
    return existing;
  }
  if (current?.outcome === "repair-required") {
    throw new LifecycleError(
      "LIFECYCLE_REPAIR_REQUIRED",
      `lifecycle operation ${current.operationId} requires repair before new lifecycle work`,
    );
  }
  if (current !== undefined && !terminal(current)) {
    throw new LifecycleError(
      "LIFECYCLE_OPERATION_PENDING",
      `lifecycle operation ${current.operationId} is still ${current.stage}`,
    );
  }
  return {
    formatVersion: 1,
    operationId: request.operationId,
    dataIdentity: request.dataIdentity,
    originalRequestHash: request.originalRequestHash,
    kind: request.kind,
    sourceReleaseId: request.sourceReleaseId,
    stage: "prepared",
    stageRevision: 1,
    startedAt: request.startedAt,
    updatedAt: request.startedAt,
    compatibility: "not-applicable",
    rollbackAttempted: false,
  };
};

export const advanceLifecycleOperation = (
  operation: LifecycleOperation,
  request: AdvanceLifecycleOperation,
): LifecycleOperation => {
  if (operation.operationId !== request.operationId) {
    throw new LifecycleError("LIFECYCLE_OPERATION_MISMATCH", "the lifecycle operation changed");
  }
  if (operation.stageRevision !== request.expectedRevision) {
    throw new LifecycleError(
      "LIFECYCLE_REVISION_CONFLICT",
      `lifecycle operation ${operation.operationId} is at revision ${operation.stageRevision}`,
    );
  }
  if (operation.outcome !== undefined) return operation;
  if (lifecycleStageOrder[request.stage] < lifecycleStageOrder[operation.stage]) {
    throw new LifecycleError(
      "LIFECYCLE_STAGE_REGRESSION",
      `lifecycle stage ${request.stage} is before ${operation.stage}`,
    );
  }
  return {
    ...operation,
    ...request.changes,
    stage: request.stage,
    stageRevision: operation.stageRevision + 1,
    updatedAt: request.updatedAt,
  };
};
