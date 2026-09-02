import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { startDaemon } from "../../../../src/contexts/daemon/adapters/DaemonOwner.ts";
import { FileLifecycleJournalRepository } from "../../../../src/contexts/daemon/adapters/FileLifecycleJournalRepository.ts";
import { SocketDaemonLifecycleControl } from "../../../../src/contexts/daemon/adapters/LifecycleControlTransport.ts";
import { daemonConfigurationDefaults } from "../../../../src/contexts/daemon/models/Configuration.ts";
import type { DaemonPaths } from "../../../../src/contexts/daemon/models/DaemonPaths.ts";
import { LifecycleError } from "../../../../src/contexts/daemon/models/LifecycleError.ts";
import { publishConsoleRelease } from "../../../support/daemon/consoleRelease.ts";
import { sendPreparedMutation } from "../../../support/daemon/preparedMutation.ts";

const roots: Array<string> = [];

const paths = (): DaemonPaths => {
  const root = mkdtempSync(join(tmpdir(), "kojo-daemon-owner-"));
  roots.push(root);
  const installationRoot = join(root, "installation");
  const hostPaths = {
    installationRoot,
    dataRoot: join(root, "data"),
    configurationRoot: join(root, "config"),
    cacheRoot: join(root, "cache"),
    runtimeRoot: join(root, "runtime"),
    serviceDefinition: join(root, "LaunchAgents", "dev.kojo.test.plist"),
    managedCli: join(installationRoot, "bin", "kojo"),
    managedLauncher: join(installationRoot, "bin", "kojo-launcher"),
  };
  publishConsoleRelease(hostPaths);
  return hostPaths;
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("one idle Daemon owns one data root", () => {
  it("holds SQLite, the singleton, the Unix socket, and endpoint publication together", async () => {
    const hostPaths = paths();
    const daemon = startDaemon(hostPaths);

    try {
      expect(() => startDaemon(hostPaths)).toThrowError(LifecycleError);
      const response = await fetch("http://localhost/ready", {
        unix: daemon.endpoint.socketPath,
      });
      expect(await response.json()).toEqual(daemon.endpoint);
      expect(lstatSync(join(hostPaths.dataRoot, "kojo.db")).mode & 0o077).toBe(0);
      expect(lstatSync(join(hostPaths.runtimeRoot, "daemon.sock")).mode & 0o077).toBe(0);
      expect(lstatSync(join(hostPaths.runtimeRoot, "lifecycle-control.sock")).mode & 0o077).toBe(0);
      expect(lstatSync(join(hostPaths.runtimeRoot, "endpoint.json")).mode & 0o077).toBe(0);
      expect(
        JSON.parse(readFileSync(join(hostPaths.runtimeRoot, "endpoint.json"), "utf8")),
      ).toEqual(daemon.endpoint);
    } finally {
      await Effect.runPromise(daemon.stop);
    }
  });

  it("refuses a symbolic-link endpoint and leaves its target unchanged", () => {
    const hostPaths = paths();
    const target = join(hostPaths.runtimeRoot, "..", "outside");
    writeFileSync(target, "evidence");
    mkdirSync(hostPaths.runtimeRoot, { mode: 0o700 });
    symlinkSync(target, join(hostPaths.runtimeRoot, "endpoint.json"));

    expect(() => startDaemon(hostPaths)).toThrow("symbolic link");
    expect(readFileSync(target, "utf8")).toBe("evidence");
  });

  it("does not record actual readiness when required startup recovery fails", async () => {
    const hostPaths = paths();
    let recordedReady = 0;
    const daemon = startDaemon(hostPaths, {
      runRestore: () =>
        Effect.fail(
          new LifecycleError("DAEMON_RESTORE_TEST_FAILED", "retained Run recovery failed"),
        ),
      managedSupervision: {
        recordReady: () => {
          recordedReady += 1;
        },
        recordOperationSuccess: () => undefined,
        recordPlannedStop: () => undefined,
        activatePolicy: () => undefined,
      },
    });

    try {
      expect(
        await fetch("http://localhost/ready", { unix: daemon.endpoint.socketPath }),
      ).toMatchObject({ status: 200 });
      await expect(Effect.runPromise(daemon.ready)).rejects.toThrow("retained Run recovery failed");
      expect(recordedReady).toBe(0);
    } finally {
      await Effect.runPromise(daemon.stop);
    }
  });

  it("records actual readiness with only the managed restart policy", async () => {
    const hostPaths = paths();
    const policies: Array<unknown> = [];
    let successfulOperations = 0;
    const daemon = startDaemon(hostPaths, {
      managedSupervision: {
        recordReady: (policy) => policies.push(policy),
        recordOperationSuccess: () => {
          successfulOperations += 1;
        },
        recordPlannedStop: () => undefined,
        activatePolicy: () => undefined,
      },
    });

    try {
      await Effect.runPromise(daemon.ready);
      expect(policies).toEqual([
        {
          restartDelaysMs: daemonConfigurationDefaults.daemon.restartDelaysMs,
          healthyResetMs: daemonConfigurationDefaults.daemon.healthyResetMs,
        },
      ]);
      expect(
        await fetch("http://localhost/ready", { unix: daemon.endpoint.socketPath }),
      ).toMatchObject({ status: 200 });
      expect(successfulOperations).toBe(0);
      expect(
        await fetch("http://localhost/api/v1/projects", {
          unix: daemon.endpoint.socketPath,
        }),
      ).toMatchObject({ status: 200 });
      expect(successfulOperations).toBe(1);
    } finally {
      await Effect.runPromise(daemon.stop);
    }
  });

  it("reconnects one lifecycle operation through the production socket and observes the replacement owner", async () => {
    const hostPaths = paths();
    let plannedStops = 0;
    const daemon = startDaemon(hostPaths, {
      managedSupervision: {
        recordReady: () => undefined,
        recordOperationSuccess: () => undefined,
        recordPlannedStop: () => {
          plannedStops += 1;
        },
        activatePolicy: () => undefined,
      },
    });
    const journal = new FileLifecycleJournalRepository(join(hostPaths.dataRoot, "lifecycle"));
    const operation = journal.begin({
      operationId: "production-lifecycle-1",
      dataIdentity: daemon.endpoint.dataIdentity,
      originalRequestHash: "a".repeat(64),
      kind: "stop",
      sourceReleaseId: "kojo-0.1.0-bun-1.4.0",
      startedAt: "2026-09-01T10:00:00.000Z",
    });
    const control = new SocketDaemonLifecycleControl(hostPaths.runtimeRoot, journal);
    let replacement: ReturnType<typeof startDaemon> | undefined;

    try {
      const owner = await Effect.runPromise(
        control.inspectPreflight(
          operation.operationId,
          operation.dataIdentity,
          operation.originalRequestHash,
        ),
      );
      expect(owner.daemonInstanceId).toBe(daemon.endpoint.instanceId);
      expect(
        (
          await Effect.runPromise(
            control.beginDrain(
              operation.operationId,
              operation.dataIdentity,
              operation.originalRequestHash,
            ),
          )
        ).executingRunIds,
      ).toEqual([]);
      const handoff = await Effect.runPromise(control.prepareHandoff(operation.operationId));
      await Effect.runPromise(
        control.confirmControllerReady(operation.operationId, handoff.digest),
      );
      expect(
        (await Effect.runPromise(control.stopOwnedProcesses(operation.operationId, 30_000, true)))
          .daemonInstanceId,
      ).toBe(daemon.endpoint.instanceId);
      expect(plannedStops).toBe(1);
      await Effect.runPromise(daemon.stop);
      replacement = startDaemon(hostPaths);
      expect(
        (
          await Effect.runPromise(
            control.confirmReplacementReady(operation.operationId, daemon.endpoint.instanceId),
          )
        ).daemonInstanceId,
      ).toBe(replacement.endpoint.instanceId);
    } finally {
      if (replacement !== undefined) await Effect.runPromise(replacement.stop);
      await Effect.runPromise(daemon.stop);
    }
  });

  it("serves atomic configuration only through the private Daemon socket", async () => {
    const hostPaths = paths();
    const daemon = startDaemon(hostPaths);
    const request = (path: string, init: RequestInit = {}) =>
      fetch(`http://localhost${path}`, {
        ...init,
        unix: daemon.endpoint.socketPath,
      } as RequestInit & { readonly unix: string });

    try {
      const before = await request("/api/v1/daemon/configuration");
      expect(before.status).toBe(200);
      expect(await before.json()).toMatchObject({
        formatVersion: 1,
        scope: "daemon",
        restartRequired: false,
      });
      const invalid = await sendPreparedMutation(daemon, "/api/v1/daemon/actions/configure", {
        mutationVersion: 1,
        requestId: "configure-invalid",
        dataIdentity: daemon.endpoint.dataIdentity,
        operation: "configureDaemon",
        target: {
          identityVersion: 1,
          kind: "daemonData",
          parts: [daemon.endpoint.dataIdentity],
        },
        arguments: { patch: { set: { secret: "not-allowed" } } },
        preconditions: {},
      });
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toMatchObject({ code: "INVALID_CONFIGURATION_PATCH" });

      const applied = await sendPreparedMutation(daemon, "/api/v1/daemon/actions/configure", {
        mutationVersion: 1,
        requestId: "configure-limits",
        dataIdentity: daemon.endpoint.dataIdentity,
        operation: "configureDaemon",
        target: {
          identityVersion: 1,
          kind: "daemonData",
          parts: [daemon.endpoint.dataIdentity],
        },
        arguments: { patch: { set: { limits: { executingRuns: 2 } } } },
        preconditions: {},
      });
      expect(applied.status).toBe(202);
      const result = (await applied.json()) as {
        readonly status: {
          readonly fields: ReadonlyArray<{ readonly path: string; readonly effective: unknown }>;
        };
      };
      expect(
        result.status.fields.find((field) => field.path === "limits.executingRuns")?.effective,
      ).toBe(2);
    } finally {
      await Effect.runPromise(daemon.stop);
    }
  });
});
