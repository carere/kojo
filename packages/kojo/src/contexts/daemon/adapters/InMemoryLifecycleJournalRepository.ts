import { LifecycleError } from "../models/LifecycleError.ts";
import type {
  LifecycleForceAuthorization,
  LifecycleOperation,
} from "../models/LifecycleOperation.ts";
import type {
  AdvanceLifecycleOperation,
  BeginLifecycleOperation,
  LifecycleJournalRepository,
} from "../ports/LifecycleJournalRepository.ts";
import {
  advanceLifecycleOperation,
  beginLifecycleOperation,
} from "../services/lifecycleJournalRules.ts";

export class InMemoryLifecycleJournalRepository implements LifecycleJournalRepository {
  readonly #operations = new Map<string, LifecycleOperation>();
  readonly #authorizations = new Map<string, LifecycleForceAuthorization>();
  readonly #controlSecrets = new Map<string, string>();
  #currentOperationId: string | undefined;

  readonly begin = (request: BeginLifecycleOperation): LifecycleOperation => {
    const priorCurrent = this.current();
    const existed = this.#operations.has(request.operationId);
    const operation = beginLifecycleOperation(
      request,
      this.#operations.get(request.operationId),
      priorCurrent,
    );
    this.#operations.set(operation.operationId, operation);
    if (!this.#controlSecrets.has(operation.operationId)) {
      this.#controlSecrets.set(
        operation.operationId,
        crypto.getRandomValues(new Uint8Array(32)).toHex(),
      );
    }
    if (!existed || priorCurrent?.operationId === operation.operationId) {
      this.#currentOperationId = operation.operationId;
    }
    return operation;
  };

  readonly read = (operationId: string): LifecycleOperation | undefined =>
    this.#operations.get(operationId);

  readonly current = (): LifecycleOperation | undefined =>
    this.#currentOperationId === undefined
      ? undefined
      : this.#operations.get(this.#currentOperationId);

  readonly advance = (request: AdvanceLifecycleOperation): LifecycleOperation => {
    const current = this.#operations.get(request.operationId);
    if (current === undefined) {
      throw new LifecycleError(
        "LIFECYCLE_OPERATION_NOT_FOUND",
        "the lifecycle operation was not found",
      );
    }
    const operation = advanceLifecycleOperation(current, request);
    this.#operations.set(operation.operationId, operation);
    return operation;
  };

  readonly authorizeForce = (request: LifecycleForceAuthorization): LifecycleOperation => {
    if (
      request.formatVersion !== 1 ||
      !/^[A-Za-z0-9_-]+$/.test(request.authorizationId) ||
      !/^[A-Za-z0-9_-]+$/.test(request.pendingOperationId) ||
      !/^[a-f0-9]{64}$/.test(request.requestHash) ||
      !Number.isFinite(Date.parse(request.authorizedAt))
    ) {
      throw new LifecycleError(
        "INVALID_LIFECYCLE_FORCE",
        "the force authorization identity, hash, or time is invalid",
      );
    }
    const operation = this.#operations.get(request.pendingOperationId);
    if (
      operation === undefined ||
      operation.outcome !== undefined ||
      this.current()?.operationId !== operation.operationId
    ) {
      throw new LifecycleError(
        "LIFECYCLE_FORCE_NOT_PENDING",
        "force must name the current pending drain",
      );
    }
    const existing = this.#authorizations.get(request.authorizationId);
    if (existing !== undefined) {
      if (
        existing.pendingOperationId !== request.pendingOperationId ||
        existing.requestHash !== request.requestHash
      ) {
        throw new LifecycleError(
          "LIFECYCLE_FORCE_CONFLICT",
          "the force authorization ID already names different content",
        );
      }
      if (operation.forceAuthorizationId === request.authorizationId) return operation;
    }
    if (operation.stage !== "draining") {
      throw new LifecycleError(
        "LIFECYCLE_FORCE_NOT_PENDING",
        "a new force authorization requires the current pending drain",
      );
    }
    const pendingAuthorization = [...this.#authorizations.values()].find(
      (candidate) => candidate.pendingOperationId === request.pendingOperationId,
    );
    if (
      operation.forceAuthorizationId !== undefined &&
      operation.forceAuthorizationId !== request.authorizationId
    ) {
      throw new LifecycleError(
        "LIFECYCLE_FORCE_CONFLICT",
        `the pending drain already names force authorization ${operation.forceAuthorizationId}`,
      );
    }
    if (
      pendingAuthorization !== undefined &&
      pendingAuthorization.authorizationId !== request.authorizationId
    ) {
      throw new LifecycleError(
        "LIFECYCLE_FORCE_CONFLICT",
        `force authorization ${pendingAuthorization.authorizationId} must be replayed`,
      );
    }
    if (existing === undefined) this.#authorizations.set(request.authorizationId, request);
    if (operation.forceAuthorizationId === request.authorizationId) return operation;
    return this.advance({
      operationId: operation.operationId,
      expectedRevision: operation.stageRevision,
      stage: operation.stage,
      updatedAt: request.authorizedAt,
      changes: { forceAuthorizationId: request.authorizationId },
    });
  };

  readonly controlSecret = (operationId: string): string => {
    const secret = this.#controlSecrets.get(operationId);
    if (secret === undefined) {
      throw new LifecycleError(
        "LIFECYCLE_OPERATION_NOT_FOUND",
        "the lifecycle operation has no control credential",
      );
    }
    return secret;
  };

  readonly forceAuthorizationFor = (operationId: string): LifecycleForceAuthorization | undefined =>
    [...this.#authorizations.values()].find(
      (authorization) => authorization.pendingOperationId === operationId,
    );
}
