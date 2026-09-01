import { Database } from "bun:sqlite";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { Effect } from "effect";
import type { RunApi } from "../../workflow/services/RunApi.ts";
import { readCheckedManagedRelease } from "../adapters/ManagedInstallation.ts";
import type { DaemonPaths } from "../models/DaemonPaths.ts";
import { LifecycleError } from "../models/LifecycleError.ts";
import type {
  LifecycleDrainProgress,
  LifecycleRecordedOwner,
  UpgradeBackupEvidence,
  UpgradeReadinessEvidence,
} from "../models/LifecycleOperation.ts";
import type { CheckedManagedReleaseManifest } from "../models/ManagedRelease.ts";
import type {
  UpgradeFinalPreflight,
  UpgradeHandoff,
  UpgradeRollbackSafety,
} from "../models/UpgradeActivation.ts";
import type { UpgradeActivationReceipt } from "../models/UpgradeActivationReceipt.ts";
import type { DaemonUpgradeControl } from "../ports/DaemonUpgradeControl.ts";
import type { UpgradeActivationReceiptRepository } from "../ports/UpgradeActivationReceiptRepository.ts";
import type { DaemonMutationGate } from "./DaemonMutationGate.ts";
import type { ManagedUpgradePreflight } from "./ManagedUpgradePreflight.ts";
import { assertPrivateNode, ensurePrivateDirectory } from "./secureHostPath.ts";

export interface UpgradeMigrationResult {
  readonly checkpoint: string;
}

export type UpgradeMigration = (options: {
  readonly database: Database;
  readonly operationId: string;
  readonly fromDataFormat: number;
  readonly toDataFormat: number;
}) => UpgradeMigrationResult;

const hash = (value: Uint8Array | string): string =>
  new Bun.CryptoHasher("sha256").update(value).digest("hex");

const error = (cause: unknown): LifecycleError =>
  cause instanceof LifecycleError
    ? cause
    : new LifecycleError(
        "UPGRADE_DAEMON_CONTROL_FAILED",
        cause instanceof Error ? cause.message : String(cause),
        cause,
      );

const digest = (value: unknown): string => hash(JSON.stringify(value));

export class DaemonUpgradeApi implements DaemonUpgradeControl {
  readonly #database: Database;
  readonly #paths: DaemonPaths;
  readonly #dataIdentity: string;
  readonly #activeReleaseId: () => string;
  readonly #runs: RunApi;
  readonly #receipts: UpgradeActivationReceiptRepository;
  readonly #mutations: DaemonMutationGate;
  readonly #preflight: ManagedUpgradePreflight;
  readonly #transportsReady: () => boolean;
  readonly #restricted: boolean;
  readonly #recordRestrictedReady: () => void;
  readonly #resume: Effect.Effect<void, LifecycleError>;
  readonly #activate: Effect.Effect<void, LifecycleError>;
  readonly #migration: UpgradeMigration | undefined;
  readonly #now: () => number;

  constructor(options: {
    readonly database: Database;
    readonly paths: DaemonPaths;
    readonly dataIdentity: string;
    readonly activeReleaseId: () => string;
    readonly runs: RunApi;
    readonly receipts: UpgradeActivationReceiptRepository;
    readonly mutations: DaemonMutationGate;
    readonly preflight: ManagedUpgradePreflight;
    readonly transportsReady: () => boolean;
    readonly restricted: boolean;
    readonly recordRestrictedReady: () => void;
    readonly resume: Effect.Effect<void, LifecycleError>;
    readonly activate: Effect.Effect<void, LifecycleError>;
    readonly migration?: UpgradeMigration;
    readonly now?: () => number;
  }) {
    this.#database = options.database;
    this.#paths = options.paths;
    this.#dataIdentity = options.dataIdentity;
    this.#activeReleaseId = options.activeReleaseId;
    this.#runs = options.runs;
    this.#receipts = options.receipts;
    this.#mutations = options.mutations;
    this.#preflight = options.preflight;
    this.#transportsReady = options.transportsReady;
    this.#restricted = options.restricted;
    this.#recordRestrictedReady = options.recordRestrictedReady;
    this.#resume = options.resume;
    this.#activate = options.activate;
    this.#migration = options.migration;
    this.#now = options.now ?? Date.now;
  }

  #owner(): LifecycleRecordedOwner {
    return this.#runs.lifecycleOwner();
  }

  #manifest(releaseId: string): CheckedManagedReleaseManifest {
    return readCheckedManagedRelease(this.#paths, releaseId);
  }

  #dataFormat(): number {
    const row = this.#database
      .query<{ readonly value: string }, []>(
        "SELECT value FROM daemon_metadata WHERE name = 'data_format_version'",
      )
      .get();
    if (row === null) return 1;
    const value = Number(row.value);
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new LifecycleError(
        "UPGRADE_DATA_FORMAT_DAMAGED",
        "the Daemon data format is not valid",
      );
    }
    return value;
  }

  #integrity(): void {
    const rows = this.#database
      .query<{ readonly integrity_check: string }, []>("PRAGMA integrity_check")
      .all();
    if (rows.length !== 1 || rows[0]?.integrity_check !== "ok") {
      throw new LifecycleError(
        "UPGRADE_INTEGRITY_FAILED",
        "the candidate did not prove SQLite integrity",
      );
    }
  }

  #wakeupDigest(): string {
    const table = this.#database
      .query<{ readonly found: number }, []>(
        "SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'workflow_wakeups'",
      )
      .get();
    if (table === null) return digest([]);
    return digest(
      this.#database
        .query<{ readonly wakeup_id: string; readonly state: string; readonly due_at: string }, []>(
          "SELECT wakeup_id, state, due_at FROM workflow_wakeups ORDER BY wakeup_id",
        )
        .all(),
    );
  }

  #verifyBackup(receipt: UpgradeActivationReceipt): UpgradeBackupEvidence {
    if (receipt.backup === undefined) {
      throw new LifecycleError(
        "UPGRADE_BACKUP_MISSING",
        "the candidate has no verified source backup evidence",
      );
    }
    const path = join(
      this.#paths.dataRoot,
      "lifecycle",
      "backups",
      `${receipt.backup.backupId}.sqlite`,
    );
    assertPrivateNode(path, "file");
    if (hash(readFileSync(path)) !== receipt.backup.sha256) {
      throw new LifecycleError(
        "UPGRADE_BACKUP_DAMAGED",
        "the retained backup no longer matches its verified digest",
      );
    }
    return receipt.backup;
  }

  #applyMigration(
    receipt: UpgradeActivationReceipt,
  ): Effect.Effect<string | undefined, LifecycleError> {
    const candidate = this.#manifest(receipt.candidateReleaseId);
    const current = this.#dataFormat();
    if (candidate.compatibility.dataFormats.includes(current)) {
      return Effect.succeed(receipt.migrationCheckpoint);
    }
    const declaration = candidate.migration;
    if (
      declaration === undefined ||
      declaration.fromDataFormat !== current ||
      !candidate.compatibility.dataFormats.includes(declaration.toDataFormat)
    ) {
      return Effect.fail(
        new LifecycleError(
          "UPGRADE_MIGRATION_REFUSED",
          `the candidate cannot migrate Daemon data format ${current}`,
        ),
      );
    }
    if (this.#migration === undefined) {
      return Effect.fail(
        new LifecycleError(
          "UPGRADE_MIGRATION_UNAVAILABLE",
          "the candidate declares a migration but does not contain its transactional implementation",
        ),
      );
    }
    return this.#receipts
      .checkpointMigration(
        { operationId: receipt.operationId, expectedRevision: receipt.revision },
        () => {
          const result = (this.#migration as UpgradeMigration)({
            database: this.#database,
            operationId: receipt.operationId,
            fromDataFormat: declaration.fromDataFormat,
            toDataFormat: declaration.toDataFormat,
          });
          this.#database.run(
            `INSERT INTO daemon_metadata (name, value) VALUES ('data_format_version', ?)
              ON CONFLICT(name) DO UPDATE SET value = excluded.value`,
            [String(declaration.toDataFormat)],
          );
          return result.checkpoint;
        },
      )
      .pipe(Effect.map((updated) => updated.migrationCheckpoint));
  }

  readonly inspectPreflight = (
    operationId: string,
    dataIdentity: string,
    requestHash: string,
    sourceReleaseId: string,
    candidateReleaseId: string,
    checkedRetainedSetHash: string,
  ): Effect.Effect<LifecycleRecordedOwner, LifecycleError> => {
    const api = this;
    return Effect.gen(function* () {
      if (dataIdentity !== api.#dataIdentity) {
        return yield* Effect.fail(
          new LifecycleError(
            "DAEMON_DATA_IDENTITY_CHANGED",
            "the managed upgrade names different Daemon data",
          ),
        );
      }
      if (api.#activeReleaseId() !== sourceReleaseId) {
        return yield* Effect.fail(
          new LifecycleError(
            "ACTIVE_RELEASE_CHANGED",
            "the checked source release is no longer active",
          ),
        );
      }
      const report = yield* api.#preflight.latest;
      if (
        report === undefined ||
        report.outcome !== "staged" ||
        report.dataIdentity !== dataIdentity ||
        report.sourceReleaseId !== sourceReleaseId ||
        report.candidateReleaseId !== candidateReleaseId ||
        report.retainedSetHash !== checkedRetainedSetHash
      ) {
        return yield* Effect.fail(
          new LifecycleError(
            "UPGRADE_CHECK_REQUIRED",
            "activation requires the matching accepted managed upgrade check",
          ),
        );
      }
      const owner = api.#owner();
      yield* api.#receipts.prepare({
        operationId,
        dataIdentity,
        requestHash,
        sourceReleaseId,
        candidateReleaseId,
        checkedRetainedSetHash,
        owner,
      });
      return owner;
    });
  };

  readonly beginDrain = (operationId: string) => {
    const api = this;
    return Effect.gen(function* () {
      const receipt = yield* api.#receipts.read(operationId);
      if (receipt === undefined) {
        return yield* Effect.fail(
          new LifecycleError("UPGRADE_RECEIPT_NOT_FOUND", "the upgrade receipt was not found"),
        );
      }
      const progress = yield* api.#runs.beginDaemonDrain().pipe(Effect.mapError(error));
      if (receipt.stage === "prepared") {
        yield* api.#receipts.advance({
          operationId,
          expectedRevision: receipt.revision,
          stage: "draining",
          changes: { dispatchHeld: true, owner: api.#owner() },
        });
      }
      return progress;
    });
  };

  readonly readDrain = (operationId: string) =>
    this.#receipts
      .read(operationId)
      .pipe(
        Effect.flatMap((receipt) =>
          receipt === undefined || !receipt.dispatchHeld
            ? Effect.fail(
                new LifecycleError(
                  "UPGRADE_DRAIN_NOT_HELD",
                  "the managed upgrade has no durable dispatch hold",
                ),
              )
            : this.#runs.daemonDrainProgress().pipe(Effect.mapError(error)),
        ),
      );

  readonly forceDrain = (
    operationId: string,
    cleanupMillis: number,
    forceAuthorizationId: string,
  ): Effect.Effect<LifecycleDrainProgress, LifecycleError> => {
    const api = this;
    return Effect.gen(function* () {
      let receipt = yield* api.#receipts.read(operationId);
      if (receipt === undefined || !receipt.dispatchHeld || receipt.stage !== "draining") {
        return yield* Effect.fail(
          new LifecycleError(
            "UPGRADE_DRAIN_NOT_HELD",
            "forced drain requires the durable managed upgrade dispatch hold",
          ),
        );
      }
      if (
        receipt.forceAuthorizationId !== undefined &&
        receipt.forceAuthorizationId !== forceAuthorizationId
      ) {
        return yield* Effect.fail(
          new LifecycleError(
            "UPGRADE_FORCE_MISMATCH",
            "forced drain does not name the retained force authorization",
          ),
        );
      }
      const owner = yield* api.#runs.forceDaemonDrain(cleanupMillis).pipe(Effect.mapError(error));
      receipt = yield* api.#receipts.advance({
        operationId,
        expectedRevision: receipt.revision,
        stage: "draining",
        changes: { forceAuthorizationId, owner },
      });
      const progress = yield* api.#runs.daemonDrainProgress().pipe(Effect.mapError(error));
      if (progress.executingRunIds.length > 0) {
        return yield* Effect.fail(
          new LifecycleError(
            "UPGRADE_FORCE_INCOMPLETE",
            "forced drain did not stop every executing Run",
          ),
        );
      }
      return progress;
    });
  };

  readonly holdMutations = (operationId: string): Effect.Effect<void, LifecycleError> => {
    const api = this;
    return Effect.gen(function* () {
      const receipt = yield* api.#receipts.read(operationId);
      if (receipt === undefined || !receipt.dispatchHeld) {
        return yield* Effect.fail(
          new LifecycleError(
            "UPGRADE_DRAIN_NOT_HELD",
            "ordinary mutations cannot stop before the dispatch hold",
          ),
        );
      }
      yield* api.#mutations.hold(operationId);
      if (receipt.stage === "draining") {
        yield* api.#receipts.advance({
          operationId,
          expectedRevision: receipt.revision,
          stage: "mutations-held",
          changes: { mutationsHeld: true, owner: api.#owner() },
        });
      }
    });
  };

  readonly repeatFinalPreflight = (
    operationId: string,
    candidateReleaseId: string,
    checkedRetainedSetHash: string,
  ): Effect.Effect<UpgradeFinalPreflight, LifecycleError> => {
    const api = this;
    return Effect.gen(function* () {
      const receipt = yield* api.#receipts.read(operationId);
      if (
        receipt === undefined ||
        receipt.candidateReleaseId !== candidateReleaseId ||
        receipt.checkedRetainedSetHash !== checkedRetainedSetHash
      ) {
        return yield* Effect.fail(
          new LifecycleError(
            "UPGRADE_PREFLIGHT_MISMATCH",
            "final preflight does not name the accepted candidate and retained state",
          ),
        );
      }
      if (
        receipt.stage === "final-preflight-accepted" &&
        receipt.finalRetainedSetHash !== undefined
      ) {
        return {
          outcome: "accepted",
          retainedSetHash: receipt.finalRetainedSetHash,
          owner: receipt.owner,
          detail: "the final retained state is compatible",
        };
      }
      if (
        (receipt.stage === "final-preflight-refused" || receipt.stage === "upgrade-refused") &&
        receipt.finalRetainedSetHash !== undefined
      ) {
        return {
          outcome: "refused",
          retainedSetHash: receipt.finalRetainedSetHash,
          owner: receipt.owner,
          detail: receipt.detail ?? "the final retained state is not compatible",
        };
      }
      if (!receipt.mutationsHeld || receipt.stage !== "mutations-held") {
        return yield* Effect.fail(
          new LifecycleError(
            "UPGRADE_MUTATIONS_NOT_HELD",
            "final preflight requires the durable ordinary-mutation hold",
          ),
        );
      }
      const report = (yield* api.#preflight.check({
        candidate: api.#manifest(candidateReleaseId),
        sourceReleaseId: receipt.sourceReleaseId,
      })).report;
      const accepted = report.outcome === "staged";
      const owner = api.#owner();
      if (accepted) {
        yield* api.#receipts.advance({
          operationId,
          expectedRevision: receipt.revision,
          stage: "final-preflight-accepted",
          changes: { finalRetainedSetHash: report.retainedSetHash, owner },
        });
      } else {
        yield* api.#receipts.advance({
          operationId,
          expectedRevision: receipt.revision,
          stage: "final-preflight-refused",
          changes: {
            finalRetainedSetHash: report.retainedSetHash,
            owner,
            detail: report.remedy,
          },
        });
      }
      return {
        outcome: accepted ? "accepted" : "refused",
        retainedSetHash: report.retainedSetHash,
        owner,
        detail: accepted ? "the final retained state is compatible" : report.remedy,
      };
    });
  };

  readonly releaseUpgradeHolds = (operationId: string): Effect.Effect<void, LifecycleError> => {
    const api = this;
    return Effect.gen(function* () {
      const receipt = yield* api.#receipts.read(operationId);
      if (receipt === undefined) return;
      if (receipt.stage === "upgrade-refused" && !receipt.dispatchHeld && !receipt.mutationsHeld) {
        return;
      }
      yield* api.#resume;
      yield* api.#mutations.release(operationId);
      yield* api.#runs.releaseDaemonDispatch().pipe(Effect.mapError(error));
      if (receipt.stage === "final-preflight-refused") {
        yield* api.#receipts.advance({
          operationId,
          expectedRevision: receipt.revision,
          stage: "upgrade-refused",
          changes: {
            dispatchHeld: false,
            mutationsHeld: false,
            detail: receipt.detail ?? "final managed upgrade preflight refused activation",
          },
        });
      }
    });
  };

  readonly prepareHandoff = (
    operationId: string,
  ): Effect.Effect<UpgradeHandoff, LifecycleError> => {
    const api = this;
    return Effect.gen(function* () {
      const receipt = yield* api.#receipts.read(operationId);
      if (receipt === undefined) {
        return yield* Effect.fail(
          new LifecycleError("UPGRADE_RECEIPT_NOT_FOUND", "the upgrade receipt was not found"),
        );
      }
      if (receipt.handoffDigest !== undefined) {
        return { digest: receipt.handoffDigest, owner: receipt.owner };
      }
      if (receipt.stage !== "final-preflight-accepted") {
        return yield* Effect.fail(
          new LifecycleError(
            "UPGRADE_FINAL_PREFLIGHT_MISSING",
            "the final managed upgrade preflight is not accepted",
          ),
        );
      }
      const owner = api.#owner();
      const handoffDigest = digest({
        operationId,
        dataIdentity: receipt.dataIdentity,
        requestHash: receipt.requestHash,
        sourceReleaseId: receipt.sourceReleaseId,
        candidateReleaseId: receipt.candidateReleaseId,
        finalRetainedSetHash: receipt.finalRetainedSetHash,
        owner,
      });
      yield* api.#receipts.advance({
        operationId,
        expectedRevision: receipt.revision,
        stage: "handoff-prepared",
        changes: { handoffDigest, owner },
      });
      return { digest: handoffDigest, owner };
    });
  };

  readonly confirmControllerReady = (operationId: string, handoffDigest: string) => {
    const api = this;
    return Effect.gen(function* () {
      const receipt = yield* api.#receipts.read(operationId);
      if (receipt === undefined || receipt.handoffDigest !== handoffDigest) {
        return yield* Effect.fail(
          new LifecycleError(
            "UPGRADE_HANDOFF_MISMATCH",
            "the controller does not name the final Daemon handoff",
          ),
        );
      }
      if (receipt.stage === "controller-accepted") return;
      yield* api.#receipts.advance({
        operationId,
        expectedRevision: receipt.revision,
        stage: "controller-accepted",
        changes: { owner: api.#owner() },
      });
    });
  };

  readonly createVerifiedBackup = (
    operationId: string,
  ): Effect.Effect<UpgradeBackupEvidence, LifecycleError> => {
    const api = this;
    return Effect.tryPromise({
      try: async () => {
        const receipt = await Effect.runPromise(api.#receipts.read(operationId));
        if (receipt === undefined) {
          throw new LifecycleError(
            "UPGRADE_RECEIPT_NOT_FOUND",
            "the upgrade receipt was not found",
          );
        }
        if (receipt.backup !== undefined) return api.#verifyBackup(receipt);
        if (receipt.stage !== "controller-accepted") {
          throw new LifecycleError(
            "UPGRADE_BACKUP_NOT_ALLOWED",
            "backup needs the accepted two-sided lifecycle handoff",
          );
        }
        const root = join(api.#paths.dataRoot, "lifecycle", "backups");
        ensurePrivateDirectory(root);
        const backupId = operationId;
        const path = join(root, `${backupId}.sqlite`);
        const stagingPath = join(root, `${backupId}.sqlite.staging`);
        const verify = (candidatePath: string): void => {
          assertPrivateNode(candidatePath, "file");
          const backup = new Database(candidatePath, {
            readonly: true,
            strict: true,
          });
          try {
            const integrity = backup
              .query<{ readonly integrity_check: string }, []>("PRAGMA integrity_check")
              .get();
            if (integrity?.integrity_check !== "ok") {
              throw new LifecycleError(
                "UPGRADE_BACKUP_INVALID",
                "the consistent backup did not pass SQLite integrity",
              );
            }
          } finally {
            backup.close(false);
          }
        };
        if (!existsSync(path)) {
          if (existsSync(stagingPath)) {
            assertPrivateNode(stagingPath, "file");
            unlinkSync(stagingPath);
          }
          api.#database.run("VACUUM INTO ?", [stagingPath]);
          chmodSync(stagingPath, 0o400);
          verify(stagingPath);
          const stagingFile = openSync(stagingPath, "r");
          try {
            fsyncSync(stagingFile);
          } finally {
            closeSync(stagingFile);
          }
          renameSync(stagingPath, path);
          const backupDirectory = openSync(root, "r");
          try {
            fsyncSync(backupDirectory);
          } finally {
            closeSync(backupDirectory);
          }
        }
        verify(path);
        chmodSync(path, 0o400);
        const sealedFile = openSync(path, "r");
        try {
          fsyncSync(sealedFile);
        } finally {
          closeSync(sealedFile);
        }
        const sha256 = hash(readFileSync(path));
        const evidence: UpgradeBackupEvidence = {
          backupId,
          sha256,
          dataVersion: sha256,
          verifiedAt: new Date(api.#now()).toISOString(),
        };
        await Effect.runPromise(
          api.#receipts.advance({
            operationId,
            expectedRevision: receipt.revision,
            stage: "backup-verified",
            changes: { backup: evidence, owner: api.#owner() },
          }),
        );
        return evidence;
      },
      catch: error,
    });
  };

  readonly stopOwnedProcesses = (
    operationId: string,
    cleanupMillis: number,
    forceAuthorizationId?: string,
  ): Effect.Effect<LifecycleRecordedOwner, LifecycleError> => {
    const api = this;
    return Effect.gen(function* () {
      const receipt = yield* api.#receipts.read(operationId);
      if (receipt === undefined) {
        return yield* Effect.fail(
          new LifecycleError("UPGRADE_RECEIPT_NOT_FOUND", "the upgrade receipt was not found"),
        );
      }
      if (receipt.stage === "source-execution-stopped") return receipt.owner;
      if (receipt.stage !== "backup-verified") {
        return yield* Effect.fail(
          new LifecycleError(
            "UPGRADE_BACKUP_NOT_VERIFIED",
            "source execution cannot stop before the verified backup",
          ),
        );
      }
      const owner = yield* api.#runs
        .stopForDaemonLifecycle(cleanupMillis, forceAuthorizationId !== undefined)
        .pipe(Effect.mapError(error));
      yield* api.#receipts.advance({
        operationId,
        expectedRevision: receipt.revision,
        stage: "source-execution-stopped",
        changes: { owner },
      });
      return owner;
    });
  };

  #readiness(
    operationId: string,
    expectedReleaseId: string,
    priorDaemonInstanceId?: string,
  ): Effect.Effect<UpgradeReadinessEvidence, LifecycleError> {
    return Effect.tryPromise({
      try: async () => {
        const receipt = await Effect.runPromise(this.#receipts.read(operationId));
        if (receipt === undefined) {
          throw new LifecycleError(
            "UPGRADE_RECEIPT_NOT_FOUND",
            "the candidate cannot find the upgrade receipt",
          );
        }
        const nextStage =
          expectedReleaseId === receipt.sourceReleaseId ? "rollback-ready" : "candidate-ready";
        if (!this.#restricted) {
          throw new LifecycleError(
            "UPGRADE_CANDIDATE_NOT_RESTRICTED",
            "candidate readiness requires restricted ownership before activation",
          );
        }
        if (this.#activeReleaseId() !== expectedReleaseId) {
          throw new LifecycleError(
            "UPGRADE_RELEASE_SELECTION_CHANGED",
            "the restricted Daemon does not own the expected managed release",
          );
        }
        const owner = this.#owner();
        if (
          receipt.stage === nextStage &&
          receipt.readiness !== undefined &&
          receipt.readiness.daemonInstanceId === owner.daemonInstanceId
        ) {
          this.#verifyBackup(receipt);
          this.#recordRestrictedReady();
          return receipt.readiness;
        }
        if (
          priorDaemonInstanceId !== undefined &&
          owner.daemonInstanceId === priorDaemonInstanceId
        ) {
          throw new LifecycleError(
            "UPGRADE_REPLACEMENT_NOT_OBSERVED",
            "candidate readiness needs a new Daemon owner",
          );
        }
        if (owner.runnerInstanceIds.length > 0) {
          throw new LifecycleError(
            "UPGRADE_CANDIDATE_EXECUTED_WORK",
            "the restricted candidate started a Project Runner before activation",
          );
        }
        this.#verifyBackup(receipt);
        const checkpoint = await Effect.runPromise(this.#applyMigration(receipt));
        this.#integrity();
        if (!this.#transportsReady()) {
          throw new LifecycleError(
            "UPGRADE_TRANSPORT_NOT_READY",
            "the restricted candidate transport is not ready",
          );
        }
        const current = (await Effect.runPromise(
          this.#receipts.read(operationId),
        )) as UpgradeActivationReceipt;
        const evidence: UpgradeReadinessEvidence = {
          daemonInstanceId: owner.daemonInstanceId,
          dataIdentity: this.#dataIdentity,
          sourceReleaseId: receipt.sourceReleaseId,
          candidateReleaseId: expectedReleaseId,
          receiptDigest: digest(current),
          wakeupDigest: this.#wakeupDigest(),
          integrity: "ok",
          transports: "ready",
          workflowExecutions: 0,
          checkedAt: new Date(this.#now()).toISOString(),
        };
        await Effect.runPromise(
          this.#receipts.advance({
            operationId,
            expectedRevision: current.revision,
            stage: nextStage,
            changes: {
              readiness: evidence,
              ...(checkpoint === undefined ? {} : { migrationCheckpoint: checkpoint }),
              rollbackAttempted: nextStage === "rollback-ready",
              owner,
            },
          }),
        );
        this.#recordRestrictedReady();
        return evidence;
      },
      catch: error,
    });
  }

  readonly readCandidateReadiness = (operationId: string, priorDaemonInstanceId: string) =>
    this.#receipts
      .read(operationId)
      .pipe(
        Effect.flatMap((receipt) =>
          receipt === undefined
            ? Effect.fail(
                new LifecycleError(
                  "UPGRADE_RECEIPT_NOT_FOUND",
                  "the upgrade receipt was not found",
                ),
              )
            : this.#readiness(operationId, receipt.candidateReleaseId, priorDaemonInstanceId),
        ),
      );

  #finish(
    operationId: string,
    readiness: UpgradeReadinessEvidence,
    rollback: boolean,
  ): Effect.Effect<LifecycleRecordedOwner, LifecycleError> {
    const api = this;
    return Effect.gen(function* () {
      let receipt = yield* api.#receipts.read(operationId);
      if (
        receipt === undefined ||
        JSON.stringify(receipt.readiness) !== JSON.stringify(readiness)
      ) {
        return yield* Effect.fail(
          new LifecycleError(
            "UPGRADE_READINESS_MISMATCH",
            "activation does not name the candidate-ready database evidence",
          ),
        );
      }
      const expectedStage = rollback ? "rollback-ready" : "candidate-ready";
      const terminalStage = rollback ? "rolled-back" : "activation-authorized";
      if (receipt.stage === expectedStage) {
        receipt = yield* api.#receipts.advance({
          operationId,
          expectedRevision: receipt.revision,
          stage: terminalStage,
          changes: { owner: api.#owner() },
        });
      }
      yield* api.#activate;
      yield* api.#runs.releaseDaemonDispatch().pipe(Effect.mapError(error));
      yield* api.#mutations.release(operationId);
      if (receipt.dispatchHeld || receipt.mutationsHeld) {
        yield* api.#receipts.advance({
          operationId,
          expectedRevision: receipt.revision,
          stage: terminalStage,
          changes: { dispatchHeld: false, mutationsHeld: false, owner: api.#owner() },
        });
      }
      return api.#owner();
    });
  }

  readonly authorizeActivation = (operationId: string, readiness: UpgradeReadinessEvidence) =>
    this.#finish(operationId, readiness, false);

  readonly inspectRollbackSafety = (
    operationId: string,
    sourceReleaseId: string,
  ): Effect.Effect<UpgradeRollbackSafety, LifecycleError> => {
    const api = this;
    return Effect.gen(function* () {
      const receipt = yield* api.#receipts.read(operationId);
      if (receipt === undefined || receipt.sourceReleaseId !== sourceReleaseId) {
        return yield* Effect.fail(
          new LifecycleError(
            "UPGRADE_ROLLBACK_TARGET_CHANGED",
            "rollback must name the release active when the operation started",
          ),
        );
      }
      const dataFormat = api.#dataFormat();
      const source = api.#manifest(sourceReleaseId);
      const owner = api.#owner();
      const executionStopped = owner.runnerInstanceIds.length === 0;
      const compatible = source.compatibility.dataFormats.includes(dataFormat);
      return {
        safe: compatible && executionStopped,
        sourceReleaseId,
        dataVersion: digest({
          dataFormat,
          receiptRevision: receipt.revision,
          wakeupDigest: api.#wakeupDigest(),
          owner,
        }),
        executionStopped,
        detail: compatible
          ? executionStopped
            ? "the exact source release can read current data with execution stopped"
            : "candidate-owned execution is not stopped"
          : `the exact source release cannot read current data format ${dataFormat}`,
      };
    });
  };

  readonly readRollbackReadiness = (operationId: string) =>
    this.#receipts
      .read(operationId)
      .pipe(
        Effect.flatMap((receipt) =>
          receipt === undefined
            ? Effect.fail(
                new LifecycleError(
                  "UPGRADE_RECEIPT_NOT_FOUND",
                  "the upgrade receipt was not found",
                ),
              )
            : this.#readiness(operationId, receipt.sourceReleaseId),
        ),
      );

  readonly authorizeRollback = (operationId: string, readiness: UpgradeReadinessEvidence) =>
    this.#finish(operationId, readiness, true);
}
