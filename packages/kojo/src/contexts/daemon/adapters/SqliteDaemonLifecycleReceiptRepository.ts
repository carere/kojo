import type { Database } from "bun:sqlite";
import { Effect } from "effect";
import type {
  DaemonLifecycleReceipt,
  DaemonLifecycleReceiptStage,
} from "../models/DaemonLifecycleReceipt.ts";
import { LifecycleError } from "../models/LifecycleError.ts";
import type { LifecycleRecordedOwner } from "../models/LifecycleOperation.ts";
import type { DaemonLifecycleReceiptRepository } from "../ports/DaemonLifecycleReceiptRepository.ts";

interface ReceiptRow {
  readonly operation_id: string;
  readonly data_identity: string;
  readonly request_hash: string;
  readonly stage: DaemonLifecycleReceiptStage;
  readonly revision: number;
  readonly drain_held: number;
  readonly owner_json: string;
  readonly handoff_digest: string | null;
  readonly force_authorization_id: string | null;
}

const receiptOf = (row: ReceiptRow): DaemonLifecycleReceipt => {
  const owner = JSON.parse(row.owner_json) as unknown;
  const stages: ReadonlyArray<DaemonLifecycleReceiptStage> = [
    "prepared",
    "draining",
    "handoff-prepared",
    "controller-accepted",
    "cleanup-started",
    "process-stopped",
    "replacement-ready",
  ];
  if (
    !/^[A-Za-z0-9_-]+$/.test(row.operation_id) ||
    row.data_identity.length === 0 ||
    !/^[a-f0-9]{64}$/.test(row.request_hash) ||
    !stages.includes(row.stage) ||
    !Number.isSafeInteger(row.revision) ||
    row.revision < 1 ||
    (row.drain_held !== 0 && row.drain_held !== 1) ||
    owner === null ||
    typeof owner !== "object" ||
    Array.isArray(owner) ||
    typeof (owner as { readonly daemonInstanceId?: unknown }).daemonInstanceId !== "string" ||
    !/^[A-Za-z0-9_-]+$/.test((owner as { readonly daemonInstanceId: string }).daemonInstanceId) ||
    !Array.isArray((owner as { readonly runnerInstanceIds?: unknown }).runnerInstanceIds) ||
    !(owner as { readonly runnerInstanceIds: ReadonlyArray<unknown> }).runnerInstanceIds.every(
      (value) => typeof value === "string" && /^[A-Za-z0-9_-]+$/.test(value),
    ) ||
    typeof (owner as { readonly recordedAt?: unknown }).recordedAt !== "string" ||
    !Number.isFinite(Date.parse((owner as { readonly recordedAt: string }).recordedAt)) ||
    (row.handoff_digest !== null && !/^[a-f0-9]{64}$/.test(row.handoff_digest)) ||
    (row.force_authorization_id !== null && !/^[A-Za-z0-9_-]+$/.test(row.force_authorization_id)) ||
    (stageOrder[row.stage] >= stageOrder["handoff-prepared"] && row.handoff_digest === null) ||
    (stageOrder[row.stage] < stageOrder["cleanup-started"] && row.force_authorization_id !== null)
  ) {
    throw new LifecycleError(
      "DAEMON_LIFECYCLE_RECEIPT_DAMAGED",
      "the retained Daemon lifecycle receipt is not valid",
    );
  }
  return {
    operationId: row.operation_id,
    dataIdentity: row.data_identity,
    requestHash: row.request_hash,
    stage: row.stage,
    revision: row.revision,
    drainHeld: row.drain_held === 1,
    owner: owner as LifecycleRecordedOwner,
    ...(row.handoff_digest === null ? {} : { handoffDigest: row.handoff_digest }),
    ...(row.force_authorization_id === null
      ? {}
      : { forceAuthorizationId: row.force_authorization_id }),
  };
};

const stageOrder: Readonly<Record<DaemonLifecycleReceiptStage, number>> = {
  prepared: 0,
  draining: 1,
  "handoff-prepared": 2,
  "controller-accepted": 3,
  "cleanup-started": 4,
  "process-stopped": 5,
  "replacement-ready": 6,
};

const failure = (cause: unknown): LifecycleError =>
  cause instanceof LifecycleError
    ? cause
    : new LifecycleError(
        "DAEMON_LIFECYCLE_RECEIPT_FAILED",
        cause instanceof Error ? cause.message : String(cause),
        cause,
      );

export class SqliteDaemonLifecycleReceiptRepository implements DaemonLifecycleReceiptRepository {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
    database.run(`CREATE TABLE IF NOT EXISTS daemon_lifecycle_receipts (
      operation_id TEXT PRIMARY KEY NOT NULL,
      data_identity TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      stage TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision > 0),
      drain_held INTEGER NOT NULL CHECK(drain_held IN (0, 1)),
      owner_json TEXT NOT NULL,
      handoff_digest TEXT,
      force_authorization_id TEXT
    )`);
  }

  #row(operationId: string): ReceiptRow | null {
    return this.#database
      .query<ReceiptRow, [string]>("SELECT * FROM daemon_lifecycle_receipts WHERE operation_id = ?")
      .get(operationId);
  }

  readonly activeDrainHeld = (): boolean =>
    this.#database
      .query<{ readonly found: number }, []>(
        "SELECT 1 AS found FROM daemon_lifecycle_receipts WHERE drain_held = 1 LIMIT 1",
      )
      .get() !== null;

  readonly read = (
    operationId: string,
  ): Effect.Effect<DaemonLifecycleReceipt | undefined, LifecycleError> =>
    Effect.try({
      try: () => {
        const row = this.#row(operationId);
        return row === null ? undefined : receiptOf(row);
      },
      catch: failure,
    });

  readonly prepare = (request: {
    readonly operationId: string;
    readonly dataIdentity: string;
    readonly requestHash: string;
    readonly owner: LifecycleRecordedOwner;
  }): Effect.Effect<DaemonLifecycleReceipt, LifecycleError> =>
    Effect.try({
      try: () =>
        this.#database
          .transaction(() => {
            const existing = this.#row(request.operationId);
            if (existing !== null) {
              if (
                existing.data_identity !== request.dataIdentity ||
                existing.request_hash !== request.requestHash
              ) {
                throw new LifecycleError(
                  "DAEMON_LIFECYCLE_REQUEST_CONFLICT",
                  "the Daemon receipt already names different lifecycle content",
                );
              }
              return receiptOf(existing);
            }
            const competing = this.#database
              .query<{ readonly operation_id: string }, []>(
                `SELECT operation_id FROM daemon_lifecycle_receipts
                  WHERE drain_held = 1 OR stage NOT IN ('process-stopped', 'replacement-ready')
                  LIMIT 1`,
              )
              .get();
            if (competing !== null) {
              throw new LifecycleError(
                "DAEMON_LIFECYCLE_OPERATION_PENDING",
                `Daemon lifecycle operation ${competing.operation_id} still holds dispatch`,
              );
            }
            this.#database.run(
              `INSERT INTO daemon_lifecycle_receipts (
                operation_id, data_identity, request_hash, stage, revision, drain_held, owner_json
              ) VALUES (?, ?, ?, 'prepared', 1, 0, ?)`,
              [
                request.operationId,
                request.dataIdentity,
                request.requestHash,
                JSON.stringify(request.owner),
              ],
            );
            return receiptOf(this.#row(request.operationId) as ReceiptRow);
          })
          .immediate(),
      catch: failure,
    });

  readonly advance = (request: {
    readonly operationId: string;
    readonly expectedRevision: number;
    readonly stage: DaemonLifecycleReceiptStage;
    readonly owner: LifecycleRecordedOwner;
    readonly handoffDigest?: string;
    readonly forceAuthorizationId?: string;
    readonly drainHeld?: boolean;
  }): Effect.Effect<DaemonLifecycleReceipt, LifecycleError> =>
    Effect.try({
      try: () =>
        this.#database
          .transaction(() => {
            const existing = this.#row(request.operationId);
            if (existing === null) {
              throw new LifecycleError(
                "DAEMON_LIFECYCLE_RECEIPT_NOT_FOUND",
                "the Daemon lifecycle receipt was not found",
              );
            }
            if (existing.revision !== request.expectedRevision) {
              if (stageOrder[existing.stage] >= stageOrder[request.stage]) {
                if (
                  (request.handoffDigest !== undefined &&
                    existing.handoff_digest !== request.handoffDigest) ||
                  (request.forceAuthorizationId !== undefined &&
                    existing.force_authorization_id !== request.forceAuthorizationId)
                ) {
                  throw new LifecycleError(
                    "DAEMON_LIFECYCLE_REPLAY_CONFLICT",
                    "the repeated Daemon lifecycle stage names different evidence",
                  );
                }
                return receiptOf(existing);
              }
              throw new LifecycleError(
                "DAEMON_LIFECYCLE_REVISION_CONFLICT",
                `the Daemon lifecycle receipt is at revision ${existing.revision}`,
              );
            }
            if (stageOrder[request.stage] < stageOrder[existing.stage]) {
              throw new LifecycleError(
                "DAEMON_LIFECYCLE_STAGE_REGRESSION",
                "the Daemon lifecycle receipt cannot move backwards",
              );
            }
            if (stageOrder[request.stage] > stageOrder[existing.stage] + 1) {
              throw new LifecycleError(
                "DAEMON_LIFECYCLE_STAGE_GAP",
                "the Daemon lifecycle receipt cannot skip required handoff stages",
              );
            }
            const handoffDigest = request.handoffDigest ?? existing.handoff_digest ?? undefined;
            if (
              stageOrder[request.stage] >= stageOrder["handoff-prepared"] &&
              handoffDigest === undefined
            ) {
              throw new LifecycleError(
                "DAEMON_LIFECYCLE_HANDOFF_MISSING",
                "the Daemon lifecycle receipt cannot advance without handoff evidence",
              );
            }
            const drainHeld = request.drainHeld ?? existing.drain_held === 1;
            this.#database.run(
              `UPDATE daemon_lifecycle_receipts SET stage = ?, revision = revision + 1,
                drain_held = ?, owner_json = ?, handoff_digest = COALESCE(?, handoff_digest),
                force_authorization_id = COALESCE(?, force_authorization_id)
               WHERE operation_id = ?`,
              [
                request.stage,
                drainHeld ? 1 : 0,
                JSON.stringify(request.owner),
                request.handoffDigest ?? null,
                request.forceAuthorizationId ?? null,
                request.operationId,
              ],
            );
            return receiptOf(this.#row(request.operationId) as ReceiptRow);
          })
          .immediate(),
      catch: failure,
    });
}
