#!/usr/bin/env bun
import { join } from "node:path";
import { Effect } from "effect";
import { recoverPurgeSafety, startDaemon } from "../contexts/daemon/adapters/DaemonOwner.ts";
import { ManagedDaemonSupervision } from "../contexts/daemon/adapters/ManagedDaemonSupervision.ts";
import { hostPaths } from "../contexts/daemon/services/hostPaths.ts";

export const runDaemon = async (): Promise<void> => {
  const installationRoot = process.env.KOJO_MANAGED_INSTALLATION;
  const dataRoot = process.env.KOJO_DAEMON_DATA;
  const runtimeRoot = process.env.KOJO_DAEMON_RUNTIME;
  const configurationRoot = process.env.KOJO_DAEMON_CONFIG;
  const cacheRoot = process.env.KOJO_DAEMON_CACHE;
  const paths = hostPaths(
    installationRoot !== undefined && dataRoot !== undefined && runtimeRoot !== undefined
      ? {
          installationRoot,
          dataRoot,
          runtimeRoot,
          ...(configurationRoot === undefined ? {} : { configurationRoot }),
          ...(cacheRoot === undefined ? {} : { cacheRoot }),
          managedCli: join(installationRoot, "bin", "kojo"),
          managedLauncher: join(installationRoot, "bin", "kojo-launcher"),
        }
      : {},
  );
  const managedAttemptId = process.env.KOJO_DAEMON_ATTEMPT_ID;
  const purgeRecoveryOperation = process.env.KOJO_PURGE_SAFETY_RECOVERY_OPERATION;
  if (purgeRecoveryOperation !== undefined) {
    await recoverPurgeSafety(paths, purgeRecoveryOperation);
    return;
  }
  const supervision =
    managedAttemptId === undefined ? undefined : new ManagedDaemonSupervision(paths.dataRoot);
  const daemon = startDaemon(paths, {
    ...(supervision === undefined || managedAttemptId === undefined
      ? {}
      : {
          managedSupervision: {
            recordReady: (policy) => {
              supervision.recordReady(managedAttemptId);
              supervision.activatePolicy(managedAttemptId, policy);
            },
            recordPlannedStop: () => supervision.recordPlannedStop(managedAttemptId),
            activatePolicy: (policy) => supervision.activatePolicy(managedAttemptId, policy),
          },
        }),
  });

  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    void Effect.runPromise(daemon.stop);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  try {
    await Effect.runPromise(daemon.ready);
  } catch (cause) {
    await Effect.runPromise(daemon.stop);
    throw cause;
  }
  await Effect.runPromise(daemon.stopped);
};

if (import.meta.main) await runDaemon();
