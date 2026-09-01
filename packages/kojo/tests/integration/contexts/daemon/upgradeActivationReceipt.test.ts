import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { SqliteUpgradeActivationReceiptRepository } from "../../../../src/contexts/daemon/adapters/SqliteUpgradeActivationReceiptRepository.ts";
import type { UpgradeActivationReceiptStage } from "../../../../src/contexts/daemon/models/UpgradeActivationReceipt.ts";

describe("the SQLite upgrade activation receipt", () => {
  it("retains final refusal before it releases either Daemon hold", async () => {
    const root = mkdtempSync(join(tmpdir(), "kojo-upgrade-refusal-"));
    const database = new Database(join(root, "kojo.db"), { create: true, strict: true });
    try {
      const receipts = new SqliteUpgradeActivationReceiptRepository(database);
      let receipt = await Effect.runPromise(
        receipts.prepare({
          operationId: "upgrade-refusal-boundary",
          dataIdentity: "data-one",
          requestHash: "a".repeat(64),
          sourceReleaseId: "source-release",
          candidateReleaseId: "candidate-release",
          checkedRetainedSetHash: "b".repeat(64),
          owner: {
            daemonInstanceId: "daemon-source",
            runnerInstanceIds: [],
            recordedAt: "2026-09-01T10:00:00.000Z",
          },
        }),
      );
      receipt = await Effect.runPromise(
        receipts.advance({
          operationId: receipt.operationId,
          expectedRevision: receipt.revision,
          stage: "draining",
          changes: { dispatchHeld: true },
        }),
      );
      receipt = await Effect.runPromise(
        receipts.advance({
          operationId: receipt.operationId,
          expectedRevision: receipt.revision,
          stage: "mutations-held",
          changes: { mutationsHeld: true },
        }),
      );
      receipt = await Effect.runPromise(
        receipts.advance({
          operationId: receipt.operationId,
          expectedRevision: receipt.revision,
          stage: "final-preflight-refused",
          changes: {
            finalRetainedSetHash: "c".repeat(64),
            detail: "retained state became incompatible",
          },
        }),
      );
      expect(receipt).toMatchObject({
        stage: "final-preflight-refused",
        dispatchHeld: true,
        mutationsHeld: true,
      });

      const released = await Effect.runPromise(
        receipts.advance({
          operationId: receipt.operationId,
          expectedRevision: receipt.revision,
          stage: "upgrade-refused",
          changes: { dispatchHeld: false, mutationsHeld: false },
        }),
      );
      expect(await Effect.runPromise(receipts.active)).toBeUndefined();
      expect(
        await Effect.runPromise(
          receipts.advance({
            operationId: released.operationId,
            expectedRevision: receipt.revision,
            stage: "upgrade-refused",
          }),
        ),
      ).toEqual(released);
    } finally {
      database.close(false);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("commits the migration and its checkpoint in one transaction", async () => {
    const root = mkdtempSync(join(tmpdir(), "kojo-upgrade-receipt-"));
    const database = new Database(join(root, "kojo.db"), { create: true, strict: true });
    try {
      const receipts = new SqliteUpgradeActivationReceiptRepository(database);
      let receipt = await Effect.runPromise(
        receipts.prepare({
          operationId: "upgrade-migration-boundary",
          dataIdentity: "data-one",
          requestHash: "a".repeat(64),
          sourceReleaseId: "source-release",
          candidateReleaseId: "candidate-release",
          checkedRetainedSetHash: "b".repeat(64),
          owner: {
            daemonInstanceId: "daemon-source",
            runnerInstanceIds: [],
            recordedAt: "2026-09-01T10:00:00.000Z",
          },
        }),
      );
      const stages: ReadonlyArray<UpgradeActivationReceiptStage> = [
        "draining",
        "mutations-held",
        "final-preflight-accepted",
        "handoff-prepared",
        "controller-accepted",
        "backup-verified",
        "source-execution-stopped",
      ];
      for (const stage of stages) {
        receipt = await Effect.runPromise(
          receipts.advance({
            operationId: receipt.operationId,
            expectedRevision: receipt.revision,
            stage,
          }),
        );
      }
      const revisionBeforeMigration = receipt.revision;

      await expect(
        Effect.runPromise(
          receipts.checkpointMigration(
            { operationId: receipt.operationId, expectedRevision: receipt.revision },
            () => {
              database.run("CREATE TABLE interrupted_migration (value TEXT NOT NULL)");
              throw new Error("simulated interruption before checkpoint publication");
            },
          ),
        ),
      ).rejects.toThrow(/simulated interruption/);
      expect(
        database
          .query<{ readonly name: string }, []>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'interrupted_migration'",
          )
          .get(),
      ).toBeNull();
      const interrupted = await Effect.runPromise(receipts.read(receipt.operationId));
      expect(interrupted?.revision).toBe(revisionBeforeMigration);
      expect(interrupted?.migrationCheckpoint).toBeUndefined();

      const committed = await Effect.runPromise(
        receipts.checkpointMigration(
          { operationId: receipt.operationId, expectedRevision: receipt.revision },
          () => {
            database.run("CREATE TABLE committed_migration (value TEXT NOT NULL)");
            return "migration-committed";
          },
        ),
      );
      expect(committed.migrationCheckpoint).toBe("migration-committed");
      expect(
        database
          .query<{ readonly name: string }, []>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'committed_migration'",
          )
          .get()?.name,
      ).toBe("committed_migration");
      expect(
        await Effect.runPromise(
          receipts.checkpointMigration(
            { operationId: receipt.operationId, expectedRevision: receipt.revision },
            () => {
              throw new Error("a retained checkpoint must not repeat migration");
            },
          ),
        ),
      ).toEqual(committed);
    } finally {
      database.close(false);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
