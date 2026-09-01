import { chmodSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { LifecycleError } from "../models/LifecycleError.ts";
import type {
  LifecycleDrainProgress,
  LifecycleRecordedOwner,
} from "../models/LifecycleOperation.ts";
import type { PurgeSafetyEvidence } from "../models/Purge.ts";
import type { DaemonLifecycleControl, LifecycleHandoff } from "../ports/DaemonLifecycleControl.ts";
import type { LifecycleJournalRepository } from "../ports/LifecycleJournalRepository.ts";
import { removeOwnedSocket } from "../services/secureHostPath.ts";

type ControlAction =
  | "inspect-preflight"
  | "begin-drain"
  | "read-drain"
  | "seal-purge-safety"
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

const purgeEvidenceOf = (value: unknown): PurgeSafetyEvidence => {
  const evidence = record(value);
  if (
    evidence === undefined ||
    evidence.formatVersion !== 1 ||
    typeof evidence.evidenceId !== "string" ||
    !/^[A-Za-z0-9_-]+$/.test(evidence.evidenceId) ||
    typeof evidence.operationId !== "string" ||
    typeof evidence.dataIdentity !== "string" ||
    typeof evidence.stateVersion !== "string" ||
    typeof evidence.correctnessFingerprint !== "string" ||
    !Array.isArray(evidence.resourceRisks) ||
    !Array.isArray(evidence.ownedScope) ||
    typeof evidence.issuedAt !== "string" ||
    typeof evidence.expiresAt !== "string" ||
    typeof evidence.seal !== "string" ||
    !/^[a-f0-9]{64}$/.test(evidence.seal)
  ) {
    throw new LifecycleError(
      "LIFECYCLE_CONTROL_UNAVAILABLE",
      "the lifecycle purge-safety response is invalid",
    );
  }
  return value as PurgeSafetyEvidence;
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
    case "seal-purge-safety":
      return purgeEvidenceOf(response.value);
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

const requestOf = (value: unknown): ControlRequest => {
  const object =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const actions: ReadonlyArray<ControlAction> = [
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
  return object as unknown as ControlRequest;
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
}): LifecycleControlServer => {
  removeOwnedSocket(options.socketPath);
  const server = Bun.serve({
    unix: options.socketPath,
    async fetch(request) {
      try {
        if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
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
          case "seal-purge-safety":
            if (options.control.sealPurgeSafety === undefined) {
              throw new LifecycleError(
                "PURGE_SAFETY_UNAVAILABLE",
                "the Daemon has no purge safety owner",
              );
            }
            value = await Effect.runPromise(options.control.sealPurgeSafety(message.operationId));
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

  readonly sealPurgeSafety = (operationId: string) =>
    this.#call<PurgeSafetyEvidence>(operationId, "seal-purge-safety");

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
