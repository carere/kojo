import type { Database } from "bun:sqlite";
import { Effect } from "effect";
import type {
  ResourceAcquisitionIntent,
  ResourceKind,
  ResourceLease,
  ResourceLeaseAuthority,
  ResourceLeaseState,
  ResourceRecoveryAuthority,
  ResourceRecoveryObservation,
} from "../models/ResourceLease.ts";
import { ResourceStoreError } from "../models/ResourceStoreError.ts";

interface ResourceLeaseRow {
  readonly lease_id: string;
  readonly project_id: string;
  readonly run_id: string;
  readonly revision_id: string;
  readonly runner_instance_id: string;
  readonly claim_generation: number;
  readonly resource_kind: ResourceKind;
  readonly acquisition_key: string;
  readonly state: ResourceLeaseState;
  readonly requested_at: string;
  readonly detail_json: string;
  readonly provider_identity: string | null;
  readonly inspection_locator: string;
  readonly planned_provider_locator: string | null;
  readonly locator: string | null;
  readonly acquired_at: string | null;
  readonly release_requested_at: string | null;
  readonly released_at: string | null;
  readonly observed_at: string | null;
  readonly evidence: string | null;
  readonly reason: string | null;
}

const failed = (cause: unknown): ResourceStoreError =>
  cause instanceof ResourceStoreError
    ? cause
    : new ResourceStoreError({
        code: "RESOURCE_STORE_FAILED",
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      });

const leaseOf = (row: ResourceLeaseRow): ResourceLease => ({
  leaseId: row.lease_id,
  projectId: row.project_id,
  runId: row.run_id,
  revisionId: row.revision_id,
  runnerInstanceId: row.runner_instance_id,
  claimGeneration: row.claim_generation,
  kind: row.resource_kind,
  acquisitionKey: row.acquisition_key,
  state: row.state,
  requestedAt: row.requested_at,
  detail: JSON.parse(row.detail_json) as Readonly<Record<string, string>>,
  providerIdentity: row.provider_identity ?? "",
  inspectionLocator: row.inspection_locator,
  ...(row.planned_provider_locator === null
    ? {}
    : { providerLocator: row.planned_provider_locator }),
  ...(row.locator === null ? {} : { locator: row.locator }),
  ...(row.acquired_at === null ? {} : { acquiredAt: row.acquired_at }),
  ...(row.release_requested_at === null ? {} : { releaseRequestedAt: row.release_requested_at }),
  ...(row.released_at === null ? {} : { releasedAt: row.released_at }),
  ...(row.observed_at === null ? {} : { observedAt: row.observed_at }),
  ...(row.evidence === null ? {} : { evidence: row.evidence }),
  ...(row.reason === null ? {} : { reason: row.reason }),
});

const selectedColumns = `lease_id, project_id, run_id, revision_id, runner_instance_id,
  claim_generation, resource_kind, acquisition_key, state, requested_at, detail_json,
  provider_identity, inspection_locator, planned_provider_locator, locator, acquired_at,
  release_requested_at, released_at, observed_at, evidence, reason`;

/** Daemon-owned durable Resource leases for Project execution. */
export class SqliteResourceLeaseRepository {
  readonly #database: Database;

  constructor(database: Database) {
    this.#database = database;
    database.run(`
      CREATE TABLE IF NOT EXISTS project_resource_leases (
        lease_id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        revision_id TEXT NOT NULL,
        runner_instance_id TEXT NOT NULL,
        claim_generation INTEGER NOT NULL CHECK(claim_generation > 0),
        resource_kind TEXT NOT NULL CHECK(resource_kind IN ('sandbox', 'worktree', 'agent')),
        acquisition_key TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN (
          'acquisition-intent', 'acquired', 'release-intent', 'released', 'preserved', 'unresolved'
        )),
        requested_at TEXT NOT NULL,
        detail_json TEXT NOT NULL,
        provider_identity TEXT NOT NULL,
        inspection_locator TEXT NOT NULL,
        planned_provider_locator TEXT,
        locator TEXT,
        acquired_at TEXT,
        release_requested_at TEXT,
        released_at TEXT,
        observed_at TEXT,
        evidence TEXT,
        reason TEXT,
        UNIQUE(project_id, run_id, acquisition_key),
        FOREIGN KEY (project_id) REFERENCES projects(project_id),
        FOREIGN KEY (run_id) REFERENCES workflow_runs(run_id)
      ) STRICT
    `);
    const columns = database
      .query<{ readonly name: string }, []>("PRAGMA table_info(project_resource_leases)")
      .all();
    if (!columns.some((column) => column.name === "observed_at")) {
      database.run("ALTER TABLE project_resource_leases ADD COLUMN observed_at TEXT");
    }
    database.run(
      "CREATE INDEX IF NOT EXISTS project_resource_leases_project_state ON project_resource_leases(project_id, state)",
    );
    database.run(`
      CREATE TABLE IF NOT EXISTS project_runner_termination_proofs (
        project_id TEXT NOT NULL,
        runner_instance_id TEXT NOT NULL,
        confirmed_at TEXT NOT NULL,
        PRIMARY KEY (project_id, runner_instance_id),
        FOREIGN KEY (project_id) REFERENCES projects(project_id)
      ) STRICT
    `);
  }

  #read(leaseId: string): ResourceLeaseRow | undefined {
    return (
      this.#database
        .query<ResourceLeaseRow, [string]>(
          `SELECT ${selectedColumns} FROM project_resource_leases WHERE lease_id = ?`,
        )
        .get(leaseId) ?? undefined
    );
  }

  #inspect(projectId: string, runId: string, acquisitionKey: string): ResourceLeaseRow | undefined {
    return (
      this.#database
        .query<ResourceLeaseRow, [string, string, string]>(
          `SELECT ${selectedColumns} FROM project_resource_leases
            WHERE project_id = ? AND run_id = ? AND acquisition_key = ?`,
        )
        .get(projectId, runId, acquisitionKey) ?? undefined
    );
  }

  #authorized(authority: ResourceLeaseAuthority, leaseId: string): ResourceLeaseRow {
    const row = this.#read(leaseId);
    if (
      row === undefined ||
      row.project_id !== authority.projectId ||
      row.run_id !== authority.runId ||
      row.revision_id !== authority.revisionId ||
      row.runner_instance_id !== authority.runnerInstanceId ||
      row.claim_generation !== authority.claimGeneration
    ) {
      throw new ResourceStoreError({
        code: "RESOURCE_AUTHORITY_LOST",
        message: "The Project Runner does not hold this Resource lease authority.",
        cause: undefined,
      });
    }
    return row;
  }

  #assertRecoveryAuthority(authority: ResourceRecoveryAuthority): void {
    const proof = this.#database
      .query<{ readonly confirmed_at: string }, [string, string]>(
        `SELECT confirmed_at FROM project_runner_termination_proofs
          WHERE project_id = ? AND runner_instance_id = ?`,
      )
      .get(authority.projectId, authority.priorRunnerInstanceId);
    if (proof?.confirmed_at !== authority.terminationConfirmedAt) {
      throw new ResourceStoreError({
        code: "RESOURCE_AUTHORITY_LOST",
        message: "Resource recovery needs durable proof for the terminated Project Runner.",
        cause: undefined,
      });
    }
  }

  #transition(options: {
    readonly authority: ResourceLeaseAuthority;
    readonly leaseId: string;
    readonly allowed: ReadonlyArray<ResourceLeaseState>;
    readonly state: ResourceLeaseState;
    readonly update: string;
    readonly values: ReadonlyArray<number | string | null>;
    readonly validate?: (row: ResourceLeaseRow) => void;
  }): ResourceLease {
    return this.#database.transaction(() => {
      const row = this.#authorized(options.authority, options.leaseId);
      options.validate?.(row);
      if (row.state === options.state) return leaseOf(row);
      if (!options.allowed.includes(row.state)) {
        throw new ResourceStoreError({
          code: "RESOURCE_STATE_CONFLICT",
          message: `Resource lease ${options.leaseId} is ${row.state}, not ${options.allowed.join(" or ")}.`,
          cause: undefined,
        });
      }
      this.#database.run(
        `UPDATE project_resource_leases SET state = ?, ${options.update} WHERE lease_id = ?`,
        [options.state, ...options.values, options.leaseId],
      );
      return leaseOf(this.#authorized(options.authority, options.leaseId));
    })();
  }

  readonly beginAcquisition = (
    intent: ResourceAcquisitionIntent,
    allocation: {
      readonly providerIdentity: string;
      readonly inspectionLocator: string;
      readonly providerLocator?: string;
    },
  ): Effect.Effect<ResourceLease, ResourceStoreError> =>
    Effect.try({
      try: () =>
        this.#database.transaction(() => {
          const prior = this.#read(intent.leaseId);
          if (prior !== undefined) {
            const same =
              prior.project_id === intent.projectId &&
              prior.run_id === intent.runId &&
              prior.revision_id === intent.revisionId &&
              prior.runner_instance_id === intent.runnerInstanceId &&
              prior.claim_generation === intent.claimGeneration &&
              prior.resource_kind === intent.kind &&
              prior.acquisition_key === intent.acquisitionKey &&
              prior.requested_at === intent.requestedAt &&
              prior.detail_json === JSON.stringify(intent.detail);
            const sameAllocation =
              prior.provider_identity === allocation.providerIdentity &&
              prior.inspection_locator === allocation.inspectionLocator &&
              prior.planned_provider_locator === (allocation.providerLocator ?? null);
            if (!same || !sameAllocation) {
              throw new ResourceStoreError({
                code: "RESOURCE_STATE_CONFLICT",
                message: `Resource lease ${intent.leaseId} already names different acquisition content.`,
                cause: undefined,
              });
            }
            return leaseOf(prior);
          }
          const priorAcquisition = this.#inspect(
            intent.projectId,
            intent.runId,
            intent.acquisitionKey,
          );
          if (priorAcquisition !== undefined) {
            throw new ResourceStoreError({
              code: "RESOURCE_STATE_CONFLICT",
              message: `Acquisition key ${intent.acquisitionKey} already names lease ${priorAcquisition.lease_id}.`,
              cause: undefined,
            });
          }
          this.#database.run(
            `INSERT INTO project_resource_leases (
              lease_id, project_id, run_id, revision_id, runner_instance_id, claim_generation,
              resource_kind, acquisition_key, state, requested_at, detail_json, provider_identity,
              inspection_locator, planned_provider_locator
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'acquisition-intent', ?, ?, ?, ?, ?)`,
            [
              intent.leaseId,
              intent.projectId,
              intent.runId,
              intent.revisionId,
              intent.runnerInstanceId,
              intent.claimGeneration,
              intent.kind,
              intent.acquisitionKey,
              intent.requestedAt,
              JSON.stringify(intent.detail),
              allocation.providerIdentity,
              allocation.inspectionLocator,
              allocation.providerLocator ?? null,
            ],
          );
          return leaseOf(this.#read(intent.leaseId) as ResourceLeaseRow);
        })(),
      catch: failed,
    });

  readonly confirmAcquired = (
    authority: ResourceLeaseAuthority,
    leaseId: string,
    acquiredAt: string,
    evidence: { readonly providerIdentity: string; readonly locator: string },
  ): Effect.Effect<ResourceLease, ResourceStoreError> =>
    Effect.try({
      try: () =>
        this.#transition({
          authority,
          leaseId,
          allowed: ["acquisition-intent"],
          state: "acquired",
          update: "acquired_at = ?, provider_identity = ?, locator = ?, evidence = ?",
          values: [
            acquiredAt,
            evidence.providerIdentity,
            evidence.locator,
            "provider returned an acquisition identity",
          ],
          validate: (row) => {
            if (row.provider_identity !== evidence.providerIdentity) {
              throw new ResourceStoreError({
                code: "RESOURCE_STATE_CONFLICT",
                message: "The provider did not return the Daemon-owned acquisition identity.",
                cause: undefined,
              });
            }
            if (
              row.state === "acquired" &&
              (row.acquired_at !== acquiredAt || row.locator !== evidence.locator)
            ) {
              throw new ResourceStoreError({
                code: "RESOURCE_STATE_CONFLICT",
                message: "The acquired Resource retry names different evidence.",
                cause: undefined,
              });
            }
          },
        }),
      catch: failed,
    });

  readonly beginRelease = (
    authority: ResourceLeaseAuthority,
    leaseId: string,
    requestedAt: string,
  ): Effect.Effect<ResourceLease, ResourceStoreError> =>
    Effect.try({
      try: () =>
        this.#transition({
          authority,
          leaseId,
          allowed: ["acquired"],
          state: "release-intent",
          update: "release_requested_at = ?",
          values: [requestedAt],
          validate: (row) => {
            if (row.state === "release-intent" && row.release_requested_at !== requestedAt) {
              throw new ResourceStoreError({
                code: "RESOURCE_STATE_CONFLICT",
                message: "The release intent retry names a different timestamp.",
                cause: undefined,
              });
            }
          },
        }),
      catch: failed,
    });

  readonly confirmReleased = (
    authority: ResourceLeaseAuthority,
    leaseId: string,
    releasedAt: string,
    evidence: string,
  ): Effect.Effect<ResourceLease, ResourceStoreError> =>
    Effect.try({
      try: () =>
        this.#transition({
          authority,
          leaseId,
          allowed: ["release-intent"],
          state: "released",
          update: "released_at = ?, evidence = ?",
          values: [releasedAt, evidence],
          validate: (row) => {
            if (
              row.state === "released" &&
              (row.released_at !== releasedAt || row.evidence !== evidence)
            ) {
              throw new ResourceStoreError({
                code: "RESOURCE_STATE_CONFLICT",
                message: "The released Resource retry names different evidence.",
                cause: undefined,
              });
            }
          },
        }),
      catch: failed,
    });

  readonly preserve = (
    authority: ResourceLeaseAuthority,
    leaseId: string,
    observedAt: string,
    reason: string,
  ): Effect.Effect<ResourceLease, ResourceStoreError> =>
    Effect.try({
      try: () =>
        this.#transition({
          authority,
          leaseId,
          allowed: ["acquired", "release-intent"],
          state: "preserved",
          update: "observed_at = ?, reason = ?",
          values: [observedAt, reason],
          validate: (row) => {
            if (
              row.state === "preserved" &&
              (row.observed_at !== observedAt || row.reason !== reason)
            ) {
              throw new ResourceStoreError({
                code: "RESOURCE_STATE_CONFLICT",
                message: "The preserved Resource retry names different evidence.",
                cause: undefined,
              });
            }
          },
        }),
      catch: failed,
    });

  readonly unresolved = (
    authority: ResourceLeaseAuthority,
    leaseId: string,
    observedAt: string,
    reason: string,
  ): Effect.Effect<ResourceLease, ResourceStoreError> =>
    Effect.try({
      try: () =>
        this.#transition({
          authority,
          leaseId,
          allowed: ["acquisition-intent", "acquired", "release-intent"],
          state: "unresolved",
          update: "observed_at = ?, reason = ?",
          values: [observedAt, reason],
          validate: (row) => {
            if (
              row.state === "unresolved" &&
              (row.observed_at !== observedAt || row.reason !== reason)
            ) {
              throw new ResourceStoreError({
                code: "RESOURCE_STATE_CONFLICT",
                message: "The unresolved Resource retry names different evidence.",
                cause: undefined,
              });
            }
          },
        }),
      catch: failed,
    });

  readonly byRun = (
    runId: string,
  ): Effect.Effect<ReadonlyArray<ResourceLease>, ResourceStoreError> =>
    Effect.try({
      try: () =>
        this.#database
          .query<ResourceLeaseRow, [string]>(
            `SELECT ${selectedColumns} FROM project_resource_leases WHERE run_id = ? ORDER BY requested_at, lease_id`,
          )
          .all(runId)
          .map(leaseOf),
      catch: failed,
    });

  readonly byProject = (
    projectId: string,
  ): Effect.Effect<ReadonlyArray<ResourceLease>, ResourceStoreError> =>
    Effect.try({
      try: () =>
        this.#database
          .query<ResourceLeaseRow, [string]>(
            `SELECT ${selectedColumns} FROM project_resource_leases WHERE project_id = ? ORDER BY requested_at, lease_id`,
          )
          .all(projectId)
          .map(leaseOf),
      catch: failed,
    });

  readonly inspectAcquisition = (
    projectId: string,
    runId: string,
    acquisitionKey: string,
  ): Effect.Effect<ResourceLease | undefined, ResourceStoreError> =>
    Effect.try({
      try: () => {
        const row = this.#inspect(projectId, runId, acquisitionKey);
        return row === undefined ? undefined : leaseOf(row);
      },
      catch: failed,
    });

  readonly confirmRunnerTermination = (
    authority: ResourceRecoveryAuthority,
  ): Effect.Effect<void, ResourceStoreError> =>
    Effect.try({
      try: () => {
        const prior = this.#database
          .query<{ readonly confirmed_at: string }, [string, string]>(
            `SELECT confirmed_at FROM project_runner_termination_proofs
              WHERE project_id = ? AND runner_instance_id = ?`,
          )
          .get(authority.projectId, authority.priorRunnerInstanceId);
        if (prior !== null && prior.confirmed_at !== authority.terminationConfirmedAt) {
          throw new ResourceStoreError({
            code: "RESOURCE_STATE_CONFLICT",
            message: "Project Runner termination proof already has different content.",
            cause: undefined,
          });
        }
        this.#database.run(
          `INSERT OR IGNORE INTO project_runner_termination_proofs
             (project_id, runner_instance_id, confirmed_at) VALUES (?, ?, ?)`,
          [authority.projectId, authority.priorRunnerInstanceId, authority.terminationConfirmedAt],
        );
      },
      catch: failed,
    });

  readonly pendingForTerminatedRunner = (
    authority: ResourceRecoveryAuthority,
    limit: number,
  ): Effect.Effect<ReadonlyArray<ResourceLease>, ResourceStoreError> =>
    Effect.try({
      try: () => {
        this.#assertRecoveryAuthority(authority);
        if (!Number.isSafeInteger(limit) || limit < 1) {
          throw new ResourceStoreError({
            code: "RESOURCE_STATE_CONFLICT",
            message: "Resource recovery needs a positive bounded limit.",
            cause: undefined,
          });
        }
        const rows = this.#database
          .query<ResourceLeaseRow, [string, string, number]>(
            `SELECT ${selectedColumns} FROM project_resource_leases
              WHERE project_id = ? AND runner_instance_id = ?
                AND state != 'released'
              ORDER BY requested_at, lease_id LIMIT ?`,
          )
          .all(authority.projectId, authority.priorRunnerInstanceId, limit + 1);
        if (rows.length > limit) {
          throw new ResourceStoreError({
            code: "RESOURCE_STATE_CONFLICT",
            message: `Resource recovery exceeded its ${limit} lease bound.`,
            cause: undefined,
          });
        }
        return rows.map(leaseOf);
      },
      catch: failed,
    });

  readonly reconcileTerminatedRunner = (
    authority: ResourceRecoveryAuthority,
    observations: ReadonlyArray<ResourceRecoveryObservation>,
  ): Effect.Effect<ReadonlyArray<ResourceLease>, ResourceStoreError> =>
    Effect.try({
      try: () =>
        this.#database
          .transaction(() => {
            this.#assertRecoveryAuthority(authority);
            const seen = new Set<string>();
            const reconciled: Array<ResourceLease> = [];
            for (const observation of observations) {
              if (seen.has(observation.leaseId)) {
                throw new ResourceStoreError({
                  code: "RESOURCE_STATE_CONFLICT",
                  message: `Resource recovery repeated lease ${observation.leaseId}.`,
                  cause: undefined,
                });
              }
              seen.add(observation.leaseId);
              const row = this.#read(observation.leaseId);
              if (
                row === undefined ||
                row.project_id !== authority.projectId ||
                row.runner_instance_id !== authority.priorRunnerInstanceId
              ) {
                throw new ResourceStoreError({
                  code: "RESOURCE_AUTHORITY_LOST",
                  message: "Resource recovery does not name the terminated Project Runner.",
                  cause: undefined,
                });
              }
              if (
                row.state === "released" ||
                row.state === "preserved" ||
                row.state === "unresolved"
              ) {
                reconciled.push(leaseOf(row));
                continue;
              }
              this.#database.run(
                `UPDATE project_resource_leases
                  SET state = ?, observed_at = ?, reason = ?,
                      released_at = CASE WHEN ? = 'released' THEN ? ELSE released_at END,
                      evidence = CASE WHEN ? = 'released' THEN ? ELSE evidence END
                WHERE lease_id = ?`,
                [
                  observation.outcome,
                  authority.terminationConfirmedAt,
                  observation.reason,
                  observation.outcome,
                  authority.terminationConfirmedAt,
                  observation.outcome,
                  observation.reason,
                  observation.leaseId,
                ],
              );
              reconciled.push(leaseOf(this.#read(observation.leaseId) as ResourceLeaseRow));
            }
            return reconciled;
          })
          .immediate(),
      catch: failed,
    });
}
