import type { Database } from "bun:sqlite";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import type { MutationEnvelope } from "@carere/kojo-client-contracts/contexts/client/contracts/mutation";
import type { JsonValue } from "@carere/kojo-client-contracts/contexts/shared/codecs/json";
import { Effect } from "effect";
import type { OperationRepository } from "../../daemon/ports/OperationRepository.ts";
import type {
  CollectionResult,
  ReaderReleaseEvidence,
  RevisionDetails,
  RevisionFault,
  RevisionProtection,
  RevisionReader,
  RevisionReaderRequest,
} from "../models/RevisionMaintenance.ts";
import { RevisionMaintenanceError } from "../models/RevisionMaintenanceError.ts";
import type { RevisionFile, RevisionManifest } from "../models/RevisionManifest.ts";
import { canonicalJson, sha256Text } from "../services/canonicalJson.ts";

const COLLECTION_GRACE_MILLIS = 24 * 60 * 60 * 1_000;

interface RevisionRow {
  readonly revision_id: string;
  readonly package_graph_id: string;
  readonly manifest_json: string;
  readonly published_path: string;
}

interface ReaderRow {
  readonly reader_id: string;
  readonly reader_kind: "active" | "loaded";
  readonly runner_instance_id: string | null;
  readonly acquired_at: string;
}

interface CollectionRow {
  readonly state: "grace" | "collecting" | "collected";
  readonly eligible_at: string | null;
  readonly collected_at: string | null;
}

const failed = (cause: unknown): RevisionMaintenanceError =>
  cause instanceof RevisionMaintenanceError
    ? cause
    : new RevisionMaintenanceError({
        code: "REVISION_STORE_FAILED",
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      });

const collectionResultOf = (value: JsonValue): CollectionResult => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("The recorded revision collection result is damaged.");
  }
  const fields = value as { readonly [key: string]: JsonValue | undefined };
  const revisionId = fields.revisionId;
  const state = fields.state;
  const eligibleAt = fields.eligibleAt;
  const removedObjects = fields.removedObjects;
  if (
    typeof revisionId !== "string" ||
    (state !== "protected" && state !== "grace" && state !== "collected") ||
    (eligibleAt !== undefined && typeof eligibleAt !== "string") ||
    (removedObjects !== undefined && typeof removedObjects !== "number")
  ) {
    throw new Error("The recorded revision collection result is damaged.");
  }
  return {
    revisionId,
    state,
    ...(eligibleAt === undefined ? {} : { eligibleAt }),
    ...(removedObjects === undefined ? {} : { removedObjects }),
  };
};

const hash = (bytes: Uint8Array | string): string =>
  new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

const inside = (root: string, selected: string): boolean => {
  const child = relative(root, selected);
  return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
};

const syncDirectory = (path: string): void => {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
};

const fileEntries = (
  manifest: RevisionManifest,
): ReadonlyArray<{
  readonly retainedPath: string;
  readonly file: RevisionFile;
  readonly label: string;
}> => [
  ...manifest.sources.map((file) => ({
    retainedPath: join("factory", "sources", file.path),
    file,
    label: file.path,
  })),
  ...manifest.assets.map((file) => ({
    retainedPath: join("factory", "assets", file.path),
    file,
    label: file.path,
  })),
  ...manifest.sharedConfiguration.map((file) => ({
    retainedPath: join("factory", "shared", file.path),
    file,
    label: file.path,
  })),
  ...manifest.packages.flatMap((entry) =>
    entry.files.map((file) => ({
      retainedPath: join("packages", entry.packageId, file.path),
      file,
      label: `${entry.name}/${file.path}`,
    })),
  ),
];

/** Workflow-owned SQLite and filesystem adapter for exact revision retention. */
export class SqliteRevisionRepository {
  readonly #database: Database;
  readonly #dataRoot: string;
  readonly #operations: OperationRepository | undefined;

  constructor(database: Database, dataRoot: string, operations?: OperationRepository) {
    this.#database = database;
    this.#dataRoot = dataRoot;
    this.#operations = operations;
    database.run("PRAGMA foreign_keys = ON");
    database.run(`
      CREATE TABLE IF NOT EXISTS workflow_revision_refs (
        revision_id TEXT NOT NULL,
        owner_kind TEXT NOT NULL CHECK(owner_kind IN ('validation')),
        owner_id TEXT NOT NULL,
        protected_at TEXT NOT NULL,
        PRIMARY KEY (revision_id, owner_kind, owner_id),
        FOREIGN KEY (revision_id) REFERENCES workflow_revisions(revision_id)
      ) STRICT
    `);
    database.run(`
      CREATE TABLE IF NOT EXISTS workflow_readers (
        reader_id TEXT PRIMARY KEY NOT NULL,
        revision_id TEXT NOT NULL,
        reader_kind TEXT NOT NULL CHECK(reader_kind IN ('active', 'loaded')),
        runner_instance_id TEXT,
        acquired_at TEXT NOT NULL,
        released_at TEXT,
        release_evidence TEXT,
        CHECK(reader_kind = 'active' OR runner_instance_id IS NOT NULL),
        FOREIGN KEY (revision_id) REFERENCES workflow_revisions(revision_id)
      ) STRICT
    `);
    database.run(`
      CREATE TABLE IF NOT EXISTS workflow_revision_objects (
        revision_id TEXT NOT NULL,
        object_hash TEXT NOT NULL,
        PRIMARY KEY (revision_id, object_hash),
        FOREIGN KEY (revision_id) REFERENCES workflow_revisions(revision_id)
      ) STRICT
    `);
    database.run(`
      CREATE TABLE IF NOT EXISTS workflow_revision_collection (
        revision_id TEXT PRIMARY KEY NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('grace', 'collecting', 'collected')),
        eligible_at TEXT,
        collected_at TEXT,
        FOREIGN KEY (revision_id) REFERENCES workflow_revisions(revision_id)
      ) STRICT
    `);
    database.run(`
      CREATE TRIGGER IF NOT EXISTS workflow_reader_collection_guard
      BEFORE INSERT ON workflow_readers
      WHEN EXISTS (
        SELECT 1 FROM workflow_revision_collection c
         WHERE c.revision_id = NEW.revision_id AND c.state IN ('collecting', 'collected')
      )
      BEGIN SELECT RAISE(ABORT, 'revision collection excludes readers'); END
    `);
    database.run(`
      CREATE TRIGGER IF NOT EXISTS workflow_ref_collection_guard
      BEFORE INSERT ON workflow_revision_refs
      WHEN EXISTS (
        SELECT 1 FROM workflow_revision_collection c
         WHERE c.revision_id = NEW.revision_id AND c.state IN ('collecting', 'collected')
      )
      BEGIN SELECT RAISE(ABORT, 'revision collection excludes references'); END
    `);
    database.run(`
      CREATE TRIGGER IF NOT EXISTS workflow_run_collection_guard
      BEFORE INSERT ON workflow_runs
      WHEN EXISTS (
        SELECT 1 FROM workflow_revision_collection c
         WHERE c.revision_id = NEW.revision_id AND c.state IN ('collecting', 'collected')
      )
      BEGIN SELECT RAISE(ABORT, 'revision collection excludes admission'); END
    `);
    database.run(`
      CREATE TRIGGER IF NOT EXISTS workflow_current_collection_guard
      BEFORE UPDATE OF current_revision_id, availability ON project_workflows
      WHEN NEW.availability = 'available' AND NEW.current_revision_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM workflow_revision_collection c
         WHERE c.revision_id = NEW.current_revision_id AND c.state IN ('collecting', 'collected')
      )
      BEGIN SELECT RAISE(ABORT, 'revision collection excludes current workflow'); END
    `);
    database.run(`
      CREATE TRIGGER IF NOT EXISTS workflow_new_current_collection_guard
      BEFORE INSERT ON project_workflows
      WHEN NEW.availability = 'available' AND NEW.current_revision_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM workflow_revision_collection c
         WHERE c.revision_id = NEW.current_revision_id AND c.state IN ('collecting', 'collected')
      )
      BEGIN SELECT RAISE(ABORT, 'revision collection excludes current workflow'); END
    `);
    database.run(`
      CREATE TRIGGER IF NOT EXISTS workflow_publication_collection_guard
      BEFORE INSERT ON workflow_revisions
      WHEN EXISTS (SELECT 1 FROM workflow_revision_collection c WHERE c.state = 'collecting')
      BEGIN SELECT RAISE(ABORT, 'revision collection excludes publication'); END
    `);
    this.#indexObjects();
  }

  readonly details = (
    revisionId: string,
    observedAt: string,
  ): Effect.Effect<RevisionDetails, RevisionMaintenanceError> =>
    Effect.try({ try: () => this.#details(revisionId, observedAt), catch: failed });

  /** Read-only exact-content inspection for the Daemon upgrade preflight. */
  readonly inspectForPreflight = (
    revisionId: string,
  ): Effect.Effect<
    {
      readonly revisionId: string;
      readonly packageGraphId: string;
      readonly manifest: RevisionManifest;
      readonly faults: ReadonlyArray<RevisionFault>;
    },
    RevisionMaintenanceError
  > =>
    Effect.try({
      try: () => {
        const row = this.#revision(revisionId);
        const manifest = this.#manifest(row);
        return {
          revisionId,
          packageGraphId: row.package_graph_id,
          manifest,
          faults: this.#faults(row, manifest),
        };
      },
      catch: failed,
    });

  readonly protectValidation = (
    revisionId: string,
    validationId: string,
    protectedAt: string,
  ): Effect.Effect<void, RevisionMaintenanceError> =>
    Effect.try({
      try: () =>
        this.#database
          .transaction(() => {
            this.#revision(revisionId);
            this.#database.run(
              `INSERT OR IGNORE INTO workflow_revision_refs
                 (revision_id, owner_kind, owner_id, protected_at)
               VALUES (?, 'validation', ?, ?)`,
              [revisionId, validationId, protectedAt],
            );
            this.#resetGrace(revisionId);
          })
          .immediate(),
      catch: failed,
    });

  readonly releaseValidation = (
    revisionId: string,
    validationId: string,
    releasedAt: string,
  ): Effect.Effect<void, RevisionMaintenanceError> =>
    Effect.try({
      try: () =>
        this.#database
          .transaction(() => {
            this.#database.run(
              "DELETE FROM workflow_revision_refs WHERE revision_id = ? AND owner_kind = 'validation' AND owner_id = ?",
              [revisionId, validationId],
            );
            this.#startGraceWhenUnprotected(revisionId, releasedAt);
          })
          .immediate(),
      catch: failed,
    });

  readonly acquireReader = (
    request: RevisionReaderRequest,
  ): Effect.Effect<RevisionReader, RevisionMaintenanceError> =>
    Effect.try({
      try: () =>
        this.#database
          .transaction(() => {
            this.#revision(request.revisionId);
            const existing = this.#database
              .query<
                ReaderRow & { readonly revision_id: string; readonly released_at: string | null },
                [string]
              >("SELECT * FROM workflow_readers WHERE reader_id = ?")
              .get(request.readerId);
            if (existing !== null) {
              if (
                existing.revision_id !== request.revisionId ||
                existing.reader_kind !== request.kind ||
                existing.runner_instance_id !== (request.runnerInstanceId ?? null) ||
                existing.released_at !== null
              ) {
                throw new RevisionMaintenanceError({
                  code: "READER_CONFLICT",
                  message:
                    "the reader identity is already bound to different or released authority",
                });
              }
              return this.#readerOf(existing);
            }
            this.#database.run(
              `INSERT INTO workflow_readers
                 (reader_id, revision_id, reader_kind, runner_instance_id, acquired_at)
               VALUES (?, ?, ?, ?, ?)`,
              [
                request.readerId,
                request.revisionId,
                request.kind,
                request.runnerInstanceId ?? null,
                request.acquiredAt,
              ],
            );
            this.#resetGrace(request.revisionId);
            return {
              readerId: request.readerId,
              kind: request.kind,
              acquiredAt: request.acquiredAt,
              ...(request.runnerInstanceId === undefined
                ? {}
                : { runnerInstanceId: request.runnerInstanceId }),
            };
          })
          .immediate(),
      catch: failed,
    });

  readonly releaseReader = (
    readerId: string,
    evidence: ReaderReleaseEvidence,
  ): Effect.Effect<void, RevisionMaintenanceError> =>
    Effect.try({
      try: () =>
        this.#database
          .transaction(() => {
            const row = this.#database
              .query<
                ReaderRow & { readonly revision_id: string; readonly released_at: string | null },
                [string]
              >("SELECT * FROM workflow_readers WHERE reader_id = ?")
              .get(readerId);
            if (row === null) {
              throw new RevisionMaintenanceError({
                code: "READER_RELEASE_REFUSED",
                message: "the reader registration was not found",
              });
            }
            if (row.released_at !== null) return;
            if (
              evidence.kind === "process-exit" &&
              row.runner_instance_id !== evidence.runnerInstanceId
            ) {
              throw new RevisionMaintenanceError({
                code: "READER_RELEASE_REFUSED",
                message: "the confirmed process exit does not own this reader",
              });
            }
            this.#database.run(
              "UPDATE workflow_readers SET released_at = ?, release_evidence = ? WHERE reader_id = ?",
              [evidence.confirmedAt, evidence.kind, readerId],
            );
            this.#startGraceWhenUnprotected(row.revision_id, evidence.confirmedAt);
          })
          .immediate(),
      catch: failed,
    });

  readonly confirmProcessExit = (
    runnerInstanceId: string,
    confirmedAt: string,
  ): Effect.Effect<void, RevisionMaintenanceError> =>
    Effect.try({
      try: () =>
        this.#database
          .transaction(() => {
            const revisions = this.#database
              .query<{ readonly revision_id: string }, [string]>(
                `SELECT DISTINCT revision_id FROM workflow_readers
                  WHERE runner_instance_id = ? AND released_at IS NULL`,
              )
              .all(runnerInstanceId);
            this.#database.run(
              `UPDATE workflow_readers
                  SET released_at = ?, release_evidence = 'process-exit'
                WHERE runner_instance_id = ? AND released_at IS NULL`,
              [confirmedAt, runnerInstanceId],
            );
            for (const revision of revisions) {
              this.#startGraceWhenUnprotected(revision.revision_id, confirmedAt);
            }
          })
          .immediate(),
      catch: failed,
    });

  readonly repairExact = (
    revisionId: string,
    source: string,
    repairedAt: string,
    mutation?: MutationEnvelope,
  ): Effect.Effect<RevisionDetails, RevisionMaintenanceError> =>
    Effect.try({
      try: () => {
        this.#record(mutation, "accepted", { state: "repairing", revisionId }, repairedAt);
        this.#repairExact(revisionId, source);
        return this.#database
          .transaction(() => {
            const result = this.#details(revisionId, repairedAt);
            this.#record(mutation, "committed", result as unknown as JsonValue, repairedAt);
            return result;
          })
          .immediate();
      },
      catch: failed,
    });

  readonly collect = (
    revisionId: string,
    observedAt: string,
    mutation?: MutationEnvelope,
  ): Effect.Effect<CollectionResult, RevisionMaintenanceError> =>
    Effect.try({
      try: () => {
        const prior = mutation === undefined ? undefined : this.#operations?.readExact(mutation);
        if (prior?.status === "committed") {
          if (prior.result === undefined) {
            throw new Error("The recorded revision collection result is missing.");
          }
          return collectionResultOf(prior.result);
        }
        return this.#database
          .transaction(() => {
            const result = this.#collect(revisionId, observedAt);
            this.#record(mutation, "committed", result as unknown as JsonValue, observedAt);
            return result;
          })
          .immediate();
      },
      catch: failed,
    });

  #record(
    mutation: MutationEnvelope | undefined,
    status: "accepted" | "committed",
    result: JsonValue,
    at: string,
  ): void {
    if (mutation === undefined) return;
    this.#operations?.record(
      mutation,
      {
        receiptVersion: 1,
        requestId: mutation.requestId,
        dataIdentity: mutation.dataIdentity,
        operation: mutation.operation,
        status,
        result,
      },
      at,
    );
  }

  #revision(revisionId: string): RevisionRow {
    const row = this.#database
      .query<RevisionRow, [string]>("SELECT * FROM workflow_revisions WHERE revision_id = ?")
      .get(revisionId);
    if (row === null) {
      throw new RevisionMaintenanceError({
        code: "REVISION_NOT_FOUND",
        message: `Workflow Revision ${revisionId} was not found`,
      });
    }
    return row;
  }

  #manifest(row: RevisionRow): RevisionManifest {
    return JSON.parse(row.manifest_json) as RevisionManifest;
  }

  #indexObjects(): void {
    const rows = this.#database.query<RevisionRow, []>("SELECT * FROM workflow_revisions").all();
    const insert = this.#database.query(
      "INSERT OR IGNORE INTO workflow_revision_objects (revision_id, object_hash) VALUES (?, ?)",
    );
    this.#database.transaction(() => {
      for (const row of rows) {
        for (const objectHash of new Set(
          fileEntries(this.#manifest(row)).map((entry) => entry.file.sha256),
        )) {
          insert.run(row.revision_id, objectHash);
        }
      }
    })();
  }

  #readerOf(row: ReaderRow): RevisionReader {
    return {
      readerId: row.reader_id,
      kind: row.reader_kind,
      acquiredAt: row.acquired_at,
      ...(row.runner_instance_id === null ? {} : { runnerInstanceId: row.runner_instance_id }),
    };
  }

  #protections(revisionId: string): ReadonlyArray<RevisionProtection> {
    const protections: RevisionProtection[] = [];
    for (const row of this.#database
      .query<{ readonly project_id: string; readonly workflow_name: string }, [string]>(
        "SELECT project_id, workflow_name FROM project_workflows WHERE current_revision_id = ? AND availability = 'available'",
      )
      .all(revisionId)) {
      protections.push({
        reason: "current-workflow",
        ownerId: JSON.stringify([row.project_id, row.workflow_name]),
        detail: `${row.project_id}/${row.workflow_name} uses this current Workflow Revision`,
      });
    }
    for (const row of this.#database
      .query<{ readonly run_id: string }, [string]>(
        "SELECT run_id FROM workflow_runs WHERE revision_id = ? ORDER BY admission_sequence",
      )
      .all(revisionId)) {
      protections.push({
        reason: "retained-run",
        ownerId: row.run_id,
        detail: `retained Run ${row.run_id} is pinned to this Workflow Revision`,
      });
    }
    for (const row of this.#database
      .query<{ readonly owner_id: string }, [string]>(
        "SELECT owner_id FROM workflow_revision_refs WHERE revision_id = ? AND owner_kind = 'validation'",
      )
      .all(revisionId)) {
      protections.push({
        reason: "validation",
        ownerId: row.owner_id,
        detail: `validation ${row.owner_id} requires this exact Workflow Revision`,
      });
    }
    for (const row of this.#database
      .query<ReaderRow, [string]>(
        "SELECT reader_id, reader_kind, runner_instance_id, acquired_at FROM workflow_readers WHERE revision_id = ? AND released_at IS NULL",
      )
      .all(revisionId)) {
      protections.push({
        reason: row.reader_kind === "loaded" ? "loaded-registration" : "active-reader",
        ownerId: row.reader_id,
        detail:
          row.reader_kind === "loaded"
            ? `Runner ${row.runner_instance_id ?? "unknown"} still has this registration loaded`
            : `reader ${row.reader_id} is validating retained content`,
      });
    }
    return protections;
  }

  #resetGrace(revisionId: string): void {
    this.#database.run(
      "DELETE FROM workflow_revision_collection WHERE revision_id = ? AND state = 'grace'",
      [revisionId],
    );
  }

  #startGraceWhenUnprotected(revisionId: string, observedAt: string): void {
    if (this.#protections(revisionId).length > 0) {
      this.#resetGrace(revisionId);
      return;
    }
    const eligibleAt = new Date(Date.parse(observedAt) + COLLECTION_GRACE_MILLIS).toISOString();
    this.#database.run(
      `INSERT OR IGNORE INTO workflow_revision_collection
         (revision_id, state, eligible_at) VALUES (?, 'grace', ?)`,
      [revisionId, eligibleAt],
    );
  }

  #faults(row: RevisionRow, manifest: RevisionManifest): ReadonlyArray<RevisionFault> {
    const collection = this.#collection(row.revision_id);
    const faults: RevisionFault[] = [];
    if (collection?.state === "collecting") {
      faults.push({
        code: "COLLECTION_INTERRUPTED",
        detail: "collection did not finish its filesystem publication",
        remedy: "Retry collection for this exact Workflow Revision.",
      });
    }
    if (
      manifest.compatibility.os !== process.platform ||
      manifest.compatibility.arch !== process.arch
    ) {
      faults.push({
        code: "HOST_INCOMPATIBLE",
        detail: `the revision requires ${manifest.compatibility.os}/${manifest.compatibility.arch}`,
        remedy: "Use the recorded Host and architecture. Kojo will not rebuild the revision.",
      });
    }
    if (!Bun.semver.satisfies(Bun.version, `>=${manifest.compatibility.bun}`)) {
      faults.push({
        code: "BUN_INCOMPATIBLE",
        detail: `the revision requires Bun ${manifest.compatibility.bun}`,
        remedy: "Use a compatible managed Bun. Kojo will not install one for this revision.",
      });
    }
    const manifestPath = join(row.published_path, "manifest.json");
    if (!existsSync(manifestPath)) {
      faults.push({
        code: "CONTENT_MISSING",
        path: "manifest.json",
        detail: "the exact Workflow Revision manifest is missing",
        remedy: "Restore an exact verified copy with `kojo project repair`.",
      });
      return faults;
    }
    try {
      const onDisk = JSON.parse(readFileSync(manifestPath, "utf8")) as RevisionManifest;
      if (sha256Text(canonicalJson(onDisk)) !== row.revision_id) {
        faults.push({
          code: "CONTENT_CORRUPT",
          path: "manifest.json",
          detail: "the retained manifest does not match its Workflow Revision identity",
          remedy: "Restore the exact retained manifest. Kojo will not substitute another identity.",
        });
      }
    } catch {
      faults.push({
        code: "CONTENT_CORRUPT",
        path: "manifest.json",
        detail: "the retained manifest is not valid JSON",
        remedy: "Restore the exact retained manifest.",
      });
    }
    for (const entry of fileEntries(manifest)) {
      const path = join(row.published_path, entry.retainedPath);
      if (!inside(row.published_path, path) || !existsSync(path)) {
        faults.push({
          code: "CONTENT_MISSING",
          objectHash: entry.file.sha256,
          path: entry.retainedPath,
          detail: `${entry.label} is missing from this retained revision`,
          remedy: "Restore the exact retained bytes. Kojo will not install or rebuild them.",
        });
      } else if (
        !lstatSync(path).isFile() ||
        hash(readFileSync(path)) !== entry.file.sha256 ||
        ![0o600, entry.file.mode].includes(statSync(path).mode & 0o777)
      ) {
        faults.push({
          code: "CONTENT_CORRUPT",
          objectHash: entry.file.sha256,
          path: entry.retainedPath,
          detail: `${entry.label} does not match its exact retained bytes or mode`,
          remedy: "Restore the exact retained bytes. Kojo will not substitute a package.",
        });
      }
      const objectPath = join(this.#dataRoot, "objects", entry.file.sha256);
      if (!existsSync(objectPath) || hash(readFileSync(objectPath)) !== entry.file.sha256) {
        faults.push({
          code: existsSync(objectPath) ? "CONTENT_CORRUPT" : "CONTENT_MISSING",
          objectHash: entry.file.sha256,
          detail: `shared object ${entry.file.sha256} is unavailable`,
          remedy: "Repair each dependent Workflow Revision from an exact copy.",
        });
      }
    }
    return faults;
  }

  #collection(revisionId: string): CollectionRow | null {
    return this.#database
      .query<CollectionRow, [string]>(
        "SELECT state, eligible_at, collected_at FROM workflow_revision_collection WHERE revision_id = ?",
      )
      .get(revisionId);
  }

  #details(revisionId: string, observedAt: string): RevisionDetails {
    this.#indexObjects();
    const row = this.#revision(revisionId);
    const manifest = this.#manifest(row);
    const protections = this.#protections(revisionId);
    if (protections.length === 0) this.#startGraceWhenUnprotected(revisionId, observedAt);
    else this.#resetGrace(revisionId);
    const collection = this.#collection(revisionId);
    const activeReaders = this.#database
      .query<ReaderRow, [string]>(
        "SELECT reader_id, reader_kind, runner_instance_id, acquired_at FROM workflow_readers WHERE revision_id = ? AND released_at IS NULL ORDER BY acquired_at, reader_id",
      )
      .all(revisionId)
      .map((reader) => this.#readerOf(reader));
    const dependentRuns = this.#database
      .query<{ readonly run_id: string; readonly state: string }, [string]>(
        "SELECT run_id, state FROM workflow_runs WHERE revision_id = ? ORDER BY admission_sequence",
      )
      .all(revisionId)
      .map((run) => ({ runId: run.run_id, state: run.state }));
    return {
      revisionId,
      packageGraphId: row.package_graph_id,
      manifest,
      packages: manifest.packages.map((entry) => ({
        packageId: entry.packageId,
        name: entry.name,
        version: entry.version,
        fileCount: entry.files.length,
      })),
      dependentRuns,
      activeReaders,
      protections,
      faults: this.#faults(row, manifest),
      collection:
        protections.length > 0 || collection === null
          ? { state: "protected" }
          : collection.state === "grace"
            ? { state: "grace", eligibleAt: collection.eligible_at ?? observedAt }
            : collection.state === "collecting"
              ? { state: "collecting" }
              : { state: "collected", collectedAt: collection.collected_at ?? observedAt },
    };
  }

  #verifyExactSource(row: RevisionRow, source: string): RevisionManifest {
    const sourceManifest = join(source, "manifest.json");
    if (!existsSync(sourceManifest)) {
      throw new RevisionMaintenanceError({
        code: "EXACT_COPY_REFUSED",
        message: "the repair source has no manifest.json",
      });
    }
    let manifest: RevisionManifest;
    try {
      manifest = JSON.parse(readFileSync(sourceManifest, "utf8")) as RevisionManifest;
    } catch (cause) {
      throw new RevisionMaintenanceError({
        code: "EXACT_COPY_REFUSED",
        message: "the repair source manifest is invalid",
        cause,
      });
    }
    const packageGraphId = sha256Text(
      canonicalJson({ packages: manifest.packages, resolution: manifest.resolution }),
    );
    if (
      sha256Text(canonicalJson(manifest)) !== row.revision_id ||
      packageGraphId !== row.package_graph_id ||
      canonicalJson(manifest) !== canonicalJson(this.#manifest(row))
    ) {
      throw new RevisionMaintenanceError({
        code: "EXACT_COPY_REFUSED",
        message: "the repair source changes the Workflow Revision or package graph identity",
      });
    }
    for (const entry of fileEntries(manifest)) {
      const path = join(source, entry.retainedPath);
      if (
        !inside(source, path) ||
        !existsSync(path) ||
        !lstatSync(path).isFile() ||
        hash(readFileSync(path)) !== entry.file.sha256 ||
        ![0o600, entry.file.mode].includes(statSync(path).mode & 0o777)
      ) {
        throw new RevisionMaintenanceError({
          code: "EXACT_COPY_REFUSED",
          message: `the repair source does not contain exact bytes and mode for ${entry.label}`,
        });
      }
    }
    return manifest;
  }

  #copyExact(source: string, target: string): void {
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    copyFileSync(source, target);
    chmodSync(target, 0o600);
  }

  #repairExact(revisionId: string, source: string): void {
    const row = this.#revision(revisionId);
    const state = this.#collection(revisionId)?.state;
    if (state === "collecting" || state === "collected") {
      throw new RevisionMaintenanceError({
        code: "EXACT_COPY_REFUSED",
        message: "collection already excluded this Workflow Revision from repair",
      });
    }
    const manifest = this.#verifyExactSource(row, source);
    const stageRoot = join(this.#dataRoot, "staging", `repair-${crypto.randomUUID()}`);
    const stagedRevision = join(stageRoot, revisionId);
    mkdirSync(stagedRevision, { recursive: true, mode: 0o700 });
    try {
      for (const entry of fileEntries(manifest)) {
        this.#copyExact(join(source, entry.retainedPath), join(stagedRevision, entry.retainedPath));
      }
      writeFileSync(join(stagedRevision, "manifest.json"), `${canonicalJson(manifest)}\n`, {
        mode: 0o600,
      });
      const objects = join(this.#dataRoot, "objects");
      mkdirSync(objects, { recursive: true, mode: 0o700 });
      for (const entry of fileEntries(manifest)) {
        const objectPath = join(objects, entry.file.sha256);
        if (existsSync(objectPath) && hash(readFileSync(objectPath)) === entry.file.sha256)
          continue;
        const temporary = `${objectPath}.repair-${crypto.randomUUID()}`;
        this.#copyExact(join(source, entry.retainedPath), temporary);
        renameSync(temporary, objectPath);
      }
      syncDirectory(objects);
      const quarantine = `${row.published_path}.repair-${crypto.randomUUID()}`;
      if (existsSync(row.published_path)) renameSync(row.published_path, quarantine);
      renameSync(stagedRevision, row.published_path);
      syncDirectory(dirname(row.published_path));
      rmSync(quarantine, { recursive: true, force: true });
      this.#indexObjects();
    } finally {
      rmSync(stageRoot, { recursive: true, force: true });
    }
  }

  #collect(revisionId: string, observedAt: string): CollectionResult {
    const row = this.#revision(revisionId);
    const decision = this.#database
      .transaction(() => {
        this.#indexObjects();
        const protections = this.#protections(revisionId);
        if (protections.length > 0) {
          this.#resetGrace(revisionId);
          return { state: "protected" as const };
        }
        const current = this.#collection(revisionId);
        if (current?.state === "collected") return { state: "collected" as const };
        if (current?.state === "collecting") return { state: "collecting" as const };
        if (current === null) {
          const eligibleAt = new Date(
            Date.parse(observedAt) + COLLECTION_GRACE_MILLIS,
          ).toISOString();
          this.#database.run(
            "INSERT INTO workflow_revision_collection (revision_id, state, eligible_at) VALUES (?, 'grace', ?)",
            [revisionId, eligibleAt],
          );
          return { state: "grace" as const, eligibleAt };
        }
        const eligibleAt = current.eligible_at ?? observedAt;
        if (Date.parse(observedAt) < Date.parse(eligibleAt)) {
          return { state: "grace" as const, eligibleAt };
        }
        if (this.#protections(revisionId).length > 0) return { state: "protected" as const };
        this.#database.run(
          "UPDATE workflow_revision_collection SET state = 'collecting' WHERE revision_id = ? AND state = 'grace'",
          [revisionId],
        );
        return { state: "collecting" as const };
      })
      .immediate();
    if (decision.state === "protected") return { revisionId, state: "protected" };
    if (decision.state === "grace") {
      return { revisionId, state: "grace", eligibleAt: decision.eligibleAt };
    }
    if (decision.state === "collected") return { revisionId, state: "collected" };

    try {
      rmSync(row.published_path, { recursive: true, force: true });
      const objectHashes = this.#database
        .query<{ readonly object_hash: string }, [string]>(
          "SELECT object_hash FROM workflow_revision_objects WHERE revision_id = ?",
        )
        .all(revisionId);
      let removedObjects = 0;
      for (const entry of objectHashes) {
        const protectedElsewhere = this.#database
          .query<{ readonly count: number }, [string, string]>(
            `SELECT COUNT(*) AS count
               FROM workflow_revision_objects o
               LEFT JOIN workflow_revision_collection c ON c.revision_id = o.revision_id
              WHERE o.object_hash = ? AND o.revision_id <> ?
                AND (c.state IS NULL OR c.state <> 'collected')`,
          )
          .get(entry.object_hash, revisionId)?.count;
        if ((protectedElsewhere ?? 0) === 0) {
          rmSync(join(this.#dataRoot, "objects", entry.object_hash), { force: true });
          removedObjects += 1;
        }
      }
      this.#database
        .transaction(() => {
          if (this.#protections(revisionId).length > 0) {
            throw new RevisionMaintenanceError({
              code: "COLLECTION_FAILED",
              message: "a new protection appeared after collection exclusion",
            });
          }
          this.#database.run(
            "UPDATE workflow_revision_collection SET state = 'collected', collected_at = ? WHERE revision_id = ? AND state = 'collecting'",
            [observedAt, revisionId],
          );
        })
        .immediate();
      return { revisionId, state: "collected", removedObjects };
    } catch (cause) {
      throw cause instanceof RevisionMaintenanceError
        ? cause
        : new RevisionMaintenanceError({
            code: "COLLECTION_FAILED",
            message: "revision collection was interrupted and remains exclusive",
            cause,
          });
    }
  }
}
