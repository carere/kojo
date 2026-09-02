import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { discardMaterializedRevisionCacheForPurge } from "../../project/services/materializeRevision.ts";
import { acquireDaemonStartGate } from "../adapters/DaemonDataPurger.ts";
import { FileLifecycleJournalRepository } from "../adapters/FileLifecycleJournalRepository.ts";
import { readPurgeRecoveryCapsule } from "../adapters/PurgeRecoveryCapsule.ts";
import { consumePurgeSafetyRecoveryAuthorization } from "../adapters/PurgeSafetyRecovery.ts";
import { SqlitePurgeSafetyRepository } from "../adapters/SqlitePurgeSafetyRepository.ts";
import type { DaemonPaths } from "../models/DaemonPaths.ts";
import { LifecycleError } from "../models/LifecycleError.ts";
import type { NativeService } from "../ports/NativeService.ts";
import {
  acquireDaemonSingletonLock,
  type DaemonSingletonLock,
} from "../services/DaemonSingletonLock.ts";
import { assertPrivateNode } from "../services/secureHostPath.ts";

/** Seal purge safety under sole Daemon data ownership without starting application behavior. */
export const recoverPurgeSafety = async (
  paths: DaemonPaths,
  operationId: string,
  planToken: string,
  capability: string,
  nativeService: NativeService,
  now: () => number = Date.now,
): Promise<void> => {
  if (!/^[A-Za-z0-9_-]+$/.test(operationId)) {
    throw new LifecycleError(
      "PURGE_RECOVERY_OPERATION_INVALID",
      "the restricted purge recovery operation identity is invalid",
    );
  }
  const assertStoppedDisabled = (): void => {
    const observed = nativeService.inspect();
    if (observed.process !== "stopped" || observed.automaticStart !== "disabled") {
      throw new LifecycleError(
        "PURGE_RECOVERY_SERVICE_UNSAFE",
        "restricted purge recovery requires stopped ownership and disabled automatic start",
      );
    }
  };
  assertStoppedDisabled();
  const plan = consumePurgeSafetyRecoveryAuthorization(
    paths,
    planToken,
    operationId,
    capability,
    now(),
  );
  assertPrivateNode(paths.dataRoot, "directory");
  const gate = acquireDaemonStartGate(paths);
  let lock: DaemonSingletonLock | undefined;
  let database: Database | undefined;
  try {
    assertStoppedDisabled();
    lock = acquireDaemonSingletonLock(join(paths.dataRoot, "daemon.lock"));
    const databasePath = join(paths.dataRoot, "kojo.db");
    assertPrivateNode(databasePath, "file");
    database = new Database(databasePath, { create: false, strict: true });
    database.run("PRAGMA foreign_keys = ON");
    database.run("PRAGMA synchronous = FULL");
    const dataIdentity = database
      .query<{ readonly value: string }, []>(
        "SELECT value FROM daemon_metadata WHERE name = 'data_identity'",
      )
      .get()?.value;
    if (dataIdentity === undefined || dataIdentity.length === 0) {
      throw new LifecycleError(
        "DAEMON_DATA_IDENTITY_DAMAGED",
        "the retained database has no Daemon data identity",
      );
    }
    const capsule = readPurgeRecoveryCapsule(paths, dataIdentity);
    if (capsule.sourceReleaseId !== plan.sourceReleaseId) {
      throw new LifecycleError(
        "PURGE_RECOVERY_PLAN_STALE",
        "the restricted recovery capsule changed after the exact check",
      );
    }
    const journal = new FileLifecycleJournalRepository(join(paths.dataRoot, "lifecycle"));
    const operation = journal.read(operationId);
    if (
      operation === undefined ||
      journal.current()?.operationId !== operationId ||
      operation.outcome !== undefined ||
      operation.dataIdentity !== dataIdentity ||
      operation.sourceReleaseId !== plan.sourceReleaseId ||
      !(
        (operation.kind === "remove" && operation.stage === "prepared") ||
        (operation.kind === "purge-recovery" && operation.stage === "prepared")
      )
    ) {
      throw new LifecycleError(
        "PURGE_RECOVERY_PLAN_STALE",
        "the exact lifecycle operation changed before restricted recovery",
      );
    }
    const identityPath = join(paths.dataRoot, "lifecycle", "data-identity");
    assertPrivateNode(identityPath, "file");
    if (readFileSync(identityPath, "utf8").trim() !== dataIdentity) {
      throw new LifecycleError(
        "DAEMON_DATA_IDENTITY_CONFLICT",
        "the retained offline identity does not match the sole-owner database",
      );
    }
    const issuedAt = new Date(now()).toISOString();
    await Effect.runPromise(
      new SqlitePurgeSafetyRepository(
        database,
        dataIdentity,
        paths.dataRoot,
        paths.configurationRoot,
        () => discardMaterializedRevisionCacheForPurge(join(paths.dataRoot, "runner-materialized")),
      ).seal(
        operationId,
        {
          daemonInstanceId: `purge-recovery-${crypto.randomUUID()}`,
          runnerInstanceIds: [],
          recordedAt: issuedAt,
        },
        issuedAt,
        new Date(now() + 10 * 60_000).toISOString(),
      ),
    );
    database.close(false);
    database = undefined;
  } finally {
    database?.close(false);
    lock?.unlock();
    gate.release();
  }
};
