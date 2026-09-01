import { Database } from "bun:sqlite";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteProjectRepository } from "../../../../src/contexts/project/adapters/SqliteProjectRepository.ts";
import { SqliteRevisionRepository } from "../../../../src/contexts/workflow/adapters/SqliteRevisionRepository.ts";
import { SqliteRunRepository } from "../../../../src/contexts/workflow/adapters/SqliteRunRepository.ts";
import type {
  RevisionFile,
  RevisionManifest,
} from "../../../../src/contexts/workflow/models/RevisionManifest.ts";
import {
  canonicalJson,
  sha256Text,
} from "../../../../src/contexts/workflow/services/canonicalJson.ts";

const roots: string[] = [];

interface FixtureRevision {
  readonly revisionId: string;
  readonly packageGraphId: string;
  readonly manifest: RevisionManifest;
  readonly publishedPath: string;
  readonly exactCopy: string;
  readonly packageBytes: string;
  readonly packageHash: string;
}

const sha256 = (value: string): string =>
  new Bun.CryptoHasher("sha256").update(value).digest("hex");

const writeExact = (root: string, path: string, bytes: string, mode: number): void => {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  writeFileSync(target, bytes);
  chmodSync(target, mode);
};

const makeRevision = (
  dataRoot: string,
  workflowName: string,
  packageBytes = `{"name":"fixture-package","version":"1.0.0","scripts":{"postinstall":"touch should-not-run"}}\n`,
): FixtureRevision => {
  const sourceBytes = `export const workflow = "${workflowName}";\n`;
  const source: RevisionFile = {
    path: `workflows/${workflowName}.ts`,
    sha256: sha256(sourceBytes),
    mode: 0o644,
  };
  const packageFile: RevisionFile = {
    path: "package.json",
    sha256: sha256(packageBytes),
    mode: 0o644,
  };
  const packageId = sha256Text(`fixture-package:${packageFile.sha256}`);
  const packages = [
    {
      packageId,
      name: "fixture-package",
      version: "1.0.0",
      files: [packageFile],
    },
  ];
  const manifest: RevisionManifest = {
    formatVersion: 1,
    workflowName,
    entrySource: source.path,
    sources: [source],
    assets: [],
    sharedConfiguration: [],
    packages,
    resolution: [
      {
        fromPackageId: "factory",
        specifier: "fixture-package",
        targetPackageId: packageId,
        subpath: ".",
      },
    ],
    runtime: {
      packageId,
      manifestHash: packageFile.sha256,
      runner: "package.json",
      protocols: [1],
      requiredFeatures: [],
    },
    sharedEffect: { packageId, resolvedEntryHash: packageFile.sha256 },
    compatibility: {
      bun: Bun.version,
      os: process.platform,
      arch: process.arch,
      nativeContent: false,
    },
    dependencyEvidence: { lockfileHashes: [], resolutionInputHashes: [] },
  };
  const revisionId = sha256Text(canonicalJson(manifest));
  const packageGraphId = sha256Text(canonicalJson({ packages, resolution: manifest.resolution }));
  const publishedPath = join(dataRoot, "revisions", revisionId);
  const exactCopy = join(dataRoot, "copies", revisionId);
  for (const root of [publishedPath, exactCopy]) {
    writeExact(root, join("factory", "sources", source.path), sourceBytes, source.mode);
    writeExact(root, join("packages", packageId, packageFile.path), packageBytes, packageFile.mode);
    writeExact(root, "manifest.json", `${canonicalJson(manifest)}\n`, 0o600);
  }
  for (const [objectHash, bytes] of [
    [source.sha256, sourceBytes],
    [packageFile.sha256, packageBytes],
  ] as const) {
    writeExact(join(dataRoot, "objects"), objectHash, bytes, 0o644);
  }
  return {
    revisionId,
    packageGraphId,
    manifest,
    publishedPath,
    exactCopy,
    packageBytes,
    packageHash: packageFile.sha256,
  };
};

const fixture = (): {
  readonly database: Database;
  readonly dataRoot: string;
  readonly revisions: SqliteRevisionRepository;
  readonly insertRevision: (revision: FixtureRevision, current?: boolean) => void;
} => {
  const dataRoot = mkdtempSync(join(tmpdir(), "kojo-revision-maintenance-"));
  roots.push(dataRoot);
  mkdirSync(join(dataRoot, "objects"), { recursive: true });
  mkdirSync(join(dataRoot, "revisions"), { recursive: true });
  mkdirSync(join(dataRoot, "staging"), { recursive: true });
  const database = new Database(join(dataRoot, "kojo.db"), { create: true, strict: true });
  database.run("PRAGMA foreign_keys = ON");
  database.run(
    "CREATE TABLE daemon_metadata (name TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL) STRICT",
  );
  database.run("INSERT INTO daemon_metadata VALUES ('data_identity', 'data-1')");
  new SqliteProjectRepository(database);
  new SqliteRunRepository(database);
  const insertRevision = (revision: FixtureRevision, current = false): void => {
    const projectId = `project-${revision.manifest.workflowName}`;
    database.run(
      "INSERT OR IGNORE INTO projects VALUES (?, ?, 'available', 'available', 'current', ?, ?, NULL, NULL)",
      [
        projectId,
        join(dataRoot, projectId),
        "2026-09-01T00:00:00.000Z",
        "2026-09-01T00:00:00.000Z",
      ],
    );
    database.run("INSERT INTO workflow_revisions VALUES (?, ?, ?, ?, ?)", [
      revision.revisionId,
      revision.packageGraphId,
      canonicalJson(revision.manifest),
      revision.publishedPath,
      "2026-09-01T00:00:00.000Z",
    ]);
    database.run(
      `INSERT INTO project_workflows VALUES
       (?, ?, 'inactive', 'available', ?, NULL, NULL, ?, NULL, 'not-declared', NULL, NULL, ?)`,
      [
        projectId,
        revision.manifest.workflowName,
        revision.manifest.entrySource,
        current ? revision.revisionId : null,
        "2026-09-01T00:00:00.000Z",
      ],
    );
    database.run("INSERT INTO workflow_revision_registrations VALUES (?, ?, ?, ?, ?)", [
      projectId,
      revision.manifest.workflowName,
      revision.revisionId,
      revision.packageGraphId,
      "2026-09-01T00:00:00.000Z",
    ]);
  };
  return {
    database,
    dataRoot,
    insertRevision,
    get revisions() {
      return new SqliteRevisionRepository(database, dataRoot);
    },
  };
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("exact Workflow Revision repair", () => {
  it("refuses identity or package substitution and restores only verified exact bytes", async () => {
    const test = fixture();
    const revision = makeRevision(test.dataRoot, "review");
    test.insertRevision(revision);
    const repository = test.revisions;
    const packagePath = join(
      revision.publishedPath,
      "packages",
      revision.manifest.packages[0]?.packageId ?? "missing",
      "package.json",
    );
    writeFileSync(packagePath, "corrupt\n");
    writeFileSync(join(test.dataRoot, "objects", revision.packageHash), "corrupt\n");
    expect(
      (await Effect.runPromise(repository.details(revision.revisionId, "2026-09-01T00:00:00.000Z")))
        .faults,
    ).toEqual(expect.arrayContaining([expect.objectContaining({ code: "CONTENT_CORRUPT" })]));

    const substituted = join(test.dataRoot, "substituted");
    mkdirSync(substituted, { recursive: true });
    const changed = { ...revision.manifest, workflowName: "substituted" };
    writeFileSync(join(substituted, "manifest.json"), canonicalJson(changed));
    await expect(
      Effect.runPromise(
        repository.repairExact(revision.revisionId, substituted, "2026-09-01T01:00:00.000Z"),
      ),
    ).rejects.toMatchObject({ code: "EXACT_COPY_REFUSED" });

    const repaired = await Effect.runPromise(
      repository.repairExact(revision.revisionId, revision.exactCopy, "2026-09-01T01:00:00.000Z"),
    );
    expect(repaired.faults).toEqual([]);
    expect(readFileSync(packagePath, "utf8")).toBe(revision.packageBytes);
    expect(statSync(join(test.dataRoot, "objects", revision.packageHash)).mode & 0o777).toBe(0o600);
    expect(existsSync(join(revision.exactCopy, "should-not-run"))).toBe(false);
    expect(existsSync(join(test.dataRoot, "should-not-run"))).toBe(false);
  });

  it("keeps one damaged shared object fault local to dependent revisions", async () => {
    const test = fixture();
    const sharedBytes = '{"name":"fixture-package","version":"1.0.0"}\n';
    const first = makeRevision(test.dataRoot, "object-first", sharedBytes);
    const second = makeRevision(test.dataRoot, "object-second", sharedBytes);
    const independent = makeRevision(
      test.dataRoot,
      "object-independent",
      '{"name":"fixture-package","version":"2.0.0"}\n',
    );
    test.insertRevision(first);
    test.insertRevision(second);
    test.insertRevision(independent);
    const repository = test.revisions;
    writeFileSync(join(test.dataRoot, "objects", first.packageHash), "damaged\n");

    const firstFaults = await Effect.runPromise(
      repository.details(first.revisionId, "2026-09-01T00:00:00.000Z"),
    );
    const secondFaults = await Effect.runPromise(
      repository.details(second.revisionId, "2026-09-01T00:00:00.000Z"),
    );
    const independentFaults = await Effect.runPromise(
      repository.details(independent.revisionId, "2026-09-01T00:00:00.000Z"),
    );
    expect(firstFaults.faults).toContainEqual(
      expect.objectContaining({ objectHash: first.packageHash }),
    );
    expect(secondFaults.faults).toContainEqual(
      expect.objectContaining({ objectHash: first.packageHash }),
    );
    expect(independentFaults.faults).not.toContainEqual(
      expect.objectContaining({ objectHash: first.packageHash }),
    );
  });
});

describe("Workflow Revision protection and collection", () => {
  it("shows current Workflow, every retained Run, validation, and loaded reader protections", async () => {
    const test = fixture();
    const revision = makeRevision(test.dataRoot, "protected");
    test.insertRevision(revision, true);
    const projectId = "project-protected";
    test.database.run(
      `INSERT INTO workflow_runs
       (run_id, project_id, workflow_name, idempotency_key, payload_json, revision_id,
        package_graph_id, state, admission_sequence, admitted_at, finished_at)
       VALUES ('retained-run', ?, 'protected', 'key', '{}', ?, ?, 'succeeded', 1, ?, ?)`,
      [
        projectId,
        revision.revisionId,
        revision.packageGraphId,
        "2026-09-01T00:00:00.000Z",
        "2026-09-01T01:00:00.000Z",
      ],
    );
    test.database.run(
      "CREATE TABLE trace_runs (run_id TEXT PRIMARY KEY NOT NULL, detail TEXT NOT NULL) STRICT",
    );
    test.database.run("INSERT INTO trace_runs VALUES ('retained-run', 'observation')");
    const repository = test.revisions;
    await Effect.runPromise(
      repository.protectValidation(revision.revisionId, "validation-1", "2026-09-01T00:00:00.000Z"),
    );
    await Effect.runPromise(
      repository.acquireReader({
        readerId: "registration-1",
        revisionId: revision.revisionId,
        kind: "loaded",
        runnerInstanceId: "runner-1",
        acquiredAt: "2026-09-01T00:00:00.000Z",
      }),
    );
    test.database.run(
      `INSERT INTO project_workflows VALUES
       (?, 'invalid-copy', 'inactive', 'invalid', 'workflows/invalid-copy.ts',
        'invalid fixture', NULL, ?, NULL, 'not-declared', NULL, NULL, ?)`,
      [projectId, revision.revisionId, "2026-09-01T00:00:00.000Z"],
    );
    test.database.run("DELETE FROM trace_runs");

    const details = await Effect.runPromise(
      repository.details(revision.revisionId, "2026-09-10T00:00:00.000Z"),
    );
    expect(details.dependentRuns).toEqual([{ runId: "retained-run", state: "succeeded" }]);
    expect(details.protections.map((entry) => entry.reason).sort()).toEqual([
      "current-workflow",
      "loaded-registration",
      "retained-run",
      "validation",
    ]);
    expect(
      (await Effect.runPromise(repository.collect(revision.revisionId, "2026-09-10T00:00:00.000Z")))
        .state,
    ).toBe("protected");
  });

  it("excludes new readers atomically, waits 24 hours, and keeps shared objects", async () => {
    const test = fixture();
    const sharedBytes = '{"name":"fixture-package","version":"1.0.0"}\n';
    const first = makeRevision(test.dataRoot, "first", sharedBytes);
    const second = makeRevision(test.dataRoot, "second", sharedBytes);
    test.insertRevision(first);
    test.insertRevision(second);
    const repository = test.revisions;

    expect(
      await Effect.runPromise(repository.collect(first.revisionId, "2026-09-01T00:00:00.000Z")),
    ).toEqual({
      revisionId: first.revisionId,
      state: "grace",
      eligibleAt: "2026-09-02T00:00:00.000Z",
    });
    await Effect.runPromise(
      repository.acquireReader({
        readerId: "late-reader",
        revisionId: first.revisionId,
        kind: "active",
        acquiredAt: "2026-09-01T23:59:59.000Z",
      }),
    );
    expect(
      (await Effect.runPromise(repository.collect(first.revisionId, "2026-09-02T00:00:00.000Z")))
        .state,
    ).toBe("protected");
    await Effect.runPromise(
      repository.releaseReader("late-reader", {
        kind: "disposed",
        confirmedAt: "2026-09-02T00:00:00.000Z",
      }),
    );
    expect(
      (await Effect.runPromise(repository.collect(first.revisionId, "2026-09-02T23:59:59.999Z")))
        .state,
    ).toBe("grace");
    const collected = await Effect.runPromise(
      repository.collect(first.revisionId, "2026-09-03T00:00:00.000Z"),
    );
    expect(collected.state).toBe("collected");
    expect(existsSync(first.publishedPath)).toBe(false);
    expect(existsSync(join(test.dataRoot, "objects", first.packageHash))).toBe(true);
    await expect(
      Effect.runPromise(
        repository.acquireReader({
          readerId: "too-late",
          revisionId: first.revisionId,
          kind: "active",
          acquiredAt: "2026-09-03T00:00:00.001Z",
        }),
      ),
    ).rejects.toMatchObject({ code: "REVISION_STORE_FAILED" });
  });

  it("recovers interrupted publication, repair, reader disposal, and collection boundaries", async () => {
    const test = fixture();
    const revision = makeRevision(test.dataRoot, "interrupted");
    const unpublishedId = "f".repeat(64);
    writeExact(
      join(test.dataRoot, "staging", "publication-owner", unpublishedId),
      "manifest.json",
      "{}\n",
      0o600,
    );
    test.insertRevision(revision);
    const repository = test.revisions;
    await expect(
      Effect.runPromise(repository.details(unpublishedId, "2026-09-01T00:00:00.000Z")),
    ).rejects.toMatchObject({ code: "REVISION_NOT_FOUND" });

    const packagePath = join(
      revision.publishedPath,
      "packages",
      revision.manifest.packages[0]?.packageId ?? "missing",
      "package.json",
    );
    writeFileSync(packagePath, "corrupt\n");
    writeExact(
      join(test.dataRoot, "staging", "repair-interrupted", revision.revisionId),
      "manifest.json",
      `${canonicalJson(revision.manifest)}\n`,
      0o600,
    );
    expect(
      (await Effect.runPromise(repository.details(revision.revisionId, "2026-09-01T00:00:00.000Z")))
        .faults,
    ).toEqual(expect.arrayContaining([expect.objectContaining({ code: "CONTENT_CORRUPT" })]));
    await Effect.runPromise(
      repository.repairExact(revision.revisionId, revision.exactCopy, "2026-09-01T01:00:00.000Z"),
    );

    await Effect.runPromise(
      repository.acquireReader({
        readerId: "interrupted-disposal",
        revisionId: revision.revisionId,
        kind: "loaded",
        runnerInstanceId: "runner-interrupted",
        acquiredAt: "2026-09-01T01:00:00.000Z",
      }),
    );
    expect(
      (await Effect.runPromise(repository.collect(revision.revisionId, "2026-09-03T00:00:00.000Z")))
        .state,
    ).toBe("protected");
    await Effect.runPromise(
      repository.confirmProcessExit("runner-interrupted", "2026-09-03T00:00:00.000Z"),
    );
    test.database.run(
      "UPDATE workflow_revision_collection SET state = 'collecting' WHERE revision_id = ?",
      [revision.revisionId],
    );
    expect(() =>
      test.database.run(
        `INSERT INTO workflow_runs
         (run_id, project_id, workflow_name, idempotency_key, payload_json, revision_id,
          package_graph_id, state, admission_sequence, admitted_at)
         VALUES ('excluded-admission', 'project-interrupted', 'interrupted', 'late', '{}', ?, ?, 'queued', 99, ?)`,
        [revision.revisionId, revision.packageGraphId, "2026-09-04T00:00:00.000Z"],
      ),
    ).toThrow("revision collection excludes admission");
    test.database.run(
      "INSERT INTO projects VALUES ('project-late', ?, 'available', 'available', 'current', ?, ?, NULL, NULL)",
      [join(test.dataRoot, "project-late"), "2026-09-04T00:00:00.000Z", "2026-09-04T00:00:00.000Z"],
    );
    expect(() =>
      test.database.run(
        `INSERT INTO project_workflows VALUES
         ('project-late', 'late', 'inactive', 'available', 'workflows/late.ts',
          NULL, NULL, ?, NULL, 'not-declared', NULL, NULL, ?)`,
        [revision.revisionId, "2026-09-04T00:00:00.000Z"],
      ),
    ).toThrow("revision collection excludes current workflow");
    test.database.run(
      `INSERT INTO project_workflows VALUES
       ('project-late', 'invalid-late', 'inactive', 'invalid', 'workflows/invalid-late.ts',
        'invalid fixture', NULL, ?, NULL, 'not-declared', NULL, NULL, ?)`,
      [revision.revisionId, "2026-09-04T00:00:00.000Z"],
    );
    expect(() =>
      test.database.run(
        "UPDATE project_workflows SET availability = 'available' WHERE project_id = 'project-late' AND workflow_name = 'invalid-late'",
      ),
    ).toThrow("revision collection excludes current workflow");
    expect(() =>
      test.database.run("INSERT INTO workflow_revisions VALUES (?, ?, '{}', ?, ?)", [
        "e".repeat(64),
        "d".repeat(64),
        join(test.dataRoot, "revisions", "e".repeat(64)),
        "2026-09-04T00:00:00.000Z",
      ]),
    ).toThrow("revision collection excludes publication");
    rmSync(revision.publishedPath, { recursive: true, force: true });
    const interrupted = await Effect.runPromise(
      repository.details(revision.revisionId, "2026-09-04T00:00:00.000Z"),
    );
    expect(interrupted.collection.state).toBe("collecting");
    expect(interrupted.faults).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "COLLECTION_INTERRUPTED" })]),
    );
    await expect(
      Effect.runPromise(
        repository.acquireReader({
          readerId: "excluded-during-interruption",
          revisionId: revision.revisionId,
          kind: "active",
          acquiredAt: "2026-09-04T00:00:00.000Z",
        }),
      ),
    ).rejects.toMatchObject({ code: "REVISION_STORE_FAILED" });
    expect(
      (await Effect.runPromise(repository.collect(revision.revisionId, "2026-09-04T00:00:00.000Z")))
        .state,
    ).toBe("collected");
  });
});
