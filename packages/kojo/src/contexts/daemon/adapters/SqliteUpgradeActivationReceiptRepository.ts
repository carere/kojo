import type { Database } from "bun:sqlite";
import { Effect } from "effect";
import { LifecycleError } from "../models/LifecycleError.ts";
import type {
  UpgradeActivationReceipt,
  UpgradeActivationReceiptStage,
} from "../models/UpgradeActivationReceipt.ts";
import { upgradeActivationReceiptStages } from "../models/UpgradeActivationReceipt.ts";
import type {
  AdvanceUpgradeActivationReceipt,
  PrepareUpgradeActivationReceipt,
  UpgradeActivationReceiptRepository,
} from "../ports/UpgradeActivationReceiptRepository.ts";

interface ReceiptRow {
  readonly operation_id: string;
  readonly revision: number;
  readonly receipt_json: string;
}

const terminalStages: ReadonlyArray<UpgradeActivationReceiptStage> = [
  "activation-authorized",
  "rolled-back",
  "upgrade-refused",
  "repair-required",
];

const isActive = (receipt: UpgradeActivationReceipt): boolean =>
  !terminalStages.includes(receipt.stage) || receipt.dispatchHeld || receipt.mutationsHeld;

const transitions: Readonly<
  Record<UpgradeActivationReceiptStage, ReadonlyArray<UpgradeActivationReceiptStage>>
> = {
  prepared: ["draining"],
  draining: ["mutations-held"],
  "mutations-held": ["final-preflight-accepted", "final-preflight-refused"],
  "final-preflight-refused": ["upgrade-refused"],
  "final-preflight-accepted": ["handoff-prepared"],
  "handoff-prepared": ["controller-accepted"],
  "controller-accepted": ["backup-verified"],
  "backup-verified": ["source-execution-stopped"],
  "source-execution-stopped": ["candidate-ready", "rollback-ready", "repair-required"],
  "candidate-ready": ["activation-authorized", "rollback-ready", "repair-required"],
  "activation-authorized": [],
  "rollback-ready": ["rolled-back", "repair-required"],
  "rolled-back": [],
  "upgrade-refused": [],
  "repair-required": [],
};

const validRelease = (value: unknown): value is string =>
  typeof value === "string" && value !== "." && value !== ".." && /^[A-Za-z0-9._-]+$/.test(value);

const decode = (row: ReceiptRow): UpgradeActivationReceipt => {
  const value = JSON.parse(row.receipt_json) as Partial<UpgradeActivationReceipt>;
  if (
    value.formatVersion !== 1 ||
    value.operationId !== row.operation_id ||
    value.revision !== row.revision ||
    typeof value.operationId !== "string" ||
    !/^[A-Za-z0-9_-]+$/.test(value.operationId) ||
    typeof value.dataIdentity !== "string" ||
    value.dataIdentity.length === 0 ||
    typeof value.requestHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.requestHash) ||
    !validRelease(value.sourceReleaseId) ||
    !validRelease(value.candidateReleaseId) ||
    typeof value.checkedRetainedSetHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.checkedRetainedSetHash) ||
    !upgradeActivationReceiptStages.includes(value.stage as UpgradeActivationReceiptStage) ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 1 ||
    typeof value.dispatchHeld !== "boolean" ||
    typeof value.mutationsHeld !== "boolean" ||
    typeof value.rollbackAttempted !== "boolean" ||
    (value.forceAuthorizationId !== undefined &&
      (typeof value.forceAuthorizationId !== "string" ||
        !/^[A-Za-z0-9_-]+$/.test(value.forceAuthorizationId))) ||
    value.owner === undefined ||
    typeof value.owner.daemonInstanceId !== "string" ||
    !Array.isArray(value.owner.runnerInstanceIds) ||
    typeof value.owner.recordedAt !== "string"
  ) {
    throw new LifecycleError(
      "UPGRADE_RECEIPT_DAMAGED",
      "the retained managed upgrade receipt is not valid",
    );
  }
  return value as UpgradeActivationReceipt;
};

const fault = (cause: unknown): LifecycleError =>
  cause instanceof LifecycleError
    ? cause
    : new LifecycleError(
        "UPGRADE_RECEIPT_FAILED",
        cause instanceof Error ? cause.message : String(cause),
        cause,
      );

export class SqliteUpgradeActivationReceiptRepository
  implements UpgradeActivationReceiptRepository
{
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
    database.run(`CREATE TABLE IF NOT EXISTS daemon_upgrade_activation_receipts (
      operation_id TEXT PRIMARY KEY NOT NULL,
      revision INTEGER NOT NULL CHECK(revision > 0),
      receipt_json TEXT NOT NULL
    )`);
  }

  #row(operationId: string): ReceiptRow | null {
    return this.#database
      .query<ReceiptRow, [string]>(
        "SELECT operation_id, revision, receipt_json FROM daemon_upgrade_activation_receipts WHERE operation_id = ?",
      )
      .get(operationId);
  }

  readonly read = (
    operationId: string,
  ): Effect.Effect<UpgradeActivationReceipt | undefined, LifecycleError> =>
    Effect.try({
      try: () => {
        const row = this.#row(operationId);
        return row === null ? undefined : decode(row);
      },
      catch: fault,
    });

  readonly active = Effect.try({
    try: () => {
      const rows = this.#database
        .query<ReceiptRow, []>(
          "SELECT operation_id, revision, receipt_json FROM daemon_upgrade_activation_receipts",
        )
        .all()
        .map(decode)
        .filter(isActive);
      if (rows.length > 1) {
        throw new LifecycleError(
          "UPGRADE_RECEIPT_AMBIGUOUS",
          "more than one managed upgrade receipt is active",
        );
      }
      return rows[0];
    },
    catch: fault,
  });

  readonly activeHold = (): boolean => {
    const rows = this.#database
      .query<ReceiptRow, []>(
        "SELECT operation_id, revision, receipt_json FROM daemon_upgrade_activation_receipts",
      )
      .all();
    return rows.map(decode).some((receipt) => receipt.dispatchHeld || receipt.mutationsHeld);
  };

  readonly prepare = (
    request: PrepareUpgradeActivationReceipt,
  ): Effect.Effect<UpgradeActivationReceipt, LifecycleError> =>
    Effect.try({
      try: () =>
        this.#database
          .transaction(() => {
            const existing = this.#row(request.operationId);
            if (existing !== null) {
              const receipt = decode(existing);
              if (
                receipt.dataIdentity !== request.dataIdentity ||
                receipt.requestHash !== request.requestHash ||
                receipt.sourceReleaseId !== request.sourceReleaseId ||
                receipt.candidateReleaseId !== request.candidateReleaseId ||
                receipt.checkedRetainedSetHash !== request.checkedRetainedSetHash
              ) {
                throw new LifecycleError(
                  "UPGRADE_RECEIPT_CONFLICT",
                  "the managed upgrade receipt names different operation content",
                );
              }
              return receipt;
            }
            const active = this.#database
              .query<ReceiptRow, []>(
                "SELECT operation_id, revision, receipt_json FROM daemon_upgrade_activation_receipts",
              )
              .all()
              .map(decode)
              .find(isActive);
            if (active !== undefined) {
              throw new LifecycleError(
                "UPGRADE_OPERATION_PENDING",
                `managed upgrade ${active.operationId} is still ${active.stage}`,
              );
            }
            const receipt: UpgradeActivationReceipt = {
              formatVersion: 1,
              ...request,
              stage: "prepared",
              revision: 1,
              dispatchHeld: false,
              mutationsHeld: false,
              rollbackAttempted: false,
            };
            this.#database.run("INSERT INTO daemon_upgrade_activation_receipts VALUES (?, ?, ?)", [
              receipt.operationId,
              receipt.revision,
              JSON.stringify(receipt),
            ]);
            return receipt;
          })
          .immediate(),
      catch: fault,
    });

  readonly advance = (
    request: AdvanceUpgradeActivationReceipt,
  ): Effect.Effect<UpgradeActivationReceipt, LifecycleError> =>
    Effect.try({
      try: () =>
        this.#database
          .transaction(() => {
            const row = this.#row(request.operationId);
            if (row === null) {
              throw new LifecycleError(
                "UPGRADE_RECEIPT_NOT_FOUND",
                "the managed upgrade receipt was not found",
              );
            }
            const current = decode(row);
            if (current.revision !== request.expectedRevision) {
              if (current.stage === request.stage) return current;
              throw new LifecycleError(
                "UPGRADE_RECEIPT_REVISION_CONFLICT",
                `the managed upgrade receipt is at revision ${current.revision}`,
              );
            }
            if (
              current.stage !== request.stage &&
              !transitions[current.stage].includes(request.stage)
            ) {
              throw new LifecycleError(
                "UPGRADE_RECEIPT_STAGE_CONFLICT",
                `managed upgrade stage ${request.stage} cannot follow ${current.stage}`,
              );
            }
            const updated: UpgradeActivationReceipt = {
              ...current,
              ...request.changes,
              stage: request.stage,
              revision: current.revision + 1,
            };
            this.#database.run(
              `UPDATE daemon_upgrade_activation_receipts
                SET revision = ?, receipt_json = ? WHERE operation_id = ?`,
              [updated.revision, JSON.stringify(updated), updated.operationId],
            );
            return updated;
          })
          .immediate(),
      catch: fault,
    });

  readonly checkpointMigration = (
    request: Pick<AdvanceUpgradeActivationReceipt, "operationId" | "expectedRevision">,
    migrate: () => string,
  ): Effect.Effect<UpgradeActivationReceipt, LifecycleError> =>
    Effect.try({
      try: () =>
        this.#database
          .transaction(() => {
            const row = this.#row(request.operationId);
            if (row === null) {
              throw new LifecycleError(
                "UPGRADE_RECEIPT_NOT_FOUND",
                "the managed upgrade receipt was not found",
              );
            }
            const current = decode(row);
            if (current.migrationCheckpoint !== undefined) return current;
            if (
              current.revision !== request.expectedRevision ||
              current.stage !== "source-execution-stopped"
            ) {
              throw new LifecycleError(
                "UPGRADE_MIGRATION_RECEIPT_CONFLICT",
                "the migration cannot commit outside the stopped source boundary",
              );
            }
            const updated: UpgradeActivationReceipt = {
              ...current,
              migrationCheckpoint: migrate(),
              revision: current.revision + 1,
            };
            this.#database.run(
              `UPDATE daemon_upgrade_activation_receipts
                SET revision = ?, receipt_json = ? WHERE operation_id = ?`,
              [updated.revision, JSON.stringify(updated), updated.operationId],
            );
            return updated;
          })
          .immediate(),
      catch: fault,
    });
}
