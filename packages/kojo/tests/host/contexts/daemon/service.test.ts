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
import { writeNativeManagedRelease } from "../../../support/daemon/nativeManagedRelease.ts";

// LaunchAgent bootout can retain the stopped job observation through its 30-second ExitTimeOut.
// Thirty seconds made the native evidence fail at that exact boundary while launchd was still completing the requested
// transition. This is an observation budget, not an extra stop or a fabricated state.
const waitFor = async (predicate: () => boolean, timeout = 60_000): Promise<void> => {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("native service did not reach the expected state");
    await Bun.sleep(50);
  }
};

const childOf = (ownerProcessId: number): number | undefined => {
  const children = Bun.spawnSync(["/usr/bin/pgrep", "-P", String(ownerProcessId)]);
  if (children.exitCode !== 0) return undefined;
  for (const line of children.stdout.toString().trim().split("\n")) {
    const processId = Number(line);
    if (!Number.isSafeInteger(processId)) continue;
    const command = Bun.spawnSync(["/bin/ps", "-o", "command=", "-p", String(processId)]);
    if (command.stdout.toString().includes("launcher/main.ts")) return processId;
  }
  return undefined;
};

const exerciseNativeRestartBudget = async (
  paths: DaemonPaths,
  launcherProcessId: () => number | undefined,
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
    let daemonProcessId: number | undefined;
    await waitFor(() => {
      const launcher = launcherProcessId();
      if (launcher === undefined) return false;
      daemonProcessId = childOf(launcher);
      return daemonProcessId !== undefined;
    });
    process.kill(daemonProcessId as number, "SIGKILL");
    await waitFor(() => {
      const status = supervision().status();
      const attempt = status.attempt;
      return (
        status.lastFailure?.attemptId === attemptId &&
        attempt?.phase === "waiting" &&
        attempt.budgetIndex === expectedBudgetIndex
      );
    });
  };

  const first = await runningAttempt();
  const heartbeat = await fetch("http://localhost/ready", {
    unix: join(paths.runtimeRoot, "daemon.sock"),
  });
  expect(heartbeat.status).toBe(200);
  expect(supervision().status().attempt?.operationSucceededAt).toBeUndefined();
  await Bun.sleep(5);
  await failAttempt(first.attemptId, 0);

  const second = await runningAttempt(first.attemptId);
  expect(second.budgetIndex).toBe(0);
  expect(second.operationSucceededAt).toBeUndefined();
  await Bun.sleep(5);
  await failAttempt(second.attemptId, 1);

  const third = await runningAttempt(second.attemptId);
  expect(third.budgetIndex).toBe(1);
  const operation = await fetch("http://localhost/api/v1/projects", {
    unix: join(paths.runtimeRoot, "daemon.sock"),
  });
  expect(operation.status).toBe(200);
  await waitFor(() => supervision().status().attempt?.operationSucceededAt !== undefined);
  const lifecycle = new FileLifecycleJournalRepository(join(paths.dataRoot, "lifecycle"));
  const preparedOperation = lifecycle.begin({
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
    operationId: preparedOperation.operationId,
    expectedRevision: preparedOperation.stageRevision,
    stage: "activated",
    updatedAt: "2026-09-02T10:01:00.000Z",
    changes: { outcome: "activated", detail: "native candidate activated" },
  });
  await Bun.sleep(5);
  await failAttempt(third.attemptId, 0);
  expect(lifecycle.read(preparedOperation.operationId)).toMatchObject({
    stage: "activated",
    outcome: "activated",
  });
  expect(supervision().status().lastFailure).toBeDefined();
  await runningAttempt(third.attemptId);
};

describe.skipIf(process.platform !== "darwin")("the native macOS Daemon lifecycle", () => {
  it("uses a native LaunchAgent for singleton lifecycle, complete stop, restart-budget reset, and post-activation failure isolation", async () => {
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
      await exerciseNativeRestartBudget(paths, () => {
        const printed = Bun.spawnSync(["/bin/launchctl", "print", launchctlTarget]);
        const processId = /^\s*pid\s*=\s*(\d+)\s*$/m.exec(printed.stdout.toString())?.[1];
        return processId === undefined ? undefined : Number(processId);
      });
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
  });
});

const processExists = (processId: number): boolean => {
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
};

const systemdFailure = (unit: string, observation: unknown, cause: unknown): Error => {
  const output = (command: ReadonlyArray<string>): string => {
    const result = Bun.spawnSync([...command]);
    return [new TextDecoder().decode(result.stdout), new TextDecoder().decode(result.stderr)]
      .filter((part) => part.trim().length > 0)
      .join("\n");
  };
  return new Error(
    [
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
  it("uses a native systemd unit for singleton lifecycle, process-group stop, restart-budget reset, and post-activation failure isolation", async () => {
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
      service.installAndStart(paths.serviceDefinition);
      try {
        await waitFor(() => service.inspect().process === "running");
      } catch (cause) {
        throw systemdFailure(unit, service.inspect(), cause);
      }
      await waitFor(() => existsSync(join(paths.runtimeRoot, "endpoint.json")));
      await waitFor(() => existsSync(childProcessIdPath));
      const childProcessId = Number(readFileSync(childProcessIdPath, "utf8").trim());
      await exerciseNativeRestartBudget(paths, () => {
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
      });
      await waitFor(() => existsSync(join(paths.runtimeRoot, "endpoint.json")));

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
      service.enable();
      service.stop();
      await waitFor(() => service.inspect().process === "stopped");
      await waitFor(() => !processExists(childProcessId));
      expect(existsSync(join(paths.runtimeRoot, "endpoint.json"))).toBe(false);
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
  });
});
