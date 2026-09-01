import { Database } from "bun:sqlite";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AtomicArtifactRepository,
  MAX_PUBLISHED_ARTIFACT_BYTES,
} from "../../../../../src/contexts/trace/adapters/AtomicArtifactRepository.ts";

const roots: Array<string> = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "kojo-artifact-"));
  roots.push(root);
  const database = new Database(":memory:", { strict: true });
  database.run("PRAGMA foreign_keys = ON");
  database.run("CREATE TABLE workflow_runs (run_id TEXT PRIMARY KEY NOT NULL) STRICT");
  database.run("INSERT INTO workflow_runs (run_id) VALUES ('run-artifact')");
  return { database, repository: new AtomicArtifactRepository(database, root) };
};

describe("atomic Artifact publication", () => {
  it("publishes only complete content with the declared size and digest", () => {
    const { database, repository } = fixture();
    const content = new TextEncoder().encode("<script>alert('not markup')</script>\n");
    const sha256 = new Bun.CryptoHasher("sha256").update(content).digest("hex");
    repository.begin({
      transferId: "transfer-artifact",
      runId: "run-artifact",
      name: "agent output.txt",
      mediaType: "text/plain; charset=utf-8",
      totalSize: content.byteLength,
      sha256,
    });
    repository.begin({
      transferId: "transfer-artifact",
      runId: "run-artifact",
      name: "agent output.txt",
      mediaType: "text/plain; charset=utf-8",
      totalSize: content.byteLength,
      sha256,
    });
    repository.write("transfer-artifact", 0, content.slice(0, 8));
    repository.write("transfer-artifact", 0, content.slice(0, 8));
    expect(repository.read("run-artifact", "transfer-artifact")).toBeUndefined();
    repository.write("transfer-artifact", 1, content.slice(8));
    const published = repository.finish("transfer-artifact", "2026-09-01T10:00:00.000Z");
    expect(repository.finish("transfer-artifact", "2026-09-01T10:00:01.000Z")).toEqual(published);
    expect(readFileSync(published.path, "utf8")).toBe("<script>alert('not markup')</script>\n");
    expect(repository.read("run-artifact", published.artifactId)).toMatchObject({ sha256 });
    database.close();
  });

  it("refuses oversized and corrupt publication", () => {
    const { database, repository } = fixture();
    expect(() =>
      repository.begin({
        transferId: "too-large",
        runId: "run-artifact",
        name: "large.txt",
        mediaType: "text/plain",
        totalSize: MAX_PUBLISHED_ARTIFACT_BYTES + 1,
        sha256: "0".repeat(64),
      }),
    ).toThrow("exceeds");
    repository.begin({
      transferId: "corrupt",
      runId: "run-artifact",
      name: "corrupt.txt",
      mediaType: "text/plain",
      totalSize: 1,
      sha256: "0".repeat(64),
    });
    repository.write("corrupt", 0, new Uint8Array([1]));
    expect(() => repository.finish("corrupt", "2026-09-01T10:00:00.000Z")).toThrow(
      "does not match",
    );
    database.close();
  });

  it("repairs an interrupted chunk append and an interrupted final rename", () => {
    const { database, repository } = fixture();
    const content = new TextEncoder().encode("durable artifact\n");
    const first = content.slice(0, 8);
    const second = content.slice(8);
    const sha256 = new Bun.CryptoHasher("sha256").update(content).digest("hex");
    repository.begin({
      transferId: "interrupted-transfer",
      runId: "run-artifact",
      name: "durable.txt",
      mediaType: "text/plain",
      totalSize: content.byteLength,
      sha256,
    });
    repository.write("interrupted-transfer", 0, first);
    const transfer = database
      .query<{ readonly staged_path: string }, []>(
        "SELECT staged_path FROM artifact_transfers WHERE transfer_id = 'interrupted-transfer'",
      )
      .get();
    expect(transfer).not.toBeNull();
    appendFileSync(transfer?.staged_path ?? "", second);

    const restarted = new AtomicArtifactRepository(
      database,
      join(transfer?.staged_path ?? "", "..", "..", ".."),
    );
    restarted.write("interrupted-transfer", 1, second);

    const artifactId = new Bun.CryptoHasher("sha256").update("interrupted-transfer").digest("hex");
    const retained = join(transfer?.staged_path ?? "", "..", "..", "run-artifact", artifactId);
    mkdirSync(join(retained, ".."), { recursive: true });
    renameSync(transfer?.staged_path ?? "", retained);

    const published = restarted.finish("interrupted-transfer", "2026-09-01T10:00:00.000Z");
    expect(published.path).toBe(retained);
    expect(readFileSync(retained)).toEqual(Buffer.from(content));
    expect(restarted.finish("interrupted-transfer", "2026-09-01T10:00:01.000Z")).toEqual(published);
    database.close();
  });

  it("migrates a retained Artifact away from Run correctness ownership", () => {
    const root = mkdtempSync(join(tmpdir(), "kojo-artifact-separate-retention-"));
    roots.push(root);
    const database = new Database(":memory:", { strict: true });
    database.run("PRAGMA foreign_keys = ON");
    database.run("CREATE TABLE workflow_runs (run_id TEXT PRIMARY KEY NOT NULL) STRICT");
    database.run("INSERT INTO workflow_runs VALUES ('run-retained')");
    database.run(`
      CREATE TABLE retained_artifacts (
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
    database.run(
      "INSERT INTO retained_artifacts VALUES ('artifact-1', 'transfer-1', 'run-retained', 'result.txt', 'text/plain', 1, ?, ?, ?)",
      ["a".repeat(64), join(root, "artifacts", "result.txt"), "2026-09-01T10:00:00.000Z"],
    );
    new AtomicArtifactRepository(database, root);
    database.run("DELETE FROM workflow_runs WHERE run_id = 'run-retained'");
    expect(database.query("SELECT * FROM retained_artifacts").all()).toHaveLength(1);
    expect(
      database
        .query<{ readonly table: string }, []>("PRAGMA foreign_key_list(retained_artifacts)")
        .all(),
    ).not.toContainEqual(expect.objectContaining({ table: "workflow_runs" }));
    database.close();
  });
});
