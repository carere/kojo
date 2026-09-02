#!/usr/bin/env bun
import { ManagedDaemonSupervision } from "../contexts/daemon/adapters/ManagedDaemonSupervision.ts";
import { LifecycleError } from "../contexts/daemon/models/LifecycleError.ts";
import {
  listenForProcessStopSignals,
  waitForProcessStopSignal,
} from "../contexts/daemon/services/processStopSignals.ts";
import { runDaemon } from "../daemon/main.ts";

const childMode = process.env.KOJO_DAEMON_CHILD === "1";

const requireDataRoot = (): string => {
  const dataRoot = process.env.KOJO_DAEMON_DATA;
  if (dataRoot === undefined || dataRoot.length === 0) {
    throw new LifecycleError(
      "DAEMON_DATA_ROOT_MISSING",
      "the managed launcher has no Daemon data root",
    );
  }
  return dataRoot;
};

const supervise = async (): Promise<void> => {
  const supervision = new ManagedDaemonSupervision(requireDataRoot());
  const ownership = supervision.acquireLauncherOwnership();
  let stopping = false;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let currentAttemptId: string | undefined;
  let releaseStop: (() => void) | undefined;
  const stopped = new Promise<void>((resolve) => {
    releaseStop = resolve;
  });
  const stop = (signal: NodeJS.Signals): void => {
    if (stopping) return;
    stopping = true;
    if (currentAttemptId !== undefined) {
      if (child === undefined) {
        supervision.finishAttempt(currentAttemptId, {
          planned: true,
          detail: "the native manager stopped the launcher before the scheduled attempt",
        });
        currentAttemptId = undefined;
      } else supervision.recordPlannedStop(currentAttemptId);
    }
    child?.kill(signal);
    releaseStop?.();
  };
  const removeStopListeners = listenForProcessStopSignals(stop);

  try {
    while (!stopping) {
      const prepared = supervision.prepareAttempt();
      if (prepared.outcome === "exhausted") {
        await Promise.race([Bun.sleep(250), stopped]);
        continue;
      }
      currentAttemptId = prepared.attemptId;
      if (prepared.delayMs > 0) await Promise.race([Bun.sleep(prepared.delayMs), stopped]);
      if (stopping) break;
      supervision.startAttempt(prepared.attemptId);
      child = Bun.spawn([process.execPath, process.argv[1] ?? import.meta.path], {
        env: {
          ...process.env,
          KOJO_DAEMON_CHILD: "1",
          KOJO_DAEMON_ATTEMPT_ID: prepared.attemptId,
        },
        stdin: "ignore",
        stdout: "inherit",
        stderr: "inherit",
      });
      const exitCode = await child.exited;
      supervision.finishAttempt(prepared.attemptId, {
        planned: stopping,
        detail: `the managed Daemon process exited with code ${exitCode}`,
      });
      child = undefined;
      currentAttemptId = undefined;
    }
  } catch (cause) {
    console.error(
      `kojo: managed launcher supervision requires repair: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    await stopped;
  } finally {
    removeStopListeners();
    ownership.release();
  }
};

const holdUnsafeLauncher = async (cause: unknown): Promise<void> => {
  console.error(
    `kojo: managed launcher could not enter supervision safely: ${cause instanceof Error ? cause.message : String(cause)}`,
  );
  await waitForProcessStopSignal();
};

if (childMode) {
  await runDaemon();
  process.exit(0);
} else {
  try {
    await supervise();
  } catch (cause) {
    await holdUnsafeLauncher(cause);
  }
}
