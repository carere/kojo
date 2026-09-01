import type { Database } from "bun:sqlite";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const MAX_PUBLISHED_ARTIFACT_BYTES = 16 * 1024 * 1024;

const syncPath = (path: string): void => {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
};

interface TransferRow {
  readonly transfer_id: string;
  readonly run_id: string;
  readonly artifact_name: string;
  readonly media_type: string;
  readonly total_size: number;
  readonly sha256: string;
  readonly next_ordinal: number;
  readonly staged_path: string;
}

interface PublishedRow {
  readonly artifact_id: string;
  readonly transfer_id: string;
  readonly run_id: string;
  readonly artifact_name: string;
  readonly media_type: string;
  readonly byte_size: number;
  readonly sha256: string;
  readonly retained_path: string;
}

export interface PublishedArtifact {
  readonly artifactId: string;
  readonly runId: string;
  readonly name: string;
  readonly mediaType: string;
  readonly size: number;
  readonly sha256: string;
  readonly path: string;
}

/** Bounded, atomic Artifact publication outside Trace records. */
export class AtomicArtifactRepository {
  readonly #database: Database;
  readonly #root: string;
  readonly #staging: string;

  constructor(database: Database, dataRoot: string) {
    this.#database = database;
    this.#root = join(dataRoot, "artifacts");
    this.#staging = join(this.#root, ".staging");
    mkdirSync(this.#staging, { recursive: true, mode: 0o700 });
    database.run(`
      CREATE TABLE IF NOT EXISTS artifact_transfers (
        transfer_id TEXT PRIMARY KEY NOT NULL,
        run_id TEXT NOT NULL,
        artifact_name TEXT NOT NULL,
        media_type TEXT NOT NULL,
        total_size INTEGER NOT NULL CHECK(total_size >= 0 AND total_size <= ${MAX_PUBLISHED_ARTIFACT_BYTES}),
        sha256 TEXT NOT NULL,
        next_ordinal INTEGER NOT NULL DEFAULT 0,
        staged_path TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES workflow_runs(run_id)
      ) STRICT
    `);
    database.run(`
      CREATE TABLE IF NOT EXISTS retained_artifacts (
        artifact_id TEXT PRIMARY KEY NOT NULL,
        transfer_id TEXT NOT NULL UNIQUE,
        run_id TEXT NOT NULL,
        artifact_name TEXT NOT NULL,
        media_type TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        retained_path TEXT NOT NULL,
        published_at TEXT NOT NULL,
        UNIQUE(run_id, artifact_name),
        FOREIGN KEY (run_id) REFERENCES workflow_runs(run_id)
      ) STRICT
    `);
    database.run(`
      CREATE TABLE IF NOT EXISTS artifact_transfer_chunks (
        transfer_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
        byte_offset INTEGER NOT NULL CHECK(byte_offset >= 0),
        byte_size INTEGER NOT NULL CHECK(byte_size >= 0),
        sha256 TEXT NOT NULL,
        PRIMARY KEY (transfer_id, ordinal),
        FOREIGN KEY (transfer_id) REFERENCES artifact_transfers(transfer_id) ON DELETE CASCADE
      ) STRICT
    `);
  }

  #artifactId(transferId: string): string {
    return new Bun.CryptoHasher("sha256").update(transferId).digest("hex");
  }

  #stagedPath(transferId: string): string {
    return join(this.#staging, this.#artifactId(transferId));
  }

  #committedSize(transferId: string): number {
    return (
      this.#database
        .query<{ readonly size: number }, [string]>(
          "SELECT COALESCE(SUM(byte_size), 0) AS size FROM artifact_transfer_chunks WHERE transfer_id = ?",
        )
        .get(transferId)?.size ?? 0
    );
  }

  #repairStagedFile(transfer: TransferRow): void {
    const committed = this.#committedSize(transfer.transfer_id);
    const actual = statSync(transfer.staged_path).size;
    if (actual < committed) throw new Error("Artifact staged bytes are behind committed chunks");
    if (actual > committed) truncateSync(transfer.staged_path, committed);
  }

  begin(input: {
    readonly transferId: string;
    readonly runId: string;
    readonly name: string;
    readonly mediaType: string;
    readonly totalSize: number;
    readonly sha256: string;
  }): void {
    if (input.totalSize < 0 || input.totalSize > MAX_PUBLISHED_ARTIFACT_BYTES) {
      throw new Error(`Artifact size exceeds ${MAX_PUBLISHED_ARTIFACT_BYTES} bytes`);
    }
    const path = this.#stagedPath(input.transferId);
    this.#database.transaction(() => {
      const published = this.#publishedTransfer(input.transferId);
      if (published !== undefined) {
        if (
          published.runId !== input.runId ||
          published.name !== input.name ||
          published.mediaType !== input.mediaType ||
          published.size !== input.totalSize ||
          published.sha256 !== input.sha256
        ) {
          throw new Error("Artifact transfer identity names different published content");
        }
        return;
      }
      const prior = this.#database
        .query<TransferRow, [string]>(
          `SELECT transfer_id, run_id, artifact_name, media_type, total_size, sha256,
                  next_ordinal, staged_path
             FROM artifact_transfers WHERE transfer_id = ?`,
        )
        .get(input.transferId);
      if (prior !== null) {
        if (
          prior.run_id !== input.runId ||
          prior.artifact_name !== input.name ||
          prior.media_type !== input.mediaType ||
          prior.total_size !== input.totalSize ||
          prior.sha256 !== input.sha256
        ) {
          throw new Error("Artifact transfer identity names different publication content");
        }
        return;
      }
      writeFileSync(path, new Uint8Array(), { mode: 0o600 });
      chmodSync(path, 0o600);
      syncPath(path);
      syncPath(this.#staging);
      this.#database.run(
        `INSERT INTO artifact_transfers (
          transfer_id, run_id, artifact_name, media_type, total_size, sha256, staged_path
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          input.transferId,
          input.runId,
          input.name,
          input.mediaType,
          input.totalSize,
          input.sha256,
          path,
        ],
      );
    })();
  }

  write(
    transferId: string,
    ordinal: number,
    data: Uint8Array,
    declaration?: { readonly totalSize: number; readonly sha256: string },
  ): void {
    this.#database.transaction(() => {
      const transfer = this.#transfer(transferId);
      this.#repairStagedFile(transfer);
      if (
        declaration !== undefined &&
        (declaration.totalSize !== transfer.total_size || declaration.sha256 !== transfer.sha256)
      ) {
        throw new Error("Artifact chunk names different publication content");
      }
      const digest = new Bun.CryptoHasher("sha256").update(data).digest("hex");
      const prior = this.#database
        .query<{ readonly byte_size: number; readonly sha256: string }, [string, number]>(
          "SELECT byte_size, sha256 FROM artifact_transfer_chunks WHERE transfer_id = ? AND ordinal = ?",
        )
        .get(transferId, ordinal);
      if (prior !== null) {
        if (prior.byte_size !== data.byteLength || prior.sha256 !== digest) {
          throw new Error("Artifact chunk retry names different content");
        }
        return;
      }
      if (ordinal !== transfer.next_ordinal) throw new Error("Artifact chunks are out of order");
      const offset = statSync(transfer.staged_path).size;
      const size = offset + data.byteLength;
      if (size > transfer.total_size || size > MAX_PUBLISHED_ARTIFACT_BYTES) {
        throw new Error("Artifact chunks exceed the declared bound");
      }
      appendFileSync(transfer.staged_path, data);
      syncPath(transfer.staged_path);
      this.#database.run(
        `INSERT INTO artifact_transfer_chunks (transfer_id, ordinal, byte_offset, byte_size, sha256)
         VALUES (?, ?, ?, ?, ?)`,
        [transferId, ordinal, offset, data.byteLength, digest],
      );
      this.#database.run(
        "UPDATE artifact_transfers SET next_ordinal = next_ordinal + 1 WHERE transfer_id = ?",
        [transferId],
      );
    })();
  }

  finish(transferId: string, publishedAt: string): PublishedArtifact {
    return this.#database.transaction(() => {
      const prior = this.#publishedTransfer(transferId);
      if (prior !== undefined) return prior;
      const transfer = this.#transfer(transferId);
      const artifactId = this.#artifactId(transferId);
      const directory = join(this.#root, transfer.run_id);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const retainedPath = join(directory, artifactId);
      const source = existsSync(transfer.staged_path) ? transfer.staged_path : retainedPath;
      const content = readFileSync(source);
      const digest = new Bun.CryptoHasher("sha256").update(content).digest("hex");
      if (content.byteLength !== transfer.total_size || digest !== transfer.sha256) {
        throw new Error("Artifact content does not match its declared size and digest");
      }
      syncPath(source);
      if (source === transfer.staged_path) {
        renameSync(transfer.staged_path, retainedPath);
        syncPath(this.#staging);
      }
      chmodSync(retainedPath, 0o600);
      syncPath(retainedPath);
      syncPath(directory);
      syncPath(this.#root);
      this.#database.run(
        `INSERT INTO retained_artifacts (
          artifact_id, transfer_id, run_id, artifact_name, media_type, byte_size, sha256,
          retained_path, published_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          artifactId,
          transferId,
          transfer.run_id,
          transfer.artifact_name,
          transfer.media_type,
          content.byteLength,
          digest,
          retainedPath,
          publishedAt,
        ],
      );
      this.#database.run("DELETE FROM artifact_transfers WHERE transfer_id = ?", [transferId]);
      return {
        artifactId,
        runId: transfer.run_id,
        name: transfer.artifact_name,
        mediaType: transfer.media_type,
        size: content.byteLength,
        sha256: digest,
        path: retainedPath,
      };
    })();
  }

  abort(transferId: string): void {
    const transfer = this.#database
      .query<TransferRow, [string]>("SELECT * FROM artifact_transfers WHERE transfer_id = ?")
      .get(transferId);
    if (transfer !== null) rmSync(transfer.staged_path, { force: true });
    this.#database.run("DELETE FROM artifact_transfers WHERE transfer_id = ?", [transferId]);
  }

  read(runId: string, artifactId: string): PublishedArtifact | undefined {
    const row = this.#database
      .query<PublishedRow, [string, string]>(
        `SELECT artifact_id, transfer_id, run_id, artifact_name, media_type, byte_size, sha256,
                retained_path
           FROM retained_artifacts WHERE run_id = ? AND artifact_id = ?`,
      )
      .get(runId, artifactId);
    return row === null ? undefined : this.#publishedOf(row);
  }

  list(runId: string): ReadonlyArray<PublishedArtifact> {
    return this.#database
      .query<PublishedRow, [string]>(
        `SELECT artifact_id, transfer_id, run_id, artifact_name, media_type, byte_size, sha256,
                retained_path
           FROM retained_artifacts WHERE run_id = ? ORDER BY artifact_name, artifact_id`,
      )
      .all(runId)
      .map((row) => this.#publishedOf(row));
  }

  #publishedTransfer(transferId: string): PublishedArtifact | undefined {
    const row = this.#database
      .query<PublishedRow, [string]>(
        `SELECT artifact_id, transfer_id, run_id, artifact_name, media_type, byte_size, sha256,
                retained_path
           FROM retained_artifacts WHERE transfer_id = ?`,
      )
      .get(transferId);
    return row === null ? undefined : this.#publishedOf(row);
  }

  #publishedOf(row: PublishedRow): PublishedArtifact {
    return {
      artifactId: row.artifact_id,
      runId: row.run_id,
      name: row.artifact_name,
      mediaType: row.media_type,
      size: row.byte_size,
      sha256: row.sha256,
      path: row.retained_path,
    };
  }

  #transfer(transferId: string): TransferRow {
    const transfer = this.#database
      .query<TransferRow, [string]>(
        `SELECT transfer_id, run_id, artifact_name, media_type, total_size, sha256,
                next_ordinal, staged_path
           FROM artifact_transfers WHERE transfer_id = ?`,
      )
      .get(transferId);
    if (transfer === null) throw new Error("Artifact transfer was not found");
    return transfer;
  }
}
