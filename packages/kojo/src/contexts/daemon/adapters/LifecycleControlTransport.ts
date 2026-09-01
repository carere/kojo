import { chmodSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { LifecycleError } from "../models/LifecycleError.ts";
import type {
  LifecycleDrainProgress,
  LifecycleRecordedOwner,
  UpgradeBackupEvidence,
  UpgradeReadinessEvidence,
} from "../models/LifecycleOperation.ts";
import type {
  UpgradeFinalPreflight,
  UpgradeHandoff,
  UpgradeRollbackSafety,
} from "../models/UpgradeActivation.ts";
import type { DaemonLifecycleControl, LifecycleHandoff } from "../ports/DaemonLifecycleControl.ts";
import type { DaemonUpgradeControl } from "../ports/DaemonUpgradeControl.ts";
import type { LifecycleJournalRepository } from "../ports/LifecycleJournalRepository.ts";
import { removeOwnedSocket } from "../services/secureHostPath.ts";

type ControlAction =
  | "inspect-preflight"
  | "begin-drain"
  | "read-drain"
  | "prepare-handoff"
  | "confirm-controller-ready"
  | "stop-owned-processes"
  | "confirm-replacement-ready";

interface ControlRequest {
  readonly formatVersion: 1;
  readonly operationId: string;
  readonly controlSecret: string;
  readonly action: ControlAction;
  readonly dataIdentity?: string;
  readonly requestHash?: string;
  readonly handoffDigest?: string;
  readonly cleanupMillis?: number;
  readonly replacementExpected?: boolean;
  readonly forceAuthorizationId?: string;
  readonly priorDaemonInstanceId?: string;
}

interface ControlResponse<A> {
  readonly formatVersion: 1;
  readonly ok: boolean;
  readonly value?: A;
  readonly code?: string;
  readonly message?: string;
}

type UpgradeControlAction =
  | "upgrade-inspect-preflight"
  | "upgrade-begin-drain"
  | "upgrade-read-drain"
  | "upgrade-force-drain"
  | "upgrade-hold-mutations"
  | "upgrade-repeat-final-preflight"
  | "upgrade-release-holds"
  | "upgrade-prepare-handoff"
  | "upgrade-confirm-controller-ready"
  | "upgrade-create-backup"
  | "upgrade-stop-owned-processes"
  | "upgrade-read-candidate-readiness"
  | "upgrade-authorize-activation"
  | "upgrade-inspect-rollback-safety"
  | "upgrade-read-rollback-readiness"
  | "upgrade-authorize-rollback";

interface UpgradeControlRequest {
  readonly formatVersion: 1;
  readonly operationId: string;
  readonly controlSecret: string;
  readonly action: UpgradeControlAction;
  readonly dataIdentity?: string;
  readonly requestHash?: string;
  readonly sourceReleaseId?: string;
  readonly candidateReleaseId?: string;
  readonly checkedRetainedSetHash?: string;
  readonly handoffDigest?: string;
  readonly cleanupMillis?: number;
  readonly forceAuthorizationId?: string;
  readonly priorDaemonInstanceId?: string;
  readonly readiness?: UpgradeReadinessEvidence;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const exactKeys = (value: Record<string, unknown>, keys: ReadonlyArray<string>): boolean => {
  const expected = new Set(keys);
  return (
    Object.keys(value).length === expected.size &&
    Object.keys(value).every((key) => expected.has(key))
  );
};

const ownerOf = (value: unknown): LifecycleRecordedOwner => {
  const owner = record(value);
  if (
    owner === undefined ||
    !exactKeys(owner, ["daemonInstanceId", "runnerInstanceIds", "recordedAt"]) ||
    typeof owner.daemonInstanceId !== "string" ||
    !/^[A-Za-z0-9_-]+$/.test(owner.daemonInstanceId) ||
    !Array.isArray(owner.runnerInstanceIds) ||
    !owner.runnerInstanceIds.every(
      (runnerInstanceId) =>
        typeof runnerInstanceId === "string" && /^[A-Za-z0-9_-]+$/.test(runnerInstanceId),
    ) ||
    typeof owner.recordedAt !== "string" ||
    !Number.isFinite(Date.parse(owner.recordedAt))
  ) {
    throw new LifecycleError(
      "LIFECYCLE_CONTROL_UNAVAILABLE",
      "the lifecycle control owner response is invalid",
    );
  }
  return owner as unknown as LifecycleRecordedOwner;
};

const drainOf = (value: unknown): LifecycleDrainProgress => {
  const drain = record(value);
  if (
    drain === undefined ||
    !exactKeys(drain, ["held", "executingRunIds", "observedAt"]) ||
    drain.held !== true ||
    !Array.isArray(drain.executingRunIds) ||
    !drain.executingRunIds.every(
      (runId) => typeof runId === "string" && /^[A-Za-z0-9_-]+$/.test(runId),
    ) ||
    typeof drain.observedAt !== "string" ||
    !Number.isFinite(Date.parse(drain.observedAt))
  ) {
    throw new LifecycleError(
      "LIFECYCLE_CONTROL_UNAVAILABLE",
      "the lifecycle control drain response is invalid",
    );
  }
  return drain as unknown as LifecycleDrainProgress;
};

const backupOf = (value: unknown): UpgradeBackupEvidence => {
  const backup = record(value);
  if (
    backup === undefined ||
    !exactKeys(backup, ["backupId", "sha256", "dataVersion", "verifiedAt"]) ||
    typeof backup.backupId !== "string" ||
    !/^[A-Za-z0-9_-]+$/.test(backup.backupId) ||
    typeof backup.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(backup.sha256) ||
    typeof backup.dataVersion !== "string" ||
    !/^[a-f0-9]{64}$/.test(backup.dataVersion) ||
    typeof backup.verifiedAt !== "string" ||
    !Number.isFinite(Date.parse(backup.verifiedAt))
  ) {
    throw new LifecycleError(
      "LIFECYCLE_CONTROL_UNAVAILABLE",
      "the lifecycle control backup response is invalid",
    );
  }
  return backup as unknown as UpgradeBackupEvidence;
};

const readinessOf = (value: unknown): UpgradeReadinessEvidence => {
  const readiness = record(value);
  if (
    readiness === undefined ||
    !exactKeys(readiness, [
      "daemonInstanceId",
      "dataIdentity",
      "sourceReleaseId",
      "candidateReleaseId",
      "receiptDigest",
      "wakeupDigest",
      "integrity",
      "transports",
      "workflowExecutions",
      "checkedAt",
    ]) ||
    typeof readiness.daemonInstanceId !== "string" ||
    !/^[A-Za-z0-9_-]+$/.test(readiness.daemonInstanceId) ||
    typeof readiness.dataIdentity !== "string" ||
    readiness.dataIdentity.length === 0 ||
    typeof readiness.sourceReleaseId !== "string" ||
    !/^[A-Za-z0-9._-]+$/.test(readiness.sourceReleaseId) ||
    typeof readiness.candidateReleaseId !== "string" ||
    !/^[A-Za-z0-9._-]+$/.test(readiness.candidateReleaseId) ||
    typeof readiness.receiptDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(readiness.receiptDigest) ||
    typeof readiness.wakeupDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(readiness.wakeupDigest) ||
    readiness.integrity !== "ok" ||
    readiness.transports !== "ready" ||
    readiness.workflowExecutions !== 0 ||
    typeof readiness.checkedAt !== "string" ||
    !Number.isFinite(Date.parse(readiness.checkedAt))
  ) {
    throw new LifecycleError(
      "LIFECYCLE_CONTROL_UNAVAILABLE",
      "the lifecycle control readiness response is invalid",
    );
  }
  return readiness as unknown as UpgradeReadinessEvidence;
};

const finalPreflightOf = (value: unknown): UpgradeFinalPreflight => {
  const result = record(value);
  if (
    result === undefined ||
    !exactKeys(result, ["outcome", "retainedSetHash", "owner", "detail"]) ||
    (result.outcome !== "accepted" && result.outcome !== "refused") ||
    typeof result.retainedSetHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(result.retainedSetHash) ||
    typeof result.detail !== "string"
  ) {
    throw new LifecycleError(
      "LIFECYCLE_CONTROL_UNAVAILABLE",
      "the lifecycle control final preflight response is invalid",
    );
  }
  return {
    outcome: result.outcome,
    retainedSetHash: result.retainedSetHash,
    owner: ownerOf(result.owner),
    detail: result.detail,
  };
};

const rollbackSafetyOf = (value: unknown): UpgradeRollbackSafety => {
  const result = record(value);
  if (
    result === undefined ||
    !exactKeys(result, ["safe", "sourceReleaseId", "dataVersion", "executionStopped", "detail"]) ||
    typeof result.safe !== "boolean" ||
    typeof result.sourceReleaseId !== "string" ||
    !/^[A-Za-z0-9._-]+$/.test(result.sourceReleaseId) ||
    typeof result.dataVersion !== "string" ||
    !/^[a-f0-9]{64}$/.test(result.dataVersion) ||
    typeof result.executionStopped !== "boolean" ||
    typeof result.detail !== "string"
  ) {
    throw new LifecycleError(
      "LIFECYCLE_CONTROL_UNAVAILABLE",
      "the lifecycle control rollback-safety response is invalid",
    );
  }
  return result as unknown as UpgradeRollbackSafety;
};

const controlResponseValue = (value: unknown, action: ControlAction): unknown => {
  const response = record(value);
  if (response === undefined || response.formatVersion !== 1 || typeof response.ok !== "boolean") {
    throw new LifecycleError(
      "LIFECYCLE_CONTROL_UNAVAILABLE",
      "the lifecycle control response envelope is invalid",
    );
  }
  if (!response.ok) {
    if (
      !exactKeys(response, ["formatVersion", "ok", "code", "message"]) ||
      typeof response.code !== "string" ||
      response.code.length === 0 ||
      typeof response.message !== "string" ||
      response.message.length === 0
    ) {
      throw new LifecycleError(
        "LIFECYCLE_CONTROL_UNAVAILABLE",
        "the lifecycle control failure response is invalid",
      );
    }
    throw new LifecycleError(response.code, response.message);
  }
  if (!exactKeys(response, ["formatVersion", "ok", "value"])) {
    throw new LifecycleError(
      "LIFECYCLE_CONTROL_UNAVAILABLE",
      "the lifecycle control success response is invalid",
    );
  }
  switch (action) {
    case "inspect-preflight":
    case "stop-owned-processes":
    case "confirm-replacement-ready":
      return ownerOf(response.value);
    case "begin-drain":
    case "read-drain":
      return drainOf(response.value);
    case "prepare-handoff": {
      const handoff = record(response.value);
      if (
        handoff === undefined ||
        !exactKeys(handoff, ["digest", "owner"]) ||
        typeof handoff.digest !== "string" ||
        !/^[a-f0-9]{64}$/.test(handoff.digest)
      ) {
        throw new LifecycleError(
          "LIFECYCLE_CONTROL_UNAVAILABLE",
          "the lifecycle control handoff response is invalid",
        );
      }
      return { digest: handoff.digest, owner: ownerOf(handoff.owner) } satisfies LifecycleHandoff;
    }
    case "confirm-controller-ready":
      if (response.value !== null) {
        throw new LifecycleError(
          "LIFECYCLE_CONTROL_UNAVAILABLE",
          "the lifecycle control acknowledgement response is invalid",
        );
      }
      return undefined;
  }
};

const upgradeResponseValue = (value: unknown, action: UpgradeControlAction): unknown => {
  const response = record(value);
  if (response === undefined || response.formatVersion !== 1 || typeof response.ok !== "boolean") {
    throw new LifecycleError(
      "LIFECYCLE_CONTROL_UNAVAILABLE",
      "the lifecycle control response envelope is invalid",
    );
  }
  if (!response.ok) {
    if (
      !exactKeys(response, ["formatVersion", "ok", "code", "message"]) ||
      typeof response.code !== "string" ||
      typeof response.message !== "string"
    ) {
      throw new LifecycleError(
        "LIFECYCLE_CONTROL_UNAVAILABLE",
        "the lifecycle control failure response is invalid",
      );
    }
    throw new LifecycleError(response.code, response.message);
  }
  if (!exactKeys(response, ["formatVersion", "ok", "value"])) {
    throw new LifecycleError(
      "LIFECYCLE_CONTROL_UNAVAILABLE",
      "the lifecycle control success response is invalid",
    );
  }
  switch (action) {
    case "upgrade-inspect-preflight":
    case "upgrade-stop-owned-processes":
    case "upgrade-authorize-activation":
    case "upgrade-authorize-rollback":
      return ownerOf(response.value);
    case "upgrade-begin-drain":
    case "upgrade-read-drain":
    case "upgrade-force-drain":
      return drainOf(response.value);
    case "upgrade-repeat-final-preflight":
      return finalPreflightOf(response.value);
    case "upgrade-prepare-handoff": {
      const handoff = record(response.value);
      if (
        handoff === undefined ||
        !exactKeys(handoff, ["digest", "owner"]) ||
        typeof handoff.digest !== "string" ||
        !/^[a-f0-9]{64}$/.test(handoff.digest)
      ) {
        throw new LifecycleError(
          "LIFECYCLE_CONTROL_UNAVAILABLE",
          "the lifecycle control handoff response is invalid",
        );
      }
      return { digest: handoff.digest, owner: ownerOf(handoff.owner) } satisfies UpgradeHandoff;
    }
    case "upgrade-create-backup":
      return backupOf(response.value);
    case "upgrade-read-candidate-readiness":
    case "upgrade-read-rollback-readiness":
      return readinessOf(response.value);
    case "upgrade-inspect-rollback-safety":
      return rollbackSafetyOf(response.value);
    case "upgrade-hold-mutations":
    case "upgrade-release-holds":
    case "upgrade-confirm-controller-ready":
      if (response.value !== null) {
        throw new LifecycleError(
          "LIFECYCLE_CONTROL_UNAVAILABLE",
          "the lifecycle control acknowledgement response is invalid",
        );
      }
      return undefined;
  }
};

const requestOf = (value: unknown): ControlRequest => {
  const object =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const actions: ReadonlyArray<ControlAction> = [
    "inspect-preflight",
    "begin-drain",
    "read-drain",
    "prepare-handoff",
    "confirm-controller-ready",
    "stop-owned-processes",
    "confirm-replacement-ready",
  ];
  if (
    object === undefined ||
    object.formatVersion !== 1 ||
    typeof object.operationId !== "string" ||
    !/^[A-Za-z0-9_-]+$/.test(object.operationId) ||
    typeof object.controlSecret !== "string" ||
    !/^[a-f0-9]{64}$/.test(object.controlSecret) ||
    typeof object.action !== "string" ||
    !actions.includes(object.action as ControlAction)
  ) {
    throw new LifecycleError(
      "INVALID_LIFECYCLE_CONTROL",
      "the lifecycle control request is invalid",
    );
  }
  const action = object.action as ControlAction;
  const actionFields: Readonly<Record<ControlAction, ReadonlyArray<string>>> = {
    "inspect-preflight": ["dataIdentity", "requestHash"],
    "begin-drain": ["dataIdentity", "requestHash"],
    "read-drain": [],
    "prepare-handoff": [],
    "confirm-controller-ready": ["handoffDigest"],
    "stop-owned-processes": ["cleanupMillis", "replacementExpected", "forceAuthorizationId"],
    "confirm-replacement-ready": ["priorDaemonInstanceId"],
  };
  const allowed = new Set([
    "formatVersion",
    "operationId",
    "controlSecret",
    "action",
    ...actionFields[action],
  ]);
  if (Object.keys(object).some((key) => !allowed.has(key))) {
    throw new LifecycleError(
      "INVALID_LIFECYCLE_CONTROL",
      "the lifecycle control request contains fields for a different action",
    );
  }
  if (
    (action === "inspect-preflight" || action === "begin-drain") &&
    (typeof object.dataIdentity !== "string" ||
      object.dataIdentity.length === 0 ||
      typeof object.requestHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(object.requestHash))
  ) {
    throw new LifecycleError(
      "INVALID_LIFECYCLE_CONTROL",
      "preflight and drain require a data identity and request hash",
    );
  }
  if (
    action === "confirm-controller-ready" &&
    (typeof object.handoffDigest !== "string" || !/^[a-f0-9]{64}$/.test(object.handoffDigest))
  ) {
    throw new LifecycleError("INVALID_LIFECYCLE_CONTROL", "the handoff digest is invalid");
  }
  if (
    action === "stop-owned-processes" &&
    (object.cleanupMillis !== 30_000 ||
      typeof object.replacementExpected !== "boolean" ||
      (object.forceAuthorizationId !== undefined &&
        (typeof object.forceAuthorizationId !== "string" ||
          !/^[A-Za-z0-9_-]+$/.test(object.forceAuthorizationId))))
  ) {
    throw new LifecycleError(
      "INVALID_LIFECYCLE_CONTROL",
      "cleanup requires the accepted interval, replacement decision, and valid force identity",
    );
  }
  if (
    action === "confirm-replacement-ready" &&
    (typeof object.priorDaemonInstanceId !== "string" ||
      !/^[A-Za-z0-9_-]+$/.test(object.priorDaemonInstanceId))
  ) {
    throw new LifecycleError(
      "INVALID_LIFECYCLE_CONTROL",
      "the prior Daemon instance identity is invalid",
    );
  }
  return object as unknown as ControlRequest;
};

const upgradeRequestOf = (value: unknown): UpgradeControlRequest => {
  const object = record(value);
  const actions: ReadonlyArray<UpgradeControlAction> = [
    "upgrade-inspect-preflight",
    "upgrade-begin-drain",
    "upgrade-read-drain",
    "upgrade-force-drain",
    "upgrade-hold-mutations",
    "upgrade-repeat-final-preflight",
    "upgrade-release-holds",
    "upgrade-prepare-handoff",
    "upgrade-confirm-controller-ready",
    "upgrade-create-backup",
    "upgrade-stop-owned-processes",
    "upgrade-read-candidate-readiness",
    "upgrade-authorize-activation",
    "upgrade-inspect-rollback-safety",
    "upgrade-read-rollback-readiness",
    "upgrade-authorize-rollback",
  ];
  if (
    object === undefined ||
    object.formatVersion !== 1 ||
    typeof object.operationId !== "string" ||
    !/^[A-Za-z0-9_-]+$/.test(object.operationId) ||
    typeof object.controlSecret !== "string" ||
    !/^[a-f0-9]{64}$/.test(object.controlSecret) ||
    typeof object.action !== "string" ||
    !actions.includes(object.action as UpgradeControlAction)
  ) {
    throw new LifecycleError(
      "INVALID_LIFECYCLE_CONTROL",
      "the managed upgrade control request is invalid",
    );
  }
  const action = object.action as UpgradeControlAction;
  const fields: Readonly<Record<UpgradeControlAction, ReadonlyArray<string>>> = {
    "upgrade-inspect-preflight": [
      "dataIdentity",
      "requestHash",
      "sourceReleaseId",
      "candidateReleaseId",
      "checkedRetainedSetHash",
    ],
    "upgrade-begin-drain": [],
    "upgrade-read-drain": [],
    "upgrade-force-drain": ["cleanupMillis", "forceAuthorizationId"],
    "upgrade-hold-mutations": [],
    "upgrade-repeat-final-preflight": ["candidateReleaseId", "checkedRetainedSetHash"],
    "upgrade-release-holds": [],
    "upgrade-prepare-handoff": [],
    "upgrade-confirm-controller-ready": ["handoffDigest"],
    "upgrade-create-backup": [],
    "upgrade-stop-owned-processes": ["cleanupMillis", "forceAuthorizationId"],
    "upgrade-read-candidate-readiness": ["priorDaemonInstanceId"],
    "upgrade-authorize-activation": ["readiness"],
    "upgrade-inspect-rollback-safety": ["sourceReleaseId"],
    "upgrade-read-rollback-readiness": [],
    "upgrade-authorize-rollback": ["readiness"],
  };
  const allowed = new Set([
    "formatVersion",
    "operationId",
    "controlSecret",
    "action",
    ...fields[action],
  ]);
  if (Object.keys(object).some((key) => !allowed.has(key))) {
    throw new LifecycleError(
      "INVALID_LIFECYCLE_CONTROL",
      "the managed upgrade control request contains fields for a different action",
    );
  }
  const release = (value_: unknown): boolean =>
    typeof value_ === "string" && /^[A-Za-z0-9._-]+$/.test(value_);
  if (
    action === "upgrade-inspect-preflight" &&
    (typeof object.dataIdentity !== "string" ||
      object.dataIdentity.length === 0 ||
      typeof object.requestHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(object.requestHash) ||
      !release(object.sourceReleaseId) ||
      !release(object.candidateReleaseId) ||
      typeof object.checkedRetainedSetHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(object.checkedRetainedSetHash))
  ) {
    throw new LifecycleError(
      "INVALID_LIFECYCLE_CONTROL",
      "managed upgrade preflight identities are invalid",
    );
  }
  if (
    action === "upgrade-repeat-final-preflight" &&
    (!release(object.candidateReleaseId) ||
      typeof object.checkedRetainedSetHash !== "string" ||
      !/^[a-f0-9]{64}$/.test(object.checkedRetainedSetHash))
  ) {
    throw new LifecycleError(
      "INVALID_LIFECYCLE_CONTROL",
      "the final preflight identity is invalid",
    );
  }
  if (
    action === "upgrade-confirm-controller-ready" &&
    (typeof object.handoffDigest !== "string" || !/^[a-f0-9]{64}$/.test(object.handoffDigest))
  ) {
    throw new LifecycleError("INVALID_LIFECYCLE_CONTROL", "the handoff digest is invalid");
  }
  if (
    (action === "upgrade-stop-owned-processes" || action === "upgrade-force-drain") &&
    (object.cleanupMillis !== 30_000 ||
      (object.forceAuthorizationId !== undefined &&
        (typeof object.forceAuthorizationId !== "string" ||
          !/^[A-Za-z0-9_-]+$/.test(object.forceAuthorizationId))))
  ) {
    throw new LifecycleError(
      "INVALID_LIFECYCLE_CONTROL",
      "managed upgrade cleanup evidence is invalid",
    );
  }
  if (
    action === "upgrade-read-candidate-readiness" &&
    (typeof object.priorDaemonInstanceId !== "string" ||
      !/^[A-Za-z0-9_-]+$/.test(object.priorDaemonInstanceId))
  ) {
    throw new LifecycleError(
      "INVALID_LIFECYCLE_CONTROL",
      "the prior Daemon instance identity is invalid",
    );
  }
  if (action === "upgrade-inspect-rollback-safety" && !release(object.sourceReleaseId)) {
    throw new LifecycleError(
      "INVALID_LIFECYCLE_CONTROL",
      "the exact rollback source release identity is invalid",
    );
  }
  if (
    (action === "upgrade-authorize-activation" || action === "upgrade-authorize-rollback") &&
    object.readiness !== readinessOf(object.readiness)
  ) {
    throw new LifecycleError("INVALID_LIFECYCLE_CONTROL", "the readiness evidence is invalid");
  }
  return object as unknown as UpgradeControlRequest;
};

const failure = (cause: unknown): LifecycleError =>
  cause instanceof LifecycleError
    ? cause
    : new LifecycleError(
        "LIFECYCLE_CONTROL_UNAVAILABLE",
        cause instanceof Error ? cause.message : String(cause),
        cause,
      );

const requiredString = (value: string | undefined, name: string): string => {
  if (value === undefined || value.length === 0) {
    throw new LifecycleError("INVALID_LIFECYCLE_CONTROL", `${name} is required`);
  }
  return value;
};

export interface LifecycleControlServer {
  readonly stop: () => void;
}

export const startLifecycleControlServer = (options: {
  readonly socketPath: string;
  readonly control: DaemonLifecycleControl;
  readonly journal: LifecycleJournalRepository;
  readonly upgradeControl?: DaemonUpgradeControl;
}): LifecycleControlServer => {
  removeOwnedSocket(options.socketPath);
  const server = Bun.serve({
    unix: options.socketPath,
    async fetch(request) {
      try {
        if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
        if (new URL(request.url).pathname === "/upgrade-control") {
          if (options.upgradeControl === undefined) {
            throw new LifecycleError(
              "LIFECYCLE_CONTROL_UNAVAILABLE",
              "this Daemon has no managed upgrade control owner",
            );
          }
          const message = upgradeRequestOf(await request.json());
          if (options.journal.controlSecret(message.operationId) !== message.controlSecret) {
            throw new LifecycleError(
              "LIFECYCLE_CONTROL_REFUSED",
              "the lifecycle control credential is not valid for this operation",
            );
          }
          let value: unknown;
          switch (message.action) {
            case "upgrade-inspect-preflight":
              value = await Effect.runPromise(
                options.upgradeControl.inspectPreflight(
                  message.operationId,
                  requiredString(message.dataIdentity, "dataIdentity"),
                  requiredString(message.requestHash, "requestHash"),
                  requiredString(message.sourceReleaseId, "sourceReleaseId"),
                  requiredString(message.candidateReleaseId, "candidateReleaseId"),
                  requiredString(message.checkedRetainedSetHash, "checkedRetainedSetHash"),
                ),
              );
              break;
            case "upgrade-begin-drain":
              value = await Effect.runPromise(
                options.upgradeControl.beginDrain(message.operationId),
              );
              break;
            case "upgrade-read-drain":
              value = await Effect.runPromise(
                options.upgradeControl.readDrain(message.operationId),
              );
              break;
            case "upgrade-force-drain": {
              if (
                message.cleanupMillis === undefined ||
                message.forceAuthorizationId === undefined
              ) {
                throw new LifecycleError(
                  "INVALID_LIFECYCLE_CONTROL",
                  "forced drain cleanup and authorization are required",
                );
              }
              const authorization = options.journal.forceAuthorizationFor(message.operationId);
              if (authorization?.authorizationId !== message.forceAuthorizationId) {
                throw new LifecycleError(
                  "LIFECYCLE_CONTROL_REFUSED",
                  "the force authorization is not valid for this managed upgrade",
                );
              }
              value = await Effect.runPromise(
                options.upgradeControl.forceDrain(
                  message.operationId,
                  message.cleanupMillis,
                  message.forceAuthorizationId,
                ),
              );
              break;
            }
            case "upgrade-hold-mutations":
              value = await Effect.runPromise(
                options.upgradeControl.holdMutations(message.operationId),
              );
              break;
            case "upgrade-repeat-final-preflight":
              value = await Effect.runPromise(
                options.upgradeControl.repeatFinalPreflight(
                  message.operationId,
                  requiredString(message.candidateReleaseId, "candidateReleaseId"),
                  requiredString(message.checkedRetainedSetHash, "checkedRetainedSetHash"),
                ),
              );
              break;
            case "upgrade-release-holds":
              value = await Effect.runPromise(
                options.upgradeControl.releaseUpgradeHolds(message.operationId),
              );
              break;
            case "upgrade-prepare-handoff":
              value = await Effect.runPromise(
                options.upgradeControl.prepareHandoff(message.operationId),
              );
              break;
            case "upgrade-confirm-controller-ready":
              value = await Effect.runPromise(
                options.upgradeControl.confirmControllerReady(
                  message.operationId,
                  requiredString(message.handoffDigest, "handoffDigest"),
                ),
              );
              break;
            case "upgrade-create-backup":
              value = await Effect.runPromise(
                options.upgradeControl.createVerifiedBackup(message.operationId),
              );
              break;
            case "upgrade-stop-owned-processes":
              if (message.cleanupMillis === undefined) {
                throw new LifecycleError("INVALID_LIFECYCLE_CONTROL", "cleanupMillis is required");
              }
              value = await Effect.runPromise(
                options.upgradeControl.stopOwnedProcesses(
                  message.operationId,
                  message.cleanupMillis,
                  message.forceAuthorizationId,
                ),
              );
              break;
            case "upgrade-read-candidate-readiness":
              value = await Effect.runPromise(
                options.upgradeControl.readCandidateReadiness(
                  message.operationId,
                  requiredString(message.priorDaemonInstanceId, "priorDaemonInstanceId"),
                ),
              );
              break;
            case "upgrade-authorize-activation":
              value = await Effect.runPromise(
                options.upgradeControl.authorizeActivation(
                  message.operationId,
                  readinessOf(message.readiness),
                ),
              );
              break;
            case "upgrade-inspect-rollback-safety":
              value = await Effect.runPromise(
                options.upgradeControl.inspectRollbackSafety(
                  message.operationId,
                  requiredString(message.sourceReleaseId, "sourceReleaseId"),
                ),
              );
              break;
            case "upgrade-read-rollback-readiness":
              value = await Effect.runPromise(
                options.upgradeControl.readRollbackReadiness(message.operationId),
              );
              break;
            case "upgrade-authorize-rollback":
              value = await Effect.runPromise(
                options.upgradeControl.authorizeRollback(
                  message.operationId,
                  readinessOf(message.readiness),
                ),
              );
              break;
          }
          return Response.json({
            formatVersion: 1,
            ok: true,
            value: value ?? null,
          } satisfies ControlResponse<unknown>);
        }
        const message = requestOf(await request.json());
        if (options.journal.controlSecret(message.operationId) !== message.controlSecret) {
          throw new LifecycleError(
            "LIFECYCLE_CONTROL_REFUSED",
            "the lifecycle control credential is not valid for this operation",
          );
        }
        let value: unknown;
        switch (message.action) {
          case "inspect-preflight":
            value = await Effect.runPromise(
              options.control.inspectPreflight(
                message.operationId,
                requiredString(message.dataIdentity, "dataIdentity"),
                requiredString(message.requestHash, "requestHash"),
              ),
            );
            break;
          case "begin-drain":
            value = await Effect.runPromise(
              options.control.beginDrain(
                message.operationId,
                requiredString(message.dataIdentity, "dataIdentity"),
                requiredString(message.requestHash, "requestHash"),
              ),
            );
            break;
          case "read-drain":
            value = await Effect.runPromise(options.control.readDrain(message.operationId));
            break;
          case "prepare-handoff":
            value = await Effect.runPromise(options.control.prepareHandoff(message.operationId));
            break;
          case "confirm-controller-ready":
            value = await Effect.runPromise(
              options.control.confirmControllerReady(
                message.operationId,
                requiredString(message.handoffDigest, "handoffDigest"),
              ),
            );
            break;
          case "stop-owned-processes":
            if (message.cleanupMillis === undefined || message.replacementExpected === undefined) {
              throw new LifecycleError(
                "INVALID_LIFECYCLE_CONTROL",
                "cleanupMillis and replacementExpected are required",
              );
            }
            value = await Effect.runPromise(
              options.control.stopOwnedProcesses(
                message.operationId,
                message.cleanupMillis,
                message.replacementExpected,
                message.forceAuthorizationId,
              ),
            );
            break;
          case "confirm-replacement-ready":
            value = await Effect.runPromise(
              options.control.confirmReplacementReady(
                message.operationId,
                requiredString(message.priorDaemonInstanceId, "priorDaemonInstanceId"),
              ),
            );
            break;
          default:
            throw new LifecycleError(
              "INVALID_LIFECYCLE_CONTROL",
              "the lifecycle control action is not supported",
            );
        }
        return Response.json({
          formatVersion: 1,
          ok: true,
          value: value ?? null,
        } satisfies ControlResponse<unknown>);
      } catch (cause) {
        const error = failure(cause);
        return Response.json(
          {
            formatVersion: 1,
            ok: false,
            code: error.code,
            message: error.message,
          } satisfies ControlResponse<never>,
          { status: 409 },
        );
      }
    },
  });
  chmodSync(options.socketPath, 0o600);
  const owned = lstatSync(options.socketPath);
  return {
    stop: () => {
      server.stop(true);
      try {
        const current = lstatSync(options.socketPath);
        if (current.dev === owned.dev && current.ino === owned.ino) {
          removeOwnedSocket(options.socketPath);
        }
      } catch {
        // Endpoint loss is already the desired stopped state.
      }
    },
  };
};

export class SocketDaemonLifecycleControl implements DaemonLifecycleControl {
  readonly #socketPath: string;
  readonly #journal: LifecycleJournalRepository;

  constructor(runtimeRoot: string, journal: LifecycleJournalRepository) {
    this.#socketPath = join(runtimeRoot, "lifecycle-control.sock");
    this.#journal = journal;
  }

  #call<A>(
    operationId: string,
    action: ControlAction,
    arguments_: Omit<
      ControlRequest,
      "formatVersion" | "operationId" | "controlSecret" | "action"
    > = {},
  ): Effect.Effect<A, LifecycleError> {
    return Effect.tryPromise({
      try: async () => {
        const response = await fetch("http://localhost/control", {
          unix: this.#socketPath,
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            formatVersion: 1,
            operationId,
            controlSecret: this.#journal.controlSecret(operationId),
            action,
            ...arguments_,
          } satisfies ControlRequest),
        });
        const body = await response.json();
        if (!response.ok && record(body)?.ok !== false) {
          throw new LifecycleError(
            "LIFECYCLE_CONTROL_UNAVAILABLE",
            "the lifecycle control endpoint returned an invalid failure response",
          );
        }
        return controlResponseValue(body, action) as A;
      },
      catch: failure,
    });
  }

  readonly inspectPreflight = (operationId: string, dataIdentity: string, requestHash: string) =>
    this.#call<LifecycleRecordedOwner>(operationId, "inspect-preflight", {
      dataIdentity,
      requestHash,
    });

  readonly beginDrain = (operationId: string, dataIdentity: string, requestHash: string) =>
    this.#call<LifecycleDrainProgress>(operationId, "begin-drain", {
      dataIdentity,
      requestHash,
    });

  readonly readDrain = (operationId: string) =>
    this.#call<LifecycleDrainProgress>(operationId, "read-drain");

  readonly prepareHandoff = (operationId: string) =>
    this.#call<LifecycleHandoff>(operationId, "prepare-handoff");

  readonly confirmControllerReady = (operationId: string, handoffDigest: string) =>
    this.#call<void>(operationId, "confirm-controller-ready", { handoffDigest });

  readonly stopOwnedProcesses = (
    operationId: string,
    cleanupMillis: number,
    replacementExpected: boolean,
    forceAuthorizationId?: string,
  ) =>
    this.#call<LifecycleRecordedOwner>(operationId, "stop-owned-processes", {
      cleanupMillis,
      replacementExpected,
      ...(forceAuthorizationId === undefined ? {} : { forceAuthorizationId }),
    });

  readonly confirmReplacementReady = (operationId: string, priorDaemonInstanceId: string) =>
    this.#call<LifecycleRecordedOwner>(operationId, "confirm-replacement-ready", {
      priorDaemonInstanceId,
    });
}

export class SocketDaemonUpgradeControl implements DaemonUpgradeControl {
  readonly #socketPath: string;
  readonly #journal: LifecycleJournalRepository;

  constructor(runtimeRoot: string, journal: LifecycleJournalRepository) {
    this.#socketPath = join(runtimeRoot, "lifecycle-control.sock");
    this.#journal = journal;
  }

  #call<A>(
    operationId: string,
    action: UpgradeControlAction,
    arguments_: Omit<
      UpgradeControlRequest,
      "formatVersion" | "operationId" | "controlSecret" | "action"
    > = {},
  ): Effect.Effect<A, LifecycleError> {
    return Effect.tryPromise({
      try: async () => {
        const response = await fetch("http://localhost/upgrade-control", {
          unix: this.#socketPath,
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            formatVersion: 1,
            operationId,
            controlSecret: this.#journal.controlSecret(operationId),
            action,
            ...arguments_,
          } satisfies UpgradeControlRequest),
        });
        const body = await response.json();
        if (!response.ok && record(body)?.ok !== false) {
          throw new LifecycleError(
            "LIFECYCLE_CONTROL_UNAVAILABLE",
            "the lifecycle control endpoint returned an invalid failure response",
          );
        }
        return upgradeResponseValue(body, action) as A;
      },
      catch: failure,
    });
  }

  readonly inspectPreflight = (
    operationId: string,
    dataIdentity: string,
    requestHash: string,
    sourceReleaseId: string,
    candidateReleaseId: string,
    checkedRetainedSetHash: string,
  ) =>
    this.#call<LifecycleRecordedOwner>(operationId, "upgrade-inspect-preflight", {
      dataIdentity,
      requestHash,
      sourceReleaseId,
      candidateReleaseId,
      checkedRetainedSetHash,
    });

  readonly beginDrain = (operationId: string) =>
    this.#call<LifecycleDrainProgress>(operationId, "upgrade-begin-drain");

  readonly readDrain = (operationId: string) =>
    this.#call<LifecycleDrainProgress>(operationId, "upgrade-read-drain");

  readonly forceDrain = (
    operationId: string,
    cleanupMillis: number,
    forceAuthorizationId: string,
  ) =>
    this.#call<LifecycleDrainProgress>(operationId, "upgrade-force-drain", {
      cleanupMillis,
      forceAuthorizationId,
    });

  readonly holdMutations = (operationId: string) =>
    this.#call<void>(operationId, "upgrade-hold-mutations");

  readonly repeatFinalPreflight = (
    operationId: string,
    candidateReleaseId: string,
    checkedRetainedSetHash: string,
  ) =>
    this.#call<UpgradeFinalPreflight>(operationId, "upgrade-repeat-final-preflight", {
      candidateReleaseId,
      checkedRetainedSetHash,
    });

  readonly releaseUpgradeHolds = (operationId: string) =>
    this.#call<void>(operationId, "upgrade-release-holds");

  readonly prepareHandoff = (operationId: string) =>
    this.#call<UpgradeHandoff>(operationId, "upgrade-prepare-handoff");

  readonly confirmControllerReady = (operationId: string, handoffDigest: string) =>
    this.#call<void>(operationId, "upgrade-confirm-controller-ready", { handoffDigest });

  readonly createVerifiedBackup = (operationId: string) =>
    this.#call<UpgradeBackupEvidence>(operationId, "upgrade-create-backup");

  readonly stopOwnedProcesses = (
    operationId: string,
    cleanupMillis: number,
    forceAuthorizationId?: string,
  ) =>
    this.#call<LifecycleRecordedOwner>(operationId, "upgrade-stop-owned-processes", {
      cleanupMillis,
      ...(forceAuthorizationId === undefined ? {} : { forceAuthorizationId }),
    });

  readonly readCandidateReadiness = (operationId: string, priorDaemonInstanceId: string) =>
    this.#call<UpgradeReadinessEvidence>(operationId, "upgrade-read-candidate-readiness", {
      priorDaemonInstanceId,
    });

  readonly authorizeActivation = (operationId: string, readiness: UpgradeReadinessEvidence) =>
    this.#call<LifecycleRecordedOwner>(operationId, "upgrade-authorize-activation", {
      readiness,
    });

  readonly inspectRollbackSafety = (operationId: string, sourceReleaseId: string) =>
    this.#call<UpgradeRollbackSafety>(operationId, "upgrade-inspect-rollback-safety", {
      sourceReleaseId,
    });

  readonly readRollbackReadiness = (operationId: string) =>
    this.#call<UpgradeReadinessEvidence>(operationId, "upgrade-read-rollback-readiness");

  readonly authorizeRollback = (operationId: string, readiness: UpgradeReadinessEvidence) =>
    this.#call<LifecycleRecordedOwner>(operationId, "upgrade-authorize-rollback", {
      readiness,
    });
}
