import type { Database } from "bun:sqlite";
import { Buffer } from "node:buffer";
import type { MutationEnvelope } from "@carere/kojo-client-contracts/contexts/client/contracts/mutation";
import type { JsonValue } from "@carere/kojo-client-contracts/contexts/shared/codecs/json";
import { Effect } from "effect";
import type { SqliteRevisionRepository } from "../../workflow/adapters/SqliteRevisionRepository.ts";
import type { RevisionFault } from "../../workflow/models/RevisionMaintenance.ts";
import { LifecycleError } from "../models/LifecycleError.ts";
import type {
  NoRollbackPlan,
  UpgradeCheckReport,
  UpgradeCheckResult,
  UpgradeEvidence,
  UpgradeRequirement,
  UpgradeRevisionEvidence,
} from "../models/ManagedUpgrade.ts";
import { decodeUpgradeCheckReport } from "../models/ManagedUpgrade.ts";
import type { OperationRepository } from "../ports/OperationRepository.ts";
import type {
  IssueNoRollbackPlan,
  UpgradePreflightRepository,
} from "../ports/UpgradePreflightRepository.ts";

interface WorkflowRow {
  readonly project_id: string;
  readonly workflow_name: string;
  readonly availability: string;
  readonly current_revision_id: string | null;
  readonly source_fault: string | null;
  readonly remedy: string | null;
}

interface RunRow {
  readonly run_id: string;
  readonly revision_id: string;
  readonly state: string;
}

interface RefRow {
  readonly revision_id: string;
  readonly owner_id: string;
}

interface ReaderRow {
  readonly reader_id: string;
  readonly reader_kind: "active" | "loaded";
  readonly revision_id: string;
  readonly runner_instance_id: string | null;
}

interface PlanRow {
  readonly plan_json: string;
  readonly token_hash: string;
}

const sha256 = (value: string): string =>
  new Bun.CryptoHasher("sha256").update(value).digest("hex");

const randomSecret = (): string =>
  Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");

const failed = (cause: unknown): LifecycleError =>
  cause instanceof LifecycleError
    ? cause
    : new LifecycleError(
        "UPGRADE_PREFLIGHT_FAILED",
        cause instanceof Error ? cause.message : String(cause),
        cause,
      );

const planOf = (json: string): NoRollbackPlan => {
  const plan = JSON.parse(json) as Partial<NoRollbackPlan>;
  if (
    plan.formatVersion !== 1 ||
    typeof plan.planId !== "string" ||
    !/^[A-Za-z0-9_-]+$/.test(plan.planId) ||
    plan.kind !== "approve-no-rollback" ||
    typeof plan.dataIdentity !== "string" ||
    typeof plan.candidateReleaseId !== "string" ||
    typeof plan.requestHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(plan.requestHash) ||
    !Array.isArray(plan.affectedScope) ||
    !plan.affectedScope.every((entry) => typeof entry === "string") ||
    typeof plan.expectedStateVersion !== "string" ||
    !/^[a-f0-9]{64}$/.test(plan.expectedStateVersion) ||
    typeof plan.issuedAt !== "string" ||
    !Number.isFinite(Date.parse(plan.issuedAt)) ||
    typeof plan.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(plan.expiresAt)) ||
    plan.migration === undefined ||
    !Number.isSafeInteger(plan.migration.fromDataFormat) ||
    !Number.isSafeInteger(plan.migration.toDataFormat) ||
    typeof plan.migration.description !== "string" ||
    (plan.approvedAt !== undefined && !Number.isFinite(Date.parse(plan.approvedAt)))
  ) {
    throw new LifecycleError(
      "NO_ROLLBACK_PLAN_DAMAGED",
      "the retained no-rollback plan is invalid",
    );
  }
  return plan as NoRollbackPlan;
};

export class SqliteUpgradePreflightRepository implements UpgradePreflightRepository {
  readonly #database: Database;
  readonly #dataIdentity: string;
  readonly #revisions: SqliteRevisionRepository;
  readonly #operations: OperationRepository | undefined;
  readonly latest: Effect.Effect<UpgradeCheckReport | undefined, LifecycleError>;

  constructor(
    database: Database,
    dataIdentity: string,
    revisions: SqliteRevisionRepository,
    operations?: OperationRepository,
  ) {
    this.#database = database;
    this.#dataIdentity = dataIdentity;
    this.#revisions = revisions;
    this.#operations = operations;
    database.run(
      "INSERT OR IGNORE INTO daemon_metadata (name, value) VALUES ('data_format_version', '1')",
    );
    database.run(`CREATE TABLE IF NOT EXISTS daemon_upgrade_plans (
      plan_id TEXT PRIMARY KEY NOT NULL,
      data_identity TEXT NOT NULL,
      candidate_release_id TEXT NOT NULL,
      expected_state_version TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      plan_json TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      approved_at TEXT
    ) STRICT`);
    database.run(`CREATE TABLE IF NOT EXISTS daemon_upgrade_check (
      singleton INTEGER PRIMARY KEY NOT NULL CHECK(singleton = 1),
      report_json TEXT NOT NULL
    ) STRICT`);
    this.latest = Effect.try({
      try: () => {
        const row = this.#database
          .query<{ readonly report_json: string }, []>(
            "SELECT report_json FROM daemon_upgrade_check WHERE singleton = 1",
          )
          .get();
        return row === null
          ? undefined
          : decodeUpgradeCheckReport(JSON.parse(row.report_json) as unknown);
      },
      catch: failed,
    });
  }

  readonly capture = (_observedAt: string): Effect.Effect<UpgradeEvidence, LifecycleError> => {
    const repository = this;
    return Effect.gen(function* () {
      const base = yield* Effect.try({
        try: () => {
          const dataFormatText = repository.#database
            .query<{ readonly value: string }, []>(
              "SELECT value FROM daemon_metadata WHERE name = 'data_format_version'",
            )
            .get()?.value;
          const dataFormat = Number(dataFormatText);
          if (!Number.isSafeInteger(dataFormat) || dataFormat < 1) {
            throw new LifecycleError(
              "DAEMON_DATA_FORMAT_UNKNOWN",
              "the recorded Daemon data format is invalid",
            );
          }
          const workflows = repository.#database
            .query<WorkflowRow, []>(
              `SELECT project_id, workflow_name, availability, current_revision_id,
                      source_fault, remedy
                 FROM project_workflows
                WHERE availability != 'removed'
                ORDER BY project_id, workflow_name`,
            )
            .all();
          const runs = repository.#database
            .query<RunRow, []>(
              "SELECT run_id, revision_id, state FROM workflow_runs ORDER BY admission_sequence, run_id",
            )
            .all();
          const refs = repository.#database
            .query<RefRow, []>(
              `SELECT revision_id, owner_id FROM workflow_revision_refs
                WHERE owner_kind = 'validation' ORDER BY revision_id, owner_id`,
            )
            .all();
          const readers = repository.#database
            .query<ReaderRow, []>(
              `SELECT reader_id, reader_kind, revision_id, runner_instance_id
                 FROM workflow_readers WHERE released_at IS NULL
                ORDER BY revision_id, reader_id`,
            )
            .all();
          const requirements: UpgradeRequirement[] = [
            ...workflows.flatMap((row) =>
              row.current_revision_id === null
                ? []
                : [
                    {
                      kind: "current-workflow" as const,
                      ownerId: JSON.stringify([row.project_id, row.workflow_name]),
                      revisionId: row.current_revision_id,
                      state: row.availability,
                    },
                  ],
            ),
            ...runs.map((row) => ({
              kind: "retained-run" as const,
              ownerId: row.run_id,
              revisionId: row.revision_id,
              state: row.state,
            })),
            ...refs.map((row) => ({
              kind: "validation" as const,
              ownerId: row.owner_id,
              revisionId: row.revision_id,
            })),
            ...readers.map((row) => ({
              kind:
                row.reader_kind === "loaded"
                  ? ("loaded-registration" as const)
                  : ("active-reader" as const),
              ownerId:
                row.reader_kind === "loaded"
                  ? (row.runner_instance_id ?? row.reader_id)
                  : row.reader_id,
              revisionId: row.revision_id,
            })),
          ].sort((left, right) =>
            JSON.stringify([left.revisionId, left.kind, left.ownerId]).localeCompare(
              JSON.stringify([right.revisionId, right.kind, right.ownerId]),
            ),
          );
          return {
            dataFormat,
            requirements,
            currentWorkflowFaults: workflows.flatMap((row) =>
              row.availability === "available" && row.current_revision_id !== null
                ? []
                : [
                    {
                      ownerId: JSON.stringify([row.project_id, row.workflow_name]),
                      detail:
                        row.source_fault ??
                        (row.current_revision_id === null
                          ? "the current Workflow has no exact retained revision"
                          : "the current Workflow is invalid"),
                      remedy: row.remedy ?? "Repair the current Workflow source and refresh it.",
                    },
                  ],
            ),
          };
        },
        catch: failed,
      });
      const revisionIds = [...new Set(base.requirements.map((entry) => entry.revisionId))].sort();
      const revisions: UpgradeRevisionEvidence[] = [];
      for (const revisionId of revisionIds) {
        const inspected = yield* repository.#revisions.inspectForPreflight(revisionId).pipe(
          Effect.map(
            (revision): UpgradeRevisionEvidence => ({
              revisionId,
              packageGraphId: revision.packageGraphId,
              manifest: revision.manifest,
              faults: revision.faults,
            }),
          ),
          Effect.catch((cause) =>
            Effect.succeed({
              revisionId,
              faults: [] as ReadonlyArray<RevisionFault>,
              inspectionFault: cause.message,
            }),
          ),
        );
        revisions.push(inspected);
      }
      const retainedSetHash = sha256(
        JSON.stringify({
          dataFormat: base.dataFormat,
          requirements: base.requirements,
          currentWorkflowFaults: base.currentWorkflowFaults,
          revisions,
        }),
      );
      return {
        dataIdentity: repository.#dataIdentity,
        dataFormat: base.dataFormat,
        retainedSetHash,
        requirements: base.requirements,
        revisions,
        currentWorkflowFaults: base.currentWorkflowFaults,
      };
    }).pipe(Effect.mapError(failed));
  };

  readonly issueNoRollbackPlan = (
    request: IssueNoRollbackPlan,
  ): Effect.Effect<{ readonly plan: NoRollbackPlan; readonly token?: string }, LifecycleError> =>
    Effect.try({
      try: () =>
        this.#database
          .transaction(() => {
            const existing = this.#database
              .query<PlanRow, [string, string, string]>(
                `SELECT plan_json, token_hash FROM daemon_upgrade_plans
                  WHERE data_identity = ? AND candidate_release_id = ?
                    AND expected_state_version = ?
                  ORDER BY approved_at IS NOT NULL DESC, expires_at DESC LIMIT 1`,
              )
              .get(request.dataIdentity, request.candidateReleaseId, request.expectedStateVersion);
            if (existing !== null) {
              const plan = planOf(existing.plan_json);
              if (
                plan.requestHash === request.requestHash &&
                JSON.stringify(plan.affectedScope) === JSON.stringify(request.affectedScope) &&
                JSON.stringify(plan.migration) === JSON.stringify(request.migration) &&
                plan.approvedAt !== undefined
              ) {
                return { plan };
              }
            }
            const planId = crypto.randomUUID();
            const secret = randomSecret();
            const token = `${planId}.${secret}`;
            const plan: NoRollbackPlan = {
              formatVersion: 1,
              planId,
              kind: "approve-no-rollback",
              dataIdentity: request.dataIdentity,
              candidateReleaseId: request.candidateReleaseId,
              requestHash: request.requestHash,
              affectedScope: request.affectedScope,
              expectedStateVersion: request.expectedStateVersion,
              issuedAt: request.issuedAt,
              expiresAt: request.expiresAt,
              migration: request.migration,
            };
            this.#database.run(
              `INSERT INTO daemon_upgrade_plans
                 (plan_id, data_identity, candidate_release_id, expected_state_version,
                  token_hash, plan_json, expires_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
              [
                planId,
                request.dataIdentity,
                request.candidateReleaseId,
                request.expectedStateVersion,
                sha256(token),
                JSON.stringify(plan),
                request.expiresAt,
              ],
            );
            return { plan, token };
          })
          .immediate(),
      catch: failed,
    });

  readonly approveNoRollbackPlan = (request: {
    readonly token: string;
    readonly dataIdentity: string;
    readonly candidateReleaseId: string;
    readonly expectedStateVersion: string;
    readonly approvedAt: string;
  }): Effect.Effect<NoRollbackPlan, LifecycleError> =>
    Effect.try({
      try: () =>
        this.#database
          .transaction(() => {
            const row = this.#database
              .query<PlanRow, [string]>(
                "SELECT plan_json, token_hash FROM daemon_upgrade_plans WHERE token_hash = ?",
              )
              .get(sha256(request.token));
            if (row === null) {
              throw new LifecycleError(
                "NO_ROLLBACK_PLAN_NOT_FOUND",
                "the no-rollback plan token is not valid",
              );
            }
            const plan = planOf(row.plan_json);
            if (
              plan.dataIdentity !== request.dataIdentity ||
              plan.candidateReleaseId !== request.candidateReleaseId ||
              plan.expectedStateVersion !== request.expectedStateVersion
            ) {
              throw new LifecycleError(
                "NO_ROLLBACK_PLAN_STALE",
                "the no-rollback plan expired or the relevant Daemon state changed",
              );
            }
            if (plan.approvedAt !== undefined) return plan;
            if (Date.parse(plan.expiresAt) <= Date.parse(request.approvedAt)) {
              throw new LifecycleError(
                "NO_ROLLBACK_PLAN_STALE",
                "the no-rollback plan expired or the relevant Daemon state changed",
              );
            }
            const approved = { ...plan, approvedAt: request.approvedAt };
            this.#database.run(
              "UPDATE daemon_upgrade_plans SET plan_json = ?, approved_at = ? WHERE token_hash = ?",
              [JSON.stringify(approved), request.approvedAt, sha256(request.token)],
            );
            return approved;
          })
          .immediate(),
      catch: failed,
    });

  readonly record = (
    report: UpgradeCheckReport,
    mutation?: MutationEnvelope,
    result?: UpgradeCheckResult,
  ): Effect.Effect<void, LifecycleError> =>
    Effect.try({
      try: () =>
        this.#database
          .transaction(() => {
            this.#database.run(
              `INSERT INTO daemon_upgrade_check (singleton, report_json) VALUES (1, ?)
           ON CONFLICT(singleton) DO UPDATE SET report_json = excluded.report_json`,
              [JSON.stringify(report)],
            );
            if (mutation !== undefined)
              this.#operations?.record(
                mutation,
                {
                  receiptVersion: 1,
                  requestId: mutation.requestId,
                  dataIdentity: mutation.dataIdentity,
                  operation: mutation.operation,
                  status: "committed",
                  result: (result ?? { report }) as unknown as JsonValue,
                },
                report.checkedAt,
              );
          })
          .immediate(),
      catch: failed,
    });
}
