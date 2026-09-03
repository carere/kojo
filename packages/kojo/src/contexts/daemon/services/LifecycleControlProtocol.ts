import { LifecycleError } from "../models/LifecycleError.ts";
import type {
  LifecycleRecordedOwner,
  UpgradeReadinessEvidence,
} from "../models/LifecycleOperation.ts";

export type LifecycleControlAction =
  | "inspect-preflight"
  | "begin-drain"
  | "read-drain"
  | "seal-purge-safety"
  | "prepare-handoff"
  | "confirm-controller-ready"
  | "stop-owned-processes"
  | "confirm-replacement-ready";

export interface LifecycleControlRequest {
  readonly formatVersion: 1;
  readonly operationId: string;
  readonly controlSecret: string;
  readonly action: LifecycleControlAction;
  readonly dataIdentity?: string;
  readonly requestHash?: string;
  readonly handoffDigest?: string;
  readonly cleanupMillis?: number;
  readonly replacementExpected?: boolean;
  readonly forceAuthorizationId?: string;
  readonly priorDaemonInstanceId?: string;
}

export type UpgradeControlAction =
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

export interface UpgradeControlRequest {
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

export const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

export const exactKeys = (value: Record<string, unknown>, keys: ReadonlyArray<string>): boolean => {
  const expected = new Set(keys);
  return (
    Object.keys(value).length === expected.size &&
    Object.keys(value).every((key) => expected.has(key))
  );
};

export const decodeLifecycleOwner = (value: unknown): LifecycleRecordedOwner => {
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

export const decodeLifecycleControlRequest = (value: unknown): LifecycleControlRequest => {
  const object = record(value);
  const actions: ReadonlyArray<LifecycleControlAction> = [
    "inspect-preflight",
    "begin-drain",
    "read-drain",
    "seal-purge-safety",
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
    !actions.includes(object.action as LifecycleControlAction)
  ) {
    throw new LifecycleError(
      "INVALID_LIFECYCLE_CONTROL",
      "the lifecycle control request is invalid",
    );
  }
  const action = object.action as LifecycleControlAction;
  const actionFields: Readonly<Record<LifecycleControlAction, ReadonlyArray<string>>> = {
    "inspect-preflight": ["dataIdentity", "requestHash"],
    "begin-drain": ["dataIdentity", "requestHash"],
    "read-drain": [],
    "seal-purge-safety": [],
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
  return object as unknown as LifecycleControlRequest;
};
