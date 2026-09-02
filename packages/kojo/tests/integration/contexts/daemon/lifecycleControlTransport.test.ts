import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { FileLifecycleJournalRepository } from "../../../../src/contexts/daemon/adapters/FileLifecycleJournalRepository.ts";
import {
  SocketDaemonLifecycleControl,
  SocketDaemonUpgradeControl,
  startLifecycleControlServer,
} from "../../../../src/contexts/daemon/adapters/LifecycleControlTransport.ts";
import type { DaemonLifecycleControl } from "../../../../src/contexts/daemon/ports/DaemonLifecycleControl.ts";
import type { DaemonUpgradeControl } from "../../../../src/contexts/daemon/ports/DaemonUpgradeControl.ts";

const roots: Array<string> = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const fixture = () => {
  const root = mkdtempSync("/tmp/kojo-lc-");
  roots.push(root);
  const runtimeRoot = join(root, "runtime");
  mkdirSync(runtimeRoot, { mode: 0o700 });
  const journal = new FileLifecycleJournalRepository(join(root, "journal"));
  const operation = journal.begin({
    operationId: "operation-1",
    dataIdentity: "data-1",
    originalRequestHash: "a".repeat(64),
    kind: "restart",
    sourceReleaseId: "kojo-0.1.0-bun-1.4.0",
    startedAt: "2026-09-01T10:00:00.000Z",
  });
  return { runtimeRoot, journal, operation };
};

const control = (
  daemonInstanceId: string,
  cleanupCalls: Array<number>,
): DaemonLifecycleControl => ({
  inspectPreflight: () =>
    Effect.succeed({
      daemonInstanceId,
      runnerInstanceIds: [],
      recordedAt: "2026-09-01T10:00:00.000Z",
    }),
  beginDrain: () =>
    Effect.succeed({
      held: true,
      executingRunIds: ["run-1"],
      observedAt: "2026-09-01T10:00:01.000Z",
    }),
  readDrain: () =>
    Effect.succeed({
      held: true,
      executingRunIds: ["run-1"],
      observedAt: "2026-09-01T10:00:01.000Z",
    }),
  prepareHandoff: () =>
    Effect.succeed({
      digest: "b".repeat(64),
      owner: {
        daemonInstanceId,
        runnerInstanceIds: [],
        recordedAt: "2026-09-01T10:00:00.000Z",
      },
    }),
  confirmControllerReady: () => Effect.void,
  stopOwnedProcesses: (_operationId, cleanupMillis) => {
    cleanupCalls.push(cleanupMillis);
    return Effect.succeed({
      daemonInstanceId,
      runnerInstanceIds: [],
      recordedAt: "2026-09-01T10:00:00.000Z",
    });
  },
  confirmReplacementReady: () =>
    Effect.succeed({
      daemonInstanceId,
      runnerInstanceIds: [],
      recordedAt: "2026-09-01T10:00:00.000Z",
    }),
});

const upgradeControl = (activationCalls: Array<string>): DaemonUpgradeControl => ({
  inspectPreflight: () =>
    Effect.succeed({
      daemonInstanceId: "daemon-old",
      runnerInstanceIds: [],
      recordedAt: "2026-09-01T10:00:00.000Z",
    }),
  beginDrain: () =>
    Effect.succeed({
      held: true,
      executingRunIds: [],
      observedAt: "2026-09-01T10:00:01.000Z",
    }),
  readDrain: () =>
    Effect.succeed({
      held: true,
      executingRunIds: [],
      observedAt: "2026-09-01T10:00:01.000Z",
    }),
  forceDrain: (_operationId, _cleanupMillis, forceAuthorizationId) => {
    activationCalls.push(`force:${forceAuthorizationId}`);
    return Effect.succeed({
      held: true,
      executingRunIds: [],
      observedAt: "2026-09-01T10:00:01.000Z",
    });
  },
  holdMutations: () => Effect.void,
  repeatFinalPreflight: () =>
    Effect.succeed({
      outcome: "accepted",
      retainedSetHash: "c".repeat(64),
      owner: {
        daemonInstanceId: "daemon-old",
        runnerInstanceIds: [],
        recordedAt: "2026-09-01T10:00:00.000Z",
      },
      detail: "compatible",
    }),
  releaseUpgradeHolds: () => Effect.void,
  prepareHandoff: () =>
    Effect.succeed({
      digest: "d".repeat(64),
      owner: {
        daemonInstanceId: "daemon-old",
        runnerInstanceIds: [],
        recordedAt: "2026-09-01T10:00:00.000Z",
      },
    }),
  confirmControllerReady: () => Effect.void,
  createVerifiedBackup: () =>
    Effect.succeed({
      backupId: "upgrade-operation",
      sha256: "e".repeat(64),
      dataVersion: "f".repeat(64),
      verifiedAt: "2026-09-01T10:00:02.000Z",
    }),
  stopOwnedProcesses: () =>
    Effect.succeed({
      daemonInstanceId: "daemon-old",
      runnerInstanceIds: [],
      recordedAt: "2026-09-01T10:00:00.000Z",
    }),
  readCandidateReadiness: () =>
    Effect.succeed({
      daemonInstanceId: "daemon-new",
      dataIdentity: "data-1",
      sourceReleaseId: "source-release",
      candidateReleaseId: "candidate-release",
      receiptDigest: "1".repeat(64),
      wakeupDigest: "2".repeat(64),
      integrity: "ok",
      transports: "ready",
      workflowExecutions: 0,
      checkedAt: "2026-09-01T10:00:03.000Z",
    }),
  authorizeActivation: () => {
    activationCalls.push("activate");
    return Effect.succeed({
      daemonInstanceId: "daemon-new",
      runnerInstanceIds: [],
      recordedAt: "2026-09-01T10:00:03.000Z",
    });
  },
  inspectRollbackSafety: () =>
    Effect.succeed({
      safe: true,
      sourceReleaseId: "source-release",
      dataVersion: "f".repeat(64),
      executionStopped: true,
      detail: "safe",
    }),
  readRollbackReadiness: () =>
    Effect.succeed({
      daemonInstanceId: "daemon-rollback",
      dataIdentity: "data-1",
      sourceReleaseId: "source-release",
      candidateReleaseId: "source-release",
      receiptDigest: "3".repeat(64),
      wakeupDigest: "2".repeat(64),
      integrity: "ok",
      transports: "ready",
      workflowExecutions: 0,
      checkedAt: "2026-09-01T10:00:04.000Z",
    }),
  authorizeRollback: () =>
    Effect.succeed({
      daemonInstanceId: "daemon-rollback",
      runnerInstanceIds: [],
      recordedAt: "2026-09-01T10:00:04.000Z",
    }),
});

describe("the private lifecycle control transport", () => {
  it("carries exact managed upgrade evidence on the authenticated lifecycle socket", async () => {
    const root = mkdtempSync("/tmp/kojo-upgrade-lc-");
    roots.push(root);
    const runtimeRoot = join(root, "runtime");
    mkdirSync(runtimeRoot, { mode: 0o700 });
    const journal = new FileLifecycleJournalRepository(join(root, "journal"));
    const upgradeOperation = journal.begin({
      operationId: "upgrade-operation",
      dataIdentity: "data-1",
      originalRequestHash: "b".repeat(64),
      kind: "upgrade",
      sourceReleaseId: "source-release",
      candidateReleaseId: "candidate-release",
      checkedRetainedSetHash: "c".repeat(64),
      startedAt: "2026-09-01T10:00:00.000Z",
    });
    const socketPath = join(runtimeRoot, "lifecycle-control.sock");
    const activationCalls: Array<string> = [];
    const server = startLifecycleControlServer({
      socketPath,
      journal,
      control: control("daemon-old", []),
      upgradeControl: upgradeControl(activationCalls),
    });
    try {
      const client = new SocketDaemonUpgradeControl(runtimeRoot, journal);
      expect(
        (
          await Effect.runPromise(
            client.inspectPreflight(
              upgradeOperation.operationId,
              "data-1",
              "b".repeat(64),
              "source-release",
              "candidate-release",
              "c".repeat(64),
            ),
          )
        ).daemonInstanceId,
      ).toBe("daemon-old");
      const draining = journal.advance({
        operationId: upgradeOperation.operationId,
        expectedRevision: upgradeOperation.stageRevision,
        stage: "draining",
        updatedAt: "2026-09-01T10:00:01.000Z",
      });
      journal.authorizeForce({
        formatVersion: 1,
        authorizationId: "force-upgrade",
        pendingOperationId: draining.operationId,
        requestHash: "f".repeat(64),
        authorizedAt: "2026-09-01T10:00:02.000Z",
      });
      await expect(
        Effect.runPromise(client.forceDrain(upgradeOperation.operationId, 30_000, "wrong-force")),
      ).rejects.toThrow(/force authorization is not valid/);
      expect(
        (
          await Effect.runPromise(
            client.forceDrain(upgradeOperation.operationId, 30_000, "force-upgrade"),
          )
        ).executingRunIds,
      ).toEqual([]);
      const candidate = await Effect.runPromise(
        client.readCandidateReadiness(upgradeOperation.operationId, "daemon-old"),
      );
      expect(candidate).toMatchObject({
        daemonInstanceId: "daemon-new",
        integrity: "ok",
        transports: "ready",
        workflowExecutions: 0,
      });
      await Effect.runPromise(client.authorizeActivation(upgradeOperation.operationId, candidate));
      expect(activationCalls).toEqual(["force:force-upgrade", "activate"]);
    } finally {
      server.stop();
    }
  });

  it("reconnects one operation after endpoint loss and observes the replacement owner", async () => {
    const test = fixture();
    const socketPath = join(test.runtimeRoot, "lifecycle-control.sock");
    const cleanupCalls: Array<number> = [];
    const first = startLifecycleControlServer({
      socketPath,
      journal: test.journal,
      control: control("daemon-old", cleanupCalls),
    });
    const client = new SocketDaemonLifecycleControl(test.runtimeRoot, test.journal);

    expect(
      (
        await Effect.runPromise(
          client.inspectPreflight(
            test.operation.operationId,
            test.operation.dataIdentity,
            test.operation.originalRequestHash,
          ),
        )
      ).daemonInstanceId,
    ).toBe("daemon-old");
    expect(
      (
        await Effect.runPromise(
          client.beginDrain(test.operation.operationId, "data-1", "a".repeat(64)),
        )
      ).held,
    ).toBe(true);

    first.stop();
    expect(existsSync(socketPath)).toBe(false);
    await expect(Effect.runPromise(client.readDrain(test.operation.operationId))).rejects.toThrow();

    const replacement = startLifecycleControlServer({
      socketPath,
      journal: test.journal,
      control: control("daemon-new", cleanupCalls),
    });
    try {
      expect((await Effect.runPromise(client.readDrain(test.operation.operationId))).held).toBe(
        true,
      );
      expect(
        (
          await Effect.runPromise(
            client.confirmReplacementReady(test.operation.operationId, "daemon-old"),
          )
        ).daemonInstanceId,
      ).toBe("daemon-new");
    } finally {
      replacement.stop();
    }
  });

  it("rejects malformed action fields before cleanup reaches the Daemon", async () => {
    const test = fixture();
    const socketPath = join(test.runtimeRoot, "lifecycle-control.sock");
    const cleanupCalls: Array<number> = [];
    const preflightCalls: Array<string> = [];
    const daemonControl = control("daemon-old", cleanupCalls);
    const server = startLifecycleControlServer({
      socketPath,
      journal: test.journal,
      control: {
        ...daemonControl,
        inspectPreflight: (operationId, dataIdentity, requestHash) => {
          preflightCalls.push(operationId);
          return daemonControl.inspectPreflight(operationId, dataIdentity, requestHash);
        },
      },
    });
    try {
      const response = await fetch("http://localhost/control", {
        unix: socketPath,
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          formatVersion: 1,
          operationId: test.operation.operationId,
          controlSecret: test.journal.controlSecret(test.operation.operationId),
          action: "stop-owned-processes",
          cleanupMillis: "30000",
          replacementExpected: false,
        }),
      });

      expect(response.status).toBe(409);
      expect(cleanupCalls).toEqual([]);

      const wrongSecret = await fetch("http://localhost/control", {
        unix: socketPath,
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          formatVersion: 1,
          operationId: test.operation.operationId,
          controlSecret: "c".repeat(64),
          action: "inspect-preflight",
          dataIdentity: test.operation.dataIdentity,
          requestHash: test.operation.originalRequestHash,
        }),
      });
      expect(wrongSecret.status).toBe(409);
      expect(preflightCalls).toEqual([]);
    } finally {
      server.stop();
    }
  });

  it("rejects an invalid typed response instead of trusting endpoint bytes", async () => {
    const test = fixture();
    const socketPath = join(test.runtimeRoot, "lifecycle-control.sock");
    const daemonControl = control("daemon-old", []);
    const server = startLifecycleControlServer({
      socketPath,
      journal: test.journal,
      control: {
        ...daemonControl,
        inspectPreflight: () =>
          Effect.succeed({
            daemonInstanceId: "not a valid instance",
            runnerInstanceIds: [],
            recordedAt: "2026-09-01T10:00:00.000Z",
          }),
      },
    });
    try {
      const client = new SocketDaemonLifecycleControl(test.runtimeRoot, test.journal);
      await expect(
        Effect.runPromise(
          client.inspectPreflight(
            test.operation.operationId,
            test.operation.dataIdentity,
            test.operation.originalRequestHash,
          ),
        ),
      ).rejects.toThrow(/owner response is invalid/);
    } finally {
      server.stop();
    }
  });
});
