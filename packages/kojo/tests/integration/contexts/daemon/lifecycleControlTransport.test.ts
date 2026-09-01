import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { FileLifecycleJournalRepository } from "../../../../src/contexts/daemon/adapters/FileLifecycleJournalRepository.ts";
import {
  SocketDaemonLifecycleControl,
  startLifecycleControlServer,
} from "../../../../src/contexts/daemon/adapters/LifecycleControlTransport.ts";
import type { DaemonLifecycleControl } from "../../../../src/contexts/daemon/ports/DaemonLifecycleControl.ts";

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

describe("the private lifecycle control transport", () => {
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
