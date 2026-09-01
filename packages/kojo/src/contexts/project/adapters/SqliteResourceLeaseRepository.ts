import type { Database } from "bun:sqlite";
import { Effect } from "effect";
import type {
  ResourceAcquisitionIntent,
  ResourceKind,
  ResourceLease,
  ResourceLeaseAuthority,
  ResourceLeaseState,
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
  readonly locator: string | null;
  readonly acquired_at: string | null;
  readonly release_requested_at: string | null;
  readonly released_at: string | null;
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
  ...(row.provider_identity === null ? {} : { providerIdentity: row.provider_identity }),
  ...(row.locator === null ? {} : { locator: row.locator }),
  ...(row.acquired_at === null ? {} : { acquiredAt: row.acquired_at }),
  ...(row.release_requested_at === null ? {} : { releaseRequestedAt: row.release_requested_at }),
  ...(row.released_at === null ? {} : { releasedAt: row.released_at }),
  ...(row.evidence === null ? {} : { evidence: row.evidence }),
  ...(row.reason === null ? {} : { reason: row.reason }),
});

const selectedColumns = `lease_id, project_id, run_id, revision_id, runner_instance_id,
  claim_generation, resource_kind, acquisition_key, state, requested_at, detail_json,
  provider_identity, locator, acquired_at, release_requested_at, released_at, evidence, reason`;

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
        provider_identity TEXT,
        locator TEXT,
        acquired_at TEXT,
        release_requested_at TEXT,
        released_at TEXT,
        evidence TEXT,
        reason TEXT,
        UNIQUE(project_id, run_id, acquisition_key),
        FOREIGN KEY (project_id) REFERENCES projects(project_id),
        FOREIGN KEY (run_id) REFERENCES workflow_runs(run_id)
      ) STRICT
    `);
    database.run(
      "CREATE INDEX IF NOT EXISTS project_resource_leases_project_state ON project_resource_leases(project_id, state)",
    );
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

  #transition(options: {
    readonly authority: ResourceLeaseAuthority;
    readonly leaseId: string;
    readonly allowed: ReadonlyArray<ResourceLeaseState>;
    readonly state: ResourceLeaseState;
    readonly update: string;
    readonly values: ReadonlyArray<number | string | null>;
  }): ResourceLease {
    return this.#database.transaction(() => {
      const row = this.#authorized(options.authority, options.leaseId);
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
            if (!same) {
              throw new ResourceStoreError({
                code: "RESOURCE_STATE_CONFLICT",
                message: `Resource lease ${intent.leaseId} already names different acquisition content.`,
                cause: undefined,
              });
            }
            return leaseOf(prior);
          }
          this.#database.run(
            `INSERT INTO project_resource_leases (
              lease_id, project_id, run_id, revision_id, runner_instance_id, claim_generation,
              resource_kind, acquisition_key, state, requested_at, detail_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'acquisition-intent', ?, ?)`,
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
        }),
      catch: failed,
    });

  readonly preserve = (
    authority: ResourceLeaseAuthority,
    leaseId: string,
    _observedAt: string,
    reason: string,
  ): Effect.Effect<ResourceLease, ResourceStoreError> =>
    Effect.try({
      try: () =>
        this.#transition({
          authority,
          leaseId,
          allowed: ["acquired", "release-intent"],
          state: "preserved",
          update: "reason = ?",
          values: [reason],
        }),
      catch: failed,
    });

  readonly unresolved = (
    authority: ResourceLeaseAuthority,
    leaseId: string,
    _observedAt: string,
    reason: string,
  ): Effect.Effect<ResourceLease, ResourceStoreError> =>
    Effect.try({
      try: () =>
        this.#transition({
          authority,
          leaseId,
          allowed: ["acquisition-intent", "acquired", "release-intent"],
          state: "unresolved",
          update: "reason = ?",
          values: [reason],
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
}
