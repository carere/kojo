import { Database } from "bun:sqlite";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { FileLifecycleJournalRepository } from "../../../../src/contexts/daemon/adapters/FileLifecycleJournalRepository.ts";
import { SqliteDaemonLifecycleReceiptRepository } from "../../../../src/contexts/daemon/adapters/SqliteDaemonLifecycleReceiptRepository.ts";
import { LifecycleError } from "../../../../src/contexts/daemon/models/LifecycleError.ts";
import { DaemonLifecycleApi } from "../../../../src/contexts/daemon/services/DaemonLifecycleApi.ts";
import type { RunApi } from "../../../../src/contexts/workflow/services/RunApi.ts";

const roots: Array<string> = [];
const start = (operationId = "operation-1") => ({
  operationId,
  dataIdentity: "data-1",
  originalRequestHash: "a".repeat(64),
  kind: "stop" as const,
  sourceReleaseId: "kojo-0.1.0-bun-1.4.0",
  startedAt: "2026-09-01T10:00:00.000Z",
});

const journal = () => {
  const root = mkdtempSync(join(tmpdir(), "kojo-lifecycle-journal-"));
  roots.push(root);
  return { root, repository: new FileLifecycleJournalRepository(root) };
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("the private lifecycle journal", () => {
  it("retains the global dispatch hold when the receipt repository is reconstructed", async () => {
    const test = journal();
    const databasePath = join(test.root, "receipts.db");
    const database = new Database(databasePath, { create: true, strict: true });
    const receipts = new SqliteDaemonLifecycleReceiptRepository(database);
    const owner = {
      daemonInstanceId: "daemon-1",
      runnerInstanceIds: ["runner-1"],
      recordedAt: "2026-09-01T10:00:00.000Z",
    };
    const prepared = await Effect.runPromise(
      receipts.prepare({
        operationId: "operation-1",
        dataIdentity: "data-1",
        requestHash: "a".repeat(64),
        owner,
      }),
    );
    await Effect.runPromise(
      receipts.advance({
        operationId: prepared.operationId,
        expectedRevision: prepared.revision,
        stage: "draining",
        owner,
        drainHeld: true,
      }),
    );
    expect(receipts.activeDrainHeld()).toBe(true);
    database.close(false);

    const replacementDatabase = new Database(databasePath, { strict: true });
    const replacement = new SqliteDaemonLifecycleReceiptRepository(replacementDatabase);
    expect(replacement.activeDrainHeld()).toBe(true);
    expect(await Effect.runPromise(replacement.read("operation-1"))).toMatchObject({
      stage: "draining",
      drainHeld: true,
    });
    replacementDatabase.close(false);
  });

  it("does not let a Daemon receipt skip the two-sided handoff", async () => {
    const database = new Database(":memory:", { strict: true });
    const receipts = new SqliteDaemonLifecycleReceiptRepository(database);
    const owner = {
      daemonInstanceId: "daemon-1",
      runnerInstanceIds: ["runner-1"],
      recordedAt: "2026-09-01T10:00:00.000Z",
    };
    const prepared = await Effect.runPromise(
      receipts.prepare({
        operationId: "operation-1",
        dataIdentity: "data-1",
        requestHash: "a".repeat(64),
        owner,
      }),
    );

    await expect(
      Effect.runPromise(
        receipts.advance({
          operationId: prepared.operationId,
          expectedRevision: prepared.revision,
          stage: "cleanup-started",
          owner,
          drainHeld: true,
        }),
      ),
    ).rejects.toThrow(/cannot skip required handoff stages/);
    database.close(false);
  });

  it("releases runtime dispatch when replacement-ready receipt replay follows a crash", async () => {
    const database = new Database(":memory:", { strict: true });
    const receipts = new SqliteDaemonLifecycleReceiptRepository(database);
    const oldOwner = {
      daemonInstanceId: "daemon-old",
      runnerInstanceIds: [],
      recordedAt: "2026-09-01T10:00:00.000Z",
    };
    const newOwner = { ...oldOwner, daemonInstanceId: "daemon-new" };
    let receipt = await Effect.runPromise(
      receipts.prepare({
        operationId: "operation-1",
        dataIdentity: "data-1",
        requestHash: "a".repeat(64),
        owner: oldOwner,
      }),
    );
    for (const stage of [
      "draining",
      "handoff-prepared",
      "controller-accepted",
      "cleanup-started",
      "process-stopped",
    ] as const) {
      receipt = await Effect.runPromise(
        receipts.advance({
          operationId: receipt.operationId,
          expectedRevision: receipt.revision,
          stage,
          owner: oldOwner,
          drainHeld: true,
          ...(stage === "handoff-prepared" ? { handoffDigest: "b".repeat(64) } : {}),
        }),
      );
    }
    await Effect.runPromise(
      receipts.advance({
        operationId: receipt.operationId,
        expectedRevision: receipt.revision,
        stage: "replacement-ready",
        owner: newOwner,
        drainHeld: false,
      }),
    );
    let releases = 0;
    const runs = {
      lifecycleOwner: () => newOwner,
      releaseDaemonDispatch: () => Effect.sync(() => releases++),
    } as unknown as RunApi;
    const api = new DaemonLifecycleApi({ dataIdentity: "data-1", runs, receipts });

    expect(
      (await Effect.runPromise(api.confirmReplacementReady("operation-1", "daemon-old")))
        .daemonInstanceId,
    ).toBe("daemon-new");
    expect(releases).toBe(1);
    database.close(false);
  });

  it("repairs a crash after the first operation revision but before the current pointer", () => {
    const test = journal();
    test.repository.begin(start());
    unlinkSync(join(test.root, "current-operation"));

    const replacement = new FileLifecycleJournalRepository(test.root);

    expect(replacement.current()?.operationId).toBe("operation-1");
    expect(() => replacement.begin(start("operation-2"))).toThrowError(
      /operation operation-1 is still prepared/,
    );
  });

  it("reads offline status without repairing or changing the lifecycle journal", () => {
    const test = journal();
    test.repository.begin(start());
    const pointer = join(test.root, "current-operation");
    unlinkSync(pointer);

    const inspection = new FileLifecycleJournalRepository(test.root, { readOnly: true });

    expect(inspection.current()?.operationId).toBe("operation-1");
    expect(() => inspection.begin(start("operation-2"))).toThrowError(/read-only/);
    expect(existsSync(pointer)).toBe(false);
  });

  it("does not let replay of an old completed identity hide the newer pending operation", () => {
    const test = journal();
    let old = test.repository.begin(start("old-operation"));
    old = test.repository.advance({
      operationId: old.operationId,
      expectedRevision: old.stageRevision,
      stage: "completed",
      updatedAt: "2026-09-01T10:00:01.000Z",
      changes: { outcome: "succeeded" },
    });
    test.repository.begin(start("pending-operation"));

    expect(test.repository.begin(start("old-operation"))).toEqual(old);
    expect(test.repository.current()?.operationId).toBe("pending-operation");
  });

  it("does not let a new operation bypass retained Repair-required evidence", () => {
    const test = journal();
    let operation = test.repository.begin(start());
    operation = test.repository.advance({
      operationId: operation.operationId,
      expectedRevision: operation.stageRevision,
      stage: "repair-required",
      updatedAt: "2026-09-01T10:00:01.000Z",
      changes: { outcome: "repair-required", detail: "Runner ownership is uncertain" },
    });

    expect(() => test.repository.begin(start("operation-2"))).toThrowError(
      /requires repair before new lifecycle work/,
    );
    expect(test.repository.current()).toEqual(operation);
  });

  it("reconciles an authorization write crash and rejects a second force identity", () => {
    const test = journal();
    let operation = test.repository.begin(start());
    operation = test.repository.advance({
      operationId: operation.operationId,
      expectedRevision: operation.stageRevision,
      stage: "draining",
      updatedAt: "2026-09-01T10:00:01.000Z",
      changes: {
        drain: {
          held: true,
          executingRunIds: ["run-1"],
          observedAt: "2026-09-01T10:00:01.000Z",
        },
      },
    });
    const authorization = {
      formatVersion: 1 as const,
      authorizationId: "force-1",
      pendingOperationId: operation.operationId,
      requestHash: "b".repeat(64),
      authorizedAt: "2026-09-01T10:00:02.000Z",
    };
    writeFileSync(
      join(test.root, "force-authorizations", "force-1.json"),
      `${JSON.stringify(authorization)}\n`,
      { mode: 0o600 },
    );
    chmodSync(join(test.root, "force-authorizations", "force-1.json"), 0o600);

    expect(test.repository.authorizeForce(authorization).forceAuthorizationId).toBe("force-1");
    expect(() =>
      test.repository.authorizeForce({
        ...authorization,
        authorizationId: "force-2",
      }),
    ).toThrowError(/already names force authorization force-1/);
  });

  it("replays the same force authorization after handoff without creating a new identity", () => {
    const test = journal();
    let operation = test.repository.begin(start());
    operation = test.repository.advance({
      operationId: operation.operationId,
      expectedRevision: operation.stageRevision,
      stage: "draining",
      updatedAt: "2026-09-01T10:00:01.000Z",
    });
    const authorization = {
      formatVersion: 1 as const,
      authorizationId: "force-1",
      pendingOperationId: operation.operationId,
      requestHash: "b".repeat(64),
      authorizedAt: "2026-09-01T10:00:02.000Z",
    };
    operation = test.repository.authorizeForce(authorization);
    operation = test.repository.advance({
      operationId: operation.operationId,
      expectedRevision: operation.stageRevision,
      stage: "handoff-prepared",
      updatedAt: "2026-09-01T10:00:03.000Z",
      changes: { handoffDigest: "c".repeat(64) },
    });

    expect(test.repository.authorizeForce(authorization)).toEqual(operation);
  });

  it("rejects ambiguous pending operation revisions instead of selecting one", () => {
    const test = journal();
    const first = test.repository.begin(start());
    const secondDirectory = join(test.root, "operations", "operation-2");
    mkdirSync(secondDirectory, { mode: 0o700 });
    writeFileSync(
      join(secondDirectory, "1.json"),
      `${JSON.stringify({ ...first, operationId: "operation-2" })}\n`,
      { mode: 0o600 },
    );

    expect(() => new FileLifecycleJournalRepository(test.root).current()).toThrowError(
      LifecycleError,
    );
  });
});
