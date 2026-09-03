import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileLifecycleJournalRepository } from "../../../../src/contexts/daemon/adapters/FileLifecycleJournalRepository.ts";
import { macLaunchAgent } from "../../../../src/contexts/daemon/adapters/MacLaunchAgent.ts";
import { ManagedDaemonSupervision } from "../../../../src/contexts/daemon/adapters/ManagedDaemonSupervision.ts";
import { systemdUserService } from "../../../../src/contexts/daemon/adapters/SystemdUserService.ts";
import type { DaemonPaths } from "../../../../src/contexts/daemon/models/DaemonPaths.ts";
import { launchAgentDocument } from "../../../../src/contexts/daemon/services/launchAgentDocument.ts";
import { systemdUnitDocument } from "../../../../src/contexts/daemon/services/systemdUnitDocument.ts";
import {
  type NativeHostChildProcess,
  nativeHostKillDiagnostic,
  nativeHostProcessCommand,
  selectManagedDaemonChild,
} from "../../../support/daemon/nativeHostProcess.ts";
import {
  NATIVE_HOST_TEST_TIMEOUT_MILLIS,
  NATIVE_HOST_TRANSITION_TIMEOUT_MILLIS,
} from "../../../support/daemon/nativeHostTiming.ts";
import { writeNativeManagedRelease } from "../../../support/daemon/nativeManagedRelease.ts";

// LaunchAgent bootout can retain the stopped job observation through its 30-second ExitTimeOut.
// Thirty seconds made the native evidence fail at that exact boundary while launchd was still completing the requested
// transition. This is an observation budget, not an extra stop or a fabricated state.
const waitFor = async (
  predicate: () => boolean,
  timeout = NATIVE_HOST_TRANSITION_TIMEOUT_MILLIS,
): Promise<void> => {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("native service did not reach the expected state");
    await Bun.sleep(50);
  }
};

class NativeHostStageError extends Error {
  readonly stage: string;
  readonly stageCause: unknown;

  constructor(stage: string, cause: unknown) {
    super(
      `native Host stage '${stage}' failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "NativeHostStageError";
    this.stage = stage;
    this.stageCause = cause;
  }
}

type NativeHostStage = <A>(stage: string, action: () => Promise<A>) => Promise<A>;

const nativeHostStage: NativeHostStage = async (stage, action) => {
  try {
    return await action();
  } catch (cause) {
    throw new NativeHostStageError(stage, cause);
  }
};

const childrenOf = (ownerProcessId: number): ReadonlyArray<NativeHostChildProcess> => {
  const children = Bun.spawnSync(["/usr/bin/pgrep", "-P", String(ownerProcessId)]);
  if (children.exitCode !== 0) return [];
  const found: Array<NativeHostChildProcess> = [];
  for (const line of children.stdout.toString().trim().split("\n")) {
    const processId = Number(line);
    if (!Number.isSafeInteger(processId)) continue;
    const command = Bun.spawnSync([...nativeHostProcessCommand(processId)]);
    found.push({ processId, command: command.stdout.toString().trim() });
  }
  return found;
};

const processIsAlive = (processId: number): boolean => {
  try {
    process.kill(processId, 0);
    return true;
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ESRCH") return false;
    throw cause;
  }
};

const exerciseNativeRestartBudget = async (
  paths: DaemonPaths,
  launcherProcessId: () => number | undefined,
  runStage: NativeHostStage,
): Promise<void> => {
  const supervision = () => new ManagedDaemonSupervision(paths.dataRoot);
  const runningAttempt = async (priorAttemptId?: string) => {
    let found: ReturnType<ManagedDaemonSupervision["status"]>["attempt"];
    await waitFor(() => {
      const attempt = supervision().status().attempt;
      if (
        attempt?.phase !== "running" ||
        attempt.readyAt === undefined ||
        attempt.attemptId === priorAttemptId
      ) {
        return false;
      }
      found = attempt;
      return true;
    });
    if (found === undefined) throw new Error("the supervised Daemon did not become ready");
    supervision().activatePolicy(found.attemptId, {
      restartDelaysMs: [1_000, 2_000, 4_000],
      healthyResetMs: 1,
    });
    return found;
  };
  const failAttempt = async (attemptId: string, expectedBudgetIndex: number): Promise<void> => {
    let ownerProcessId: number | undefined;
    let childrenBefore: ReadonlyArray<NativeHostChildProcess> = [];
    let selectedChild: NativeHostChildProcess | undefined;
    let killReceipt: boolean | undefined;
    let selectedChildLiveAfterKill: boolean | undefined;
    const supervisionBefore = supervision().status();
    try {
      await waitFor(() => {
        ownerProcessId = launcherProcessId();
        if (ownerProcessId === undefined) return false;
        childrenBefore = childrenOf(ownerProcessId);
        selectedChild = selectManagedDaemonChild(childrenBefore);
        return selectedChild !== undefined;
      });
      if (selectedChild === undefined) throw new Error("the managed Daemon child was not selected");
      const killedChild = selectedChild;
      killReceipt = process.kill(killedChild.processId, "SIGKILL");
      await waitFor(() => {
        selectedChildLiveAfterKill = processIsAlive(killedChild.processId);
        return !selectedChildLiveAfterKill;
      });
      await waitFor(() => {
        const status = supervision().status();
        const attempt = status.attempt;
        return (
          status.lastFailure?.attemptId === attemptId &&
          attempt?.phase === "waiting" &&
          attempt.budgetIndex === expectedBudgetIndex
        );
      });
    } catch (cause) {
      const supervisionAfter = supervision().status();
      const childrenAfter = ownerProcessId === undefined ? [] : childrenOf(ownerProcessId);
      throw new Error(
        [
          cause instanceof Error ? cause.message : String(cause),
          nativeHostKillDiagnostic({
            ownerProcessId,
            childrenBefore,
            selectedChild,
            killReceipt,
            selectedChildLiveAfterKill,
            supervisionBefore,
            supervisionAfter,
            childrenAfter,
          }),
        ].join("\n"),
      );
    }
  };

  const first = await runStage("restart-budget first Daemon ready", () => runningAttempt());
  await runStage("restart-budget heartbeat does not reset", async () => {
    const heartbeat = await fetch("http://localhost/ready", {
      unix: join(paths.runtimeRoot, "daemon.sock"),
    });
    expect(heartbeat.status).toBe(200);
    expect(supervision().status().attempt?.operationSucceededAt).toBeUndefined();
  });
  await runStage("restart-budget first failure enters one-second delay", async () => {
    await Bun.sleep(5);
    await failAttempt(first.attemptId, 0);
  });

  const second = await runStage("restart-budget second Daemon ready", () =>
    runningAttempt(first.attemptId),
  );
  await runStage("restart-budget second failure enters two-second delay", async () => {
    expect(second.budgetIndex).toBe(0);
    expect(second.operationSucceededAt).toBeUndefined();
    await Bun.sleep(5);
    await failAttempt(second.attemptId, 1);
  });

  const third = await runStage("restart-budget third Daemon ready", () =>
    runningAttempt(second.attemptId),
  );
  const preparedOperation = await runStage("restart-budget operation-success reset", async () => {
    expect(third.budgetIndex).toBe(1);
    const operation = await fetch("http://localhost/api/v1/projects", {
      unix: join(paths.runtimeRoot, "daemon.sock"),
    });
    expect(operation.status).toBe(200);
    await waitFor(() => supervision().status().attempt?.operationSucceededAt !== undefined);
    const lifecycle = new FileLifecycleJournalRepository(join(paths.dataRoot, "lifecycle"));
    const prepared = lifecycle.begin({
      operationId: "native-post-activation",
      dataIdentity: "native-host-data",
      originalRequestHash: "a".repeat(64),
      kind: "upgrade",
      sourceReleaseId: "source-release",
      candidateReleaseId: "candidate-release",
      checkedRetainedSetHash: "b".repeat(64),
      startedAt: "2026-09-02T10:00:00.000Z",
    });
    lifecycle.advance({
      operationId: prepared.operationId,
      expectedRevision: prepared.stageRevision,
      stage: "activated",
      updatedAt: "2026-09-02T10:01:00.000Z",
      changes: { outcome: "activated", detail: "native candidate activated" },
    });
    return prepared;
  });

  await runStage("restart-budget post-activation failure keeps lifecycle outcome", async () => {
    await Bun.sleep(5);
    await failAttempt(third.attemptId, 0);
    const lifecycle = new FileLifecycleJournalRepository(join(paths.dataRoot, "lifecycle"));
    expect(lifecycle.read(preparedOperation.operationId)).toMatchObject({
      stage: "activated",
      outcome: "activated",
    });
    expect(supervision().status().lastFailure).toBeDefined();
  });
  await runStage("restart-budget fourth Daemon ready", () => runningAttempt(third.attemptId));
};

describe.skipIf(process.platform !== "darwin")("the native macOS Daemon lifecycle", () => {
  it(
    "uses a native LaunchAgent for singleton lifecycle, complete stop, restart-budget reset, and post-activation failure isolation",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "kojo-native-service-"));
      const label = `dev.kojo.test.${crypto.randomUUID()}`;
      const installationRoot = join(root, "installation");
      const paths: DaemonPaths = {
        installationRoot,
        dataRoot: join(root, "data"),
        configurationRoot: join(root, "config"),
        cacheRoot: join(root, "cache"),
        runtimeRoot: join(root, "runtime"),
        serviceDefinition: join(root, `${label}.plist`),
        managedCli: join(installationRoot, "bin", "kojo"),
        managedLauncher: join(installationRoot, "bin", "kojo-launcher"),
      };
      const daemonMain = new URL("../../../../src/daemon/main.ts", import.meta.url).pathname;
      const launcherMain = new URL("../../../../src/launcher/main.ts", import.meta.url).pathname;
      writeNativeManagedRelease(paths, launcherMain);
      writeFileSync(paths.serviceDefinition, launchAgentDocument(paths, { label, home: root }), {
        mode: 0o600,
      });
      const service = macLaunchAgent({ label });

      try {
        service.installAndStart(paths.serviceDefinition);
        await waitFor(() => service.inspect().process === "running");
        await waitFor(() => existsSync(join(paths.runtimeRoot, "endpoint.json")));
        const launchctlTarget = `gui/${process.getuid?.() ?? 0}/${label}`;
        await exerciseNativeRestartBudget(
          paths,
          () => {
            const printed = Bun.spawnSync(["/bin/launchctl", "print", launchctlTarget]);
            const processId = /^\s*pid\s*=\s*(\d+)\s*$/m.exec(printed.stdout.toString())?.[1];
            return processId === undefined ? undefined : Number(processId);
          },
          nativeHostStage,
        );
        await waitFor(() => existsSync(join(paths.runtimeRoot, "endpoint.json")));

        const duplicate = Bun.spawnSync([process.execPath, daemonMain], {
          env: {
            ...process.env,
            KOJO_MANAGED_INSTALLATION: installationRoot,
            KOJO_DAEMON_DATA: paths.dataRoot,
            KOJO_DAEMON_RUNTIME: paths.runtimeRoot,
          },
        });
        expect(duplicate.exitCode).not.toBe(0);

        service.disable(false);
        expect(service.inspect()).toMatchObject({
          automaticStart: "disabled",
          manager: "loaded",
          process: "running",
        });
        service.disable(true);
        await waitFor(() => service.inspect().manager === "unloaded");
        service.start(paths.serviceDefinition);
        await waitFor(() => service.inspect().process === "running");
        expect(service.inspect().automaticStart).toBe("disabled");
        service.enable();
        service.stop();
        await waitFor(() => service.inspect().manager === "unloaded");
        expect(existsSync(join(paths.runtimeRoot, "endpoint.json"))).toBe(false);
      } finally {
        try {
          service.enable();
          service.stop();
        } catch {
          // The unique test service can already be absent. The private root is still removed below.
        }
        rmSync(root, { recursive: true, force: true });
      }
    },
    NATIVE_HOST_TEST_TIMEOUT_MILLIS,
  );
});

const processExists = (processId: number): boolean => {
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
};

const systemdFailure = (
  unit: string,
  stage: string,
  observation: unknown,
  cause: unknown,
): Error => {
  const output = (command: ReadonlyArray<string>): string => {
    const result = Bun.spawnSync([...command]);
    return [new TextDecoder().decode(result.stdout), new TextDecoder().decode(result.stderr)]
      .filter((part) => part.trim().length > 0)
      .join("\n");
  };
  return new Error(
    [
      `Stage: ${stage}`,
      cause instanceof Error ? cause.message : String(cause),
      `Observation: ${JSON.stringify(observation)}`,
      output([
        "/usr/bin/systemctl",
        "--user",
        "show",
        unit,
        "--property=LoadState,ActiveState,SubState,Result,ExecMainCode,ExecMainStatus",
        "--no-pager",
      ]),
      output(["/usr/bin/systemctl", "--user", "status", unit, "--full", "--no-pager"]),
      output(["/usr/bin/journalctl", "--user-unit", unit, "--no-pager", "--lines=100"]),
    ]
      .filter((part) => part.trim().length > 0)
      .join("\n\n"),
  );
};

const systemdUserManagerAvailable =
  process.platform === "linux" &&
  Bun.spawnSync(["/usr/bin/systemctl", "--user", "show-environment"]).exitCode === 0;

describe.skipIf(!systemdUserManagerAvailable)("the native systemd user Daemon lifecycle", () => {
  it(
    "uses a native systemd unit for singleton lifecycle, process-group stop, restart-budget reset, and post-activation failure isolation",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "kojo-native-systemd-service-"));
      const identity = `kojo-test-${crypto.randomUUID()}`;
      const unit = `${identity}.service`;
      const installationRoot = join(root, "installation");
      const unitDirectory = join(homedir(), ".config", "systemd", "user");
      const paths: DaemonPaths = {
        installationRoot,
        dataRoot: join(root, "state", "kojo"),
        configurationRoot: join(root, "config", "kojo"),
        cacheRoot: join(root, "cache", "kojo"),
        runtimeRoot: join(root, "runtime", "kojo"),
        serviceDefinition: join(unitDirectory, unit),
        managedCli: join(installationRoot, "bin", "kojo"),
        managedLauncher: join(installationRoot, "bin", "kojo-launcher"),
      };
      const childProcessIdPath = join(root, "child.pid");
      mkdirSync(unitDirectory, { recursive: true, mode: 0o700 });
      const daemonMain = new URL("../../../../src/daemon/main.ts", import.meta.url).pathname;
      const launcherMain = new URL("../../../../src/launcher/main.ts", import.meta.url).pathname;
      writeNativeManagedRelease(paths, launcherMain, { childProcessIdPath });
      writeFileSync(
        paths.serviceDefinition,
        systemdUnitDocument(paths, {
          home: root,
          managedDirectoryName: identity,
        }),
        { mode: 0o600 },
      );
      const service = systemdUserService({ unit });

      try {
        await nativeHostStage("systemd install and first Daemon ready", async () => {
          service.installAndStart(paths.serviceDefinition);
          await waitFor(() => service.inspect().process === "running");
        });
        await nativeHostStage("systemd endpoint and child process published", async () => {
          await waitFor(() => existsSync(join(paths.runtimeRoot, "endpoint.json")));
          await waitFor(() => existsSync(childProcessIdPath));
        });
        const childProcessId = Number(readFileSync(childProcessIdPath, "utf8").trim());
        await exerciseNativeRestartBudget(
          paths,
          () => {
            const shown = Bun.spawnSync([
              "/usr/bin/systemctl",
              "--user",
              "show",
              unit,
              "--property=MainPID",
              "--value",
            ]);
            const processId = Number(shown.stdout.toString().trim());
            return Number.isSafeInteger(processId) && processId > 0 ? processId : undefined;
          },
          nativeHostStage,
        );
        await nativeHostStage("systemd endpoint republished after restart budget", () =>
          waitFor(() => existsSync(join(paths.runtimeRoot, "endpoint.json"))),
        );

        await nativeHostStage("systemd duplicate Daemon refusal", async () => {
          const duplicate = Bun.spawnSync([process.execPath, daemonMain], {
            env: {
              ...process.env,
              KOJO_MANAGED_INSTALLATION: installationRoot,
              KOJO_DAEMON_DATA: paths.dataRoot,
              KOJO_DAEMON_RUNTIME: paths.runtimeRoot,
              KOJO_DAEMON_CONFIG: paths.configurationRoot,
              KOJO_DAEMON_CACHE: paths.cacheRoot,
            },
          });
          expect(duplicate.exitCode).not.toBe(0);
        });

        await nativeHostStage("systemd disable keeps the Daemon running", async () => {
          expect(service.inspect()).toMatchObject({
            automaticStart: "enabled",
            manager: "loaded",
            process: "running",
          });
          expect(["disabled", "enabled"]).toContain(service.inspect().logoutPersistence);
          service.disable(false);
          expect(service.inspect()).toMatchObject({
            automaticStart: "disabled",
            process: "running",
          });
        });
        await nativeHostStage("systemd stop removes child and endpoint", async () => {
          service.enable();
          service.stop();
          await waitFor(() => service.inspect().process === "stopped");
          await waitFor(() => !processExists(childProcessId));
          expect(existsSync(join(paths.runtimeRoot, "endpoint.json"))).toBe(false);
        });
      } catch (cause) {
        const staged =
          cause instanceof NativeHostStageError
            ? cause
            : new NativeHostStageError("systemd native scenario", cause);
        let observation: unknown;
        try {
          observation = service.inspect();
        } catch (inspectionCause) {
          observation = {
            inspectionFailure:
              inspectionCause instanceof Error ? inspectionCause.message : String(inspectionCause),
          };
        }
        throw systemdFailure(unit, staged.stage, observation, staged.stageCause);
      } finally {
        try {
          service.disable(true);
        } catch {
          // The unique test service can already be stopped. Cleanup continues below.
        }
        rmSync(paths.serviceDefinition, { force: true });
        Bun.spawnSync(["/usr/bin/systemctl", "--user", "daemon-reload"]);
        rmSync(root, { recursive: true, force: true });
      }
    },
    NATIVE_HOST_TEST_TIMEOUT_MILLIS,
  );
});
