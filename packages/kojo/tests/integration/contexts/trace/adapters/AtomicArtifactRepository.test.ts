import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
});
