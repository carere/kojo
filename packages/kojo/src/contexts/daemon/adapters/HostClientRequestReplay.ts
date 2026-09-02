import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { OperationReceipt } from "@carere/kojo-client-contracts/contexts/client/contracts/operation";
import type { JsonValue } from "@carere/kojo-client-contracts/contexts/shared/codecs/json";
import type { DaemonPaths } from "../models/DaemonPaths.ts";
import { LifecycleError } from "../models/LifecycleError.ts";
import type { NativeService } from "../ports/NativeService.ts";
import { assertPrivateNode } from "../services/secureHostPath.ts";
import { FileLifecycleJournalRepository } from "./FileLifecycleJournalRepository.ts";
import { HostClientRequestRepository } from "./HostClientRequestRepository.ts";
import { macLaunchAgent } from "./MacLaunchAgent.ts";
import { ManagedDaemonSupervision } from "./ManagedDaemonSupervision.ts";
import { PurgeSafetyRecovery } from "./PurgeSafetyRecovery.ts";
import { systemdUserService } from "./SystemdUserService.ts";

const dataIdentityAt = (paths: DaemonPaths): string => {
  const path = join(paths.dataRoot, "lifecycle", "data-identity");
  assertPrivateNode(path, "file");
  const identity = readFileSync(path, "utf8").trim();
  if (!/^[A-Za-z0-9_-]+$/.test(identity)) {
    throw new LifecycleError(
      "DAEMON_DATA_IDENTITY_UNKNOWN",
      "the durable offline Daemon data identity is invalid",
    );
  }
  return identity;
};

const nativeService = (): NativeService => {
  if (process.platform === "darwin") return macLaunchAgent();
  if (process.platform === "linux") return systemdUserService();
  throw new LifecycleError("UNSUPPORTED_HOST", "Kojo supports macOS and systemd Linux Hosts");
};

const planTokenOf = (arguments_: JsonValue): string => {
  if (arguments_ === null || Array.isArray(arguments_) || typeof arguments_ !== "object") {
    throw new LifecycleError(
      "CLIENT_REQUEST_DAMAGED",
      "the retained repair request does not contain its exact plan token",
    );
  }
  const token = (arguments_ as Readonly<Record<string, JsonValue>>).planToken;
  if (typeof token !== "string") {
    throw new LifecycleError(
      "CLIENT_REQUEST_DAMAGED",
      "the retained repair request does not contain its exact plan token",
    );
  }
  return token;
};

/** Replay Host-only repair operations from exact private journal content. */
export const replayHostClientRequest = async (
  paths: DaemonPaths,
  requestId: string,
): Promise<OperationReceipt | undefined> => {
  const dataIdentity = dataIdentityAt(paths);
  const repository = new HostClientRequestRepository(
    join(paths.dataRoot, "client-requests"),
    dataIdentity,
  );
  const retained = repository.lookup(requestId);
  if (retained === undefined) return undefined;
  if (retained.request === undefined) {
    return {
      receiptVersion: 1,
      requestId,
      dataIdentity,
      operation: retained.subject.operation,
      status: retained.resolution?.status ?? "committed",
      ...(retained.resolution === undefined
        ? {}
        : { result: retained.resolution.resultReference as unknown as JsonValue }),
    };
  }
  const mutation = retained.request;
  if (
    mutation.dataIdentity !== dataIdentity ||
    mutation.target.kind !== "daemonData" ||
    mutation.target.parts.length !== 1 ||
    mutation.target.parts[0] !== dataIdentity
  ) {
    throw new LifecycleError(
      "CLIENT_REQUEST_TARGET_MISMATCH",
      "the retained Host repair request does not name the current Daemon data",
    );
  }
  let result: JsonValue;
  if (mutation.operation === "repairDaemonSupervision") {
    result = new ManagedDaemonSupervision(paths.dataRoot).applyRepair(
      planTokenOf(mutation.arguments),
    ) as unknown as JsonValue;
  } else if (mutation.operation === "repairPurgeSafety") {
    result = (await new PurgeSafetyRecovery({
      paths,
      journal: new FileLifecycleJournalRepository(join(paths.dataRoot, "lifecycle")),
      nativeService: nativeService(),
    }).apply(planTokenOf(mutation.arguments))) as unknown as JsonValue;
  } else {
    return undefined;
  }
  repository.resolve(requestId, {
    resolvedAt: new Date().toISOString(),
    status: "committed",
    resultReference: { identityVersion: 1, kind: "clientRequestResult", parts: [requestId] },
  });
  return {
    receiptVersion: 1,
    requestId,
    dataIdentity,
    operation: mutation.operation,
    status: "committed",
    result,
  };
};
