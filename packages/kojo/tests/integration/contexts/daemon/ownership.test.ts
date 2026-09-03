import { Database } from "bun:sqlite";
import { execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
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

  it("executes and replays exact Daemon and Project configuration owners through the private socket", async () => {
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
      const appliedReplay = await request("/api/v1/client-requests/configure-limits/retry", {
        method: "POST",
      });
      expect((await appliedReplay.json()) as { readonly result: unknown }).toMatchObject({
        result,
      });
      const changedDaemon = await request("/api/v1/client-requests/configure-limits", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mutationVersion: 1,
          requestId: "configure-limits",
          dataIdentity: daemon.endpoint.dataIdentity,
          operation: "configureDaemon",
          target: {
            identityVersion: 1,
            kind: "daemonData",
            parts: [daemon.endpoint.dataIdentity],
          },
          arguments: { patch: { set: { limits: { executingRuns: 3 } } } },
          preconditions: {},
        }),
      });
      expect(changedDaemon.status).toBe(409);

      const location = join(roots[0] ?? "", "configured-project");
      mkdirSync(location, { recursive: true });
      execFileSync("git", ["-C", location, "init", "--quiet"]);
      const projectLocation = realpathSync(location);
      const register = {
        mutationVersion: 1 as const,
        requestId: "configure-project-registration",
        dataIdentity: daemon.endpoint.dataIdentity,
        operation: "registerProject",
        target: {
          identityVersion: 1 as const,
          kind: "daemonData",
          parts: [daemon.endpoint.dataIdentity],
        },
        arguments: { location: projectLocation },
        preconditions: {},
      };
      await request(`/api/v1/client-requests/${register.requestId}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(register),
      });
      const registeredResponse = await request(
        `/api/v1/client-requests/${register.requestId}/retry`,
        { method: "POST" },
      );
      expect(registeredResponse.status, await registeredResponse.clone().text()).toBe(200);
      const registered = (await registeredResponse.json()) as {
        readonly result: { readonly project: { readonly projectId: string } };
      };
      const projectId = registered.result.project.projectId;
      const projectConfiguration = {
        mutationVersion: 1 as const,
        requestId: "configure-project-owner",
        dataIdentity: daemon.endpoint.dataIdentity,
        operation: "configureProject",
        target: { identityVersion: 1 as const, kind: "project", parts: [projectId] },
        arguments: { patch: { set: { limits: { executingRuns: 1 } } } },
        preconditions: {},
      };
      const configuredProject = await sendPreparedMutation(
        daemon,
        `/api/v1/projects/${projectId}/actions/configure`,
        projectConfiguration,
      );
      expect(configuredProject.status).toBe(202);
      const configuredProjectBody = await configuredProject.json();
      const projectReplay = (await (
        await request(`/api/v1/client-requests/${projectConfiguration.requestId}/retry`, {
          method: "POST",
        })
      ).json()) as { readonly result: unknown };
      expect(projectReplay).toMatchObject({ result: configuredProjectBody });
      expect(
        (
          await request(`/api/v1/client-requests/${projectConfiguration.requestId}`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              ...projectConfiguration,
              arguments: { patch: { set: { limits: { executingRuns: 2 } } } },
            }),
          })
        ).status,
      ).toBe(409);

      const ownerDatabase = new Database(join(hostPaths.dataRoot, "kojo.db"), { strict: true });
      ownerDatabase.run(
        "INSERT INTO workflow_revisions VALUES (?, ?, ?, '/retained/configuration', ?)",
        ["a".repeat(64), "b".repeat(64), "{}", "2020-01-01T00:00:00.000Z"],
      );
      ownerDatabase.run(
        "INSERT INTO project_workflows VALUES (?, 'retention', 'inactive', 'available', 'workflows/retention.ts', NULL, NULL, ?, NULL, 'not-declared', NULL, NULL, ?)",
        [projectId, "a".repeat(64), "2020-01-01T00:00:00.000Z"],
      );
      ownerDatabase.run(
        `INSERT INTO workflow_runs
           (run_id, project_id, workflow_name, idempotency_key, payload_json,
            revision_id, package_graph_id, state, admission_sequence, admitted_at,
            started_at, finished_at)
         VALUES ('retention-owner-run', ?, 'retention', 'retention-owner-run', 'null', ?, ?,
                 'succeeded', 1, ?, ?, ?)`,
        [
          projectId,
          "a".repeat(64),
          "b".repeat(64),
          "2020-01-01T00:00:00.000Z",
          "2020-01-01T00:00:01.000Z",
          "2020-01-01T00:00:02.000Z",
        ],
      );
      ownerDatabase.close(false);

      const checkedConfiguration = {
        mutationVersion: 1 as const,
        requestId: "configure-retention-check",
        dataIdentity: daemon.endpoint.dataIdentity,
        operation: "configureDaemon",
        target: {
          identityVersion: 1 as const,
          kind: "daemonData",
          parts: [daemon.endpoint.dataIdentity],
        },
        arguments: { patch: { set: { retention: { runHistoryMs: 1 } } }, check: true },
        preconditions: {},
      };
      const checkedResponse = await sendPreparedMutation(
        daemon,
        "/api/v1/daemon/actions/configure",
        checkedConfiguration,
      );
      const checkedBody = (await checkedResponse.json()) as {
        readonly plan?: { readonly planId: string };
      };
      const planId = checkedBody.plan?.planId;
      expect(planId).toBeDefined();
      const confirmation = {
        mutationVersion: 1 as const,
        requestId: "confirm-retention-plan",
        dataIdentity: daemon.endpoint.dataIdentity,
        operation: "confirmDaemonConfiguration",
        target: {
          identityVersion: 1 as const,
          kind: "daemonData",
          parts: [daemon.endpoint.dataIdentity],
        },
        arguments: { confirm: planId ?? "missing" },
        preconditions: {},
      };
      const confirmed = await sendPreparedMutation(
        daemon,
        "/api/v1/daemon/actions/configure",
        confirmation,
      );
      expect(confirmed.status, await confirmed.clone().text()).toBe(202);
      const confirmedBody = await confirmed.json();
      const confirmationReplay = (await (
        await request(`/api/v1/client-requests/${confirmation.requestId}/retry`, {
          method: "POST",
        })
      ).json()) as { readonly result: unknown };
      expect(confirmationReplay).toMatchObject({ result: confirmedBody });
      expect(
        (
          await request(`/api/v1/client-requests/${confirmation.requestId}`, {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              ...confirmation,
              arguments: { confirm: "replacement-plan" },
            }),
          })
        ).status,
      ).toBe(409);
    } finally {
      await Effect.runPromise(daemon.stop);
    }
  });
});
