import { dlopen, FFIType } from "bun:ffi";
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  openSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { LifecycleError } from "../models/LifecycleError.ts";
import type {
  LifecycleForceAuthorization,
  LifecycleOperation,
} from "../models/LifecycleOperation.ts";
import { lifecycleOperationKinds, lifecycleStages } from "../models/LifecycleOperation.ts";
import type {
  AdvanceLifecycleOperation,
  BeginLifecycleOperation,
  LifecycleJournalRepository,
} from "../ports/LifecycleJournalRepository.ts";
import {
  advanceLifecycleOperation,
  beginLifecycleOperation,
} from "../services/lifecycleJournalRules.ts";
import {
  assertPrivateNode,
  atomicPrivateFile,
  ensurePrivateDirectory,
} from "../services/secureHostPath.ts";

const validId = /^[A-Za-z0-9_-]+$/;
const validReleaseId = (value: string): boolean =>
  value !== "." && value !== ".." && /^[A-Za-z0-9._-]+$/.test(value);

const record = (value: unknown): Record<string, unknown> | undefined =>
  value === null || typeof value !== "object" || Array.isArray(value)
    ? undefined
    : (value as Record<string, unknown>);

const nonempty = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const validTime = (value: unknown): value is string =>
  nonempty(value) && Number.isFinite(Date.parse(value));

const validRecordedOwner = (value: unknown): boolean => {
  if (value === undefined) return true;
  const candidate = record(value);
  return (
    candidate !== undefined &&
    nonempty(candidate.daemonInstanceId) &&
    validId.test(candidate.daemonInstanceId) &&
    Array.isArray(candidate.runnerInstanceIds) &&
    candidate.runnerInstanceIds.every(
      (runnerInstanceId) => nonempty(runnerInstanceId) && validId.test(runnerInstanceId),
    ) &&
    validTime(candidate.recordedAt)
  );
};

const validDrain = (value: unknown): boolean => {
  if (value === undefined) return true;
  const candidate = record(value);
  return (
    candidate !== undefined &&
    candidate.held === true &&
    Array.isArray(candidate.executingRunIds) &&
    candidate.executingRunIds.every((runId) => nonempty(runId) && validId.test(runId)) &&
    validTime(candidate.observedAt)
  );
};

const validBackup = (value: unknown): boolean => {
  if (value === undefined) return true;
  const candidate = record(value);
  return (
    candidate !== undefined &&
    nonempty(candidate.backupId) &&
    validId.test(candidate.backupId) &&
    typeof candidate.sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(candidate.sha256) &&
    nonempty(candidate.dataVersion) &&
    /^[a-f0-9]{64}$/.test(candidate.dataVersion) &&
    validTime(candidate.verifiedAt)
  );
};

const validReadiness = (value: unknown): boolean => {
  if (value === undefined) return true;
  const candidate = record(value);
  return (
    candidate !== undefined &&
    nonempty(candidate.daemonInstanceId) &&
    validId.test(candidate.daemonInstanceId) &&
    nonempty(candidate.dataIdentity) &&
    nonempty(candidate.sourceReleaseId) &&
    validReleaseId(candidate.sourceReleaseId) &&
    nonempty(candidate.candidateReleaseId) &&
    validReleaseId(candidate.candidateReleaseId) &&
    typeof candidate.receiptDigest === "string" &&
    /^[a-f0-9]{64}$/.test(candidate.receiptDigest) &&
    typeof candidate.wakeupDigest === "string" &&
    /^[a-f0-9]{64}$/.test(candidate.wakeupDigest) &&
    candidate.integrity === "ok" &&
    candidate.transports === "ready" &&
    candidate.workflowExecutions === 0 &&
    validTime(candidate.checkedAt)
  );
};

const operationOf = (value: unknown): LifecycleOperation => {
  const candidate = record(value);
  if (
    candidate === undefined ||
    candidate.formatVersion !== 1 ||
    !nonempty(candidate.operationId) ||
    !validId.test(candidate.operationId) ||
    !nonempty(candidate.dataIdentity) ||
    !nonempty(candidate.originalRequestHash) ||
    !/^[a-f0-9]{64}$/.test(candidate.originalRequestHash) ||
    !lifecycleOperationKinds.includes(candidate.kind as never) ||
    !nonempty(candidate.sourceReleaseId) ||
    !validReleaseId(candidate.sourceReleaseId) ||
    (candidate.candidateReleaseId !== undefined &&
      (!nonempty(candidate.candidateReleaseId) || !validReleaseId(candidate.candidateReleaseId))) ||
    (candidate.checkedRetainedSetHash !== undefined &&
      (typeof candidate.checkedRetainedSetHash !== "string" ||
        !/^[a-f0-9]{64}$/.test(candidate.checkedRetainedSetHash))) ||
    (candidate.kind === "upgrade" &&
      (candidate.candidateReleaseId === undefined ||
        candidate.checkedRetainedSetHash === undefined)) ||
    !lifecycleStages.includes(candidate.stage as never) ||
    !Number.isSafeInteger(candidate.stageRevision) ||
    Number(candidate.stageRevision) < 1 ||
    !validTime(candidate.startedAt) ||
    !validTime(candidate.updatedAt) ||
    (candidate.compatibility !== "not-applicable" &&
      candidate.compatibility !== "pending" &&
      candidate.compatibility !== "accepted" &&
      candidate.compatibility !== "refused") ||
    typeof candidate.rollbackAttempted !== "boolean" ||
    !validDrain(candidate.drain) ||
    !validRecordedOwner(candidate.recordedOwner) ||
    (candidate.handoffDigest !== undefined &&
      (typeof candidate.handoffDigest !== "string" ||
        !/^[a-f0-9]{64}$/.test(candidate.handoffDigest))) ||
    (candidate.controllerAcceptedAt !== undefined && !validTime(candidate.controllerAcceptedAt)) ||
    (candidate.forceAuthorizationId !== undefined &&
      (typeof candidate.forceAuthorizationId !== "string" ||
        !validId.test(candidate.forceAuthorizationId))) ||
    (candidate.purgeSafetyEvidenceId !== undefined &&
      (typeof candidate.purgeSafetyEvidenceId !== "string" ||
        !validId.test(candidate.purgeSafetyEvidenceId))) ||
    !validBackup(candidate.backup) ||
    (candidate.migrationCheckpoint !== undefined &&
      (typeof candidate.migrationCheckpoint !== "string" ||
        candidate.migrationCheckpoint.length === 0)) ||
    !validReadiness(candidate.readiness) ||
    (candidate.outcome !== undefined &&
      candidate.outcome !== "succeeded" &&
      candidate.outcome !== "upgrade-refused" &&
      candidate.outcome !== "activated" &&
      candidate.outcome !== "rolled-back" &&
      candidate.outcome !== "repair-required") ||
    (candidate.detail !== undefined && typeof candidate.detail !== "string") ||
    (candidate.stage === "completed" && candidate.outcome !== "succeeded") ||
    (candidate.stage === "repair-required" && candidate.outcome !== "repair-required") ||
    (candidate.stage === "upgrade-refused" && candidate.outcome !== "upgrade-refused") ||
    (candidate.stage === "activated" && candidate.outcome !== "activated") ||
    (candidate.stage === "rolled-back" && candidate.outcome !== "rolled-back") ||
    (candidate.outcome === "succeeded" && candidate.stage !== "completed") ||
    (candidate.outcome === "upgrade-refused" && candidate.stage !== "upgrade-refused") ||
    (candidate.outcome === "activated" && candidate.stage !== "activated") ||
    (candidate.outcome === "rolled-back" && candidate.stage !== "rolled-back") ||
    (candidate.outcome === "repair-required" && candidate.stage !== "repair-required")
  ) {
    throw new LifecycleError(
      "LIFECYCLE_JOURNAL_DAMAGED",
      "the retained lifecycle operation is not valid",
    );
  }
  return value as LifecycleOperation;
};

const authorizationOf = (value: unknown): LifecycleForceAuthorization => {
  const candidate = record(value);
  if (
    candidate === undefined ||
    candidate.formatVersion !== 1 ||
    !nonempty(candidate.authorizationId) ||
    !validId.test(candidate.authorizationId) ||
    !nonempty(candidate.pendingOperationId) ||
    !validId.test(candidate.pendingOperationId) ||
    !nonempty(candidate.requestHash) ||
    !/^[a-f0-9]{64}$/.test(candidate.requestHash) ||
    !validTime(candidate.authorizedAt)
  ) {
    throw new LifecycleError(
      "LIFECYCLE_JOURNAL_DAMAGED",
      "the retained force authorization is not valid",
    );
  }
  return value as LifecycleForceAuthorization;
};

export class FileLifecycleJournalRepository implements LifecycleJournalRepository {
  readonly #root: string;
  readonly #operations: string;
  readonly #authorizations: string;
  readonly #controlSecrets: string;
  readonly #lockPath: string;
  readonly #readOnly: boolean;

  constructor(root: string, options: { readonly readOnly?: boolean } = {}) {
    this.#root = root;
    this.#operations = join(root, "operations");
    this.#authorizations = join(root, "force-authorizations");
    this.#controlSecrets = join(root, "control-secrets");
    this.#lockPath = join(root, "lifecycle.lock");
    this.#readOnly = options.readOnly ?? false;
    if (this.#readOnly) {
      assertPrivateNode(this.#root, "directory");
      for (const directory of [this.#operations, this.#authorizations, this.#controlSecrets]) {
        if (existsSync(directory)) assertPrivateNode(directory, "directory");
      }
    } else {
      ensurePrivateDirectory(this.#root);
      ensurePrivateDirectory(this.#operations);
      ensurePrivateDirectory(this.#authorizations);
      ensurePrivateDirectory(this.#controlSecrets);
    }
  }

  #id(id: string): string {
    if (!validId.test(id)) {
      throw new LifecycleError("INVALID_LIFECYCLE_ID", "the lifecycle identity is invalid");
    }
    return id;
  }

  #withLock<A>(body: () => A): A {
    if (this.#readOnly && !existsSync(this.#lockPath)) return body();
    const descriptor = openSync(
      this.#lockPath,
      (this.#readOnly ? constants.O_RDONLY : constants.O_CREAT | constants.O_RDWR) |
        constants.O_NOFOLLOW,
      0o600,
    );
    if (!this.#readOnly) fchmodSync(descriptor, 0o600);
    const stat = fstatSync(descriptor);
    if (
      stat.uid !== (process.getuid?.() ?? -1) ||
      !stat.isFile() ||
      (this.#readOnly && (stat.mode & 0o077) !== 0)
    ) {
      closeSync(descriptor);
      throw new LifecycleError("UNSAFE_LIFECYCLE_LOCK", "the lifecycle lock is not private");
    }
    const libraryName = process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6";
    const library = dlopen(libraryName, {
      flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    });
    if (library.symbols.flock(descriptor, 2) !== 0) {
      library.close();
      closeSync(descriptor);
      throw new LifecycleError("LIFECYCLE_LOCK_FAILED", "the lifecycle lock is unavailable");
    }
    try {
      return body();
    } finally {
      library.symbols.flock(descriptor, 8);
      library.close();
      closeSync(descriptor);
    }
  }

  #operationDirectory(operationId: string): string {
    return join(this.#operations, this.#id(operationId));
  }

  #write(operation: LifecycleOperation): void {
    const directory = this.#operationDirectory(operation.operationId);
    ensurePrivateDirectory(directory);
    atomicPrivateFile(
      join(directory, `${operation.stageRevision}.json`),
      `${JSON.stringify(operation)}\n`,
    );
  }

  #readUnlocked(operationId: string): LifecycleOperation | undefined {
    const directory = this.#operationDirectory(operationId);
    if (!existsSync(directory)) return undefined;
    assertPrivateNode(directory, "directory");
    const revision = readdirSync(directory)
      .map((name) =>
        /^(\d+)\.json$/.exec(name)?.[1] === undefined ? 0 : Number(name.slice(0, -5)),
      )
      .reduce((highest, candidate) => Math.max(highest, candidate), 0);
    if (revision === 0) {
      throw new LifecycleError(
        "LIFECYCLE_JOURNAL_DAMAGED",
        "the lifecycle operation has no durable revision",
      );
    }
    const path = join(directory, `${revision}.json`);
    assertPrivateNode(path, "file");
    const operation = operationOf(JSON.parse(readFileSync(path, "utf8")));
    if (operation.operationId !== operationId || operation.stageRevision !== revision) {
      throw new LifecycleError(
        "LIFECYCLE_JOURNAL_DAMAGED",
        "the lifecycle operation revision does not match its path",
      );
    }
    return operation;
  }

  #allOperationsUnlocked(): ReadonlyArray<LifecycleOperation> {
    return readdirSync(this.#operations).map((operationId) => {
      if (!validId.test(operationId)) {
        throw new LifecycleError(
          "LIFECYCLE_JOURNAL_DAMAGED",
          "the lifecycle journal contains an invalid operation path",
        );
      }
      const operation = this.#readUnlocked(operationId);
      if (operation === undefined) {
        throw new LifecycleError(
          "LIFECYCLE_JOURNAL_DAMAGED",
          "the lifecycle journal contains an empty operation path",
        );
      }
      return operation;
    });
  }

  #pointerUnlocked(): string | undefined {
    const path = join(this.#root, "current-operation");
    if (!existsSync(path)) return undefined;
    assertPrivateNode(path, "file");
    const operationId = readFileSync(path, "utf8").trim();
    return validId.test(operationId) ? operationId : undefined;
  }

  #currentUnlocked(): LifecycleOperation | undefined {
    const operations = existsSync(this.#operations) ? this.#allOperationsUnlocked() : [];
    const pending = operations.filter((operation) => operation.outcome === undefined);
    if (pending.length > 1) {
      throw new LifecycleError(
        "LIFECYCLE_JOURNAL_AMBIGUOUS",
        "the lifecycle journal contains more than one pending operation",
      );
    }
    const pointer = this.#pointerUnlocked();
    const pointed = operations.find((operation) => operation.operationId === pointer);
    const selected =
      pending[0] ??
      pointed ??
      operations.toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
    if (!this.#readOnly && selected !== undefined && pointer !== selected.operationId) {
      atomicPrivateFile(join(this.#root, "current-operation"), `${selected.operationId}\n`);
    }
    return selected;
  }

  readonly begin = (request: BeginLifecycleOperation): LifecycleOperation =>
    this.#withLock(() => {
      if (this.#readOnly) {
        throw new LifecycleError("LIFECYCLE_READ_ONLY", "the lifecycle journal is read-only");
      }
      const current = this.#currentUnlocked();
      const existing = this.#readUnlocked(request.operationId);
      const operation = beginLifecycleOperation(request, existing, current);
      if (existing === undefined) {
        atomicPrivateFile(
          join(this.#controlSecrets, request.operationId),
          `${crypto.getRandomValues(new Uint8Array(32)).toHex()}\n`,
        );
        this.#write(operation);
        atomicPrivateFile(join(this.#root, "current-operation"), `${operation.operationId}\n`);
      }
      return operation;
    });

  readonly read = (operationId: string): LifecycleOperation | undefined =>
    this.#withLock(() => this.#readUnlocked(operationId));

  readonly current = (): LifecycleOperation | undefined =>
    this.#withLock(() => this.#currentUnlocked());

  readonly advance = (request: AdvanceLifecycleOperation): LifecycleOperation =>
    this.#withLock(() => {
      if (this.#readOnly) {
        throw new LifecycleError("LIFECYCLE_READ_ONLY", "the lifecycle journal is read-only");
      }
      const current = this.#readUnlocked(request.operationId);
      if (current === undefined) {
        throw new LifecycleError(
          "LIFECYCLE_OPERATION_NOT_FOUND",
          "the lifecycle operation was not found",
        );
      }
      const operation = advanceLifecycleOperation(current, request);
      if (operation !== current) this.#write(operation);
      return operation;
    });

  readonly authorizeForce = (request: LifecycleForceAuthorization): LifecycleOperation =>
    this.#withLock(() => {
      if (this.#readOnly) {
        throw new LifecycleError("LIFECYCLE_READ_ONLY", "the lifecycle journal is read-only");
      }
      authorizationOf(request);
      const current = this.#readUnlocked(request.pendingOperationId);
      if (
        current === undefined ||
        current.outcome !== undefined ||
        this.#currentUnlocked()?.operationId !== current.operationId
      ) {
        throw new LifecycleError(
          "LIFECYCLE_FORCE_NOT_PENDING",
          "force must name the current pending drain",
        );
      }
      const authorizationPath = join(
        this.#authorizations,
        `${this.#id(request.authorizationId)}.json`,
      );
      const existingAuthorization = existsSync(authorizationPath)
        ? (() => {
            assertPrivateNode(authorizationPath, "file");
            return authorizationOf(JSON.parse(readFileSync(authorizationPath, "utf8")));
          })()
        : undefined;
      if (existingAuthorization !== undefined) {
        if (
          existingAuthorization.pendingOperationId !== request.pendingOperationId ||
          existingAuthorization.requestHash !== request.requestHash ||
          existingAuthorization.authorizedAt !== request.authorizedAt
        ) {
          throw new LifecycleError(
            "LIFECYCLE_FORCE_CONFLICT",
            "the force authorization ID already names different content",
          );
        }
        if (current.forceAuthorizationId === request.authorizationId) return current;
      }
      if (current.stage !== "draining") {
        throw new LifecycleError(
          "LIFECYCLE_FORCE_NOT_PENDING",
          "a new force authorization requires the current pending drain",
        );
      }
      const authorizations = readdirSync(this.#authorizations).map((name) => {
        const matched = /^([A-Za-z0-9_-]+)\.json$/.exec(name);
        if (matched?.[1] === undefined) {
          throw new LifecycleError(
            "LIFECYCLE_JOURNAL_DAMAGED",
            "the lifecycle journal contains an invalid force authorization path",
          );
        }
        const path = join(this.#authorizations, name);
        assertPrivateNode(path, "file");
        const authorization = authorizationOf(JSON.parse(readFileSync(path, "utf8")));
        if (authorization.authorizationId !== matched[1]) {
          throw new LifecycleError(
            "LIFECYCLE_JOURNAL_DAMAGED",
            "the force authorization does not match its path",
          );
        }
        return authorization;
      });
      const pendingAuthorization = authorizations.find(
        (candidate) => candidate.pendingOperationId === current.operationId,
      );
      if (
        current.forceAuthorizationId !== undefined &&
        current.forceAuthorizationId !== request.authorizationId
      ) {
        throw new LifecycleError(
          "LIFECYCLE_FORCE_CONFLICT",
          `the pending drain already names force authorization ${current.forceAuthorizationId}`,
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
      if (current.forceAuthorizationId === request.authorizationId) return current;
      if (existingAuthorization === undefined) {
        atomicPrivateFile(authorizationPath, `${JSON.stringify(request)}\n`);
      }
      const operation = advanceLifecycleOperation(current, {
        operationId: current.operationId,
        expectedRevision: current.stageRevision,
        stage: current.stage,
        updatedAt: request.authorizedAt,
        changes: { forceAuthorizationId: request.authorizationId },
      });
      this.#write(operation);
      return operation;
    });

  readonly controlSecret = (operationId: string): string =>
    this.#withLock(() => {
      const path = join(this.#controlSecrets, this.#id(operationId));
      if (!existsSync(path)) {
        throw new LifecycleError(
          "LIFECYCLE_OPERATION_NOT_FOUND",
          "the lifecycle operation has no control credential",
        );
      }
      assertPrivateNode(path, "file");
      const secret = readFileSync(path, "utf8").trim();
      if (!/^[a-f0-9]{64}$/.test(secret)) {
        throw new LifecycleError(
          "LIFECYCLE_JOURNAL_DAMAGED",
          "the lifecycle control credential is not valid",
        );
      }
      return secret;
    });

  readonly forceAuthorizationFor = (operationId: string): LifecycleForceAuthorization | undefined =>
    this.#withLock(() => {
      this.#id(operationId);
      const found = readdirSync(this.#authorizations).flatMap((name) => {
        const matched = /^([A-Za-z0-9_-]+)\.json$/.exec(name);
        if (matched?.[1] === undefined) {
          throw new LifecycleError(
            "LIFECYCLE_JOURNAL_DAMAGED",
            "the lifecycle journal contains an invalid force authorization path",
          );
        }
        const path = join(this.#authorizations, name);
        assertPrivateNode(path, "file");
        const authorization = authorizationOf(JSON.parse(readFileSync(path, "utf8")));
        if (authorization.authorizationId !== matched[1]) {
          throw new LifecycleError(
            "LIFECYCLE_JOURNAL_DAMAGED",
            "the force authorization does not match its path",
          );
        }
        return authorization.pendingOperationId === operationId ? [authorization] : [];
      });
      if (found.length > 1) {
        throw new LifecycleError(
          "LIFECYCLE_JOURNAL_AMBIGUOUS",
          "the pending lifecycle operation has more than one force authorization",
        );
      }
      return found[0];
    });
}
