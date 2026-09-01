import { Database } from "bun:sqlite";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { startDaemon } from "../../../../src/contexts/daemon/adapters/DaemonOwner.ts";
import {
  readCheckedManagedRelease,
  stageManagedRelease,
} from "../../../../src/contexts/daemon/adapters/ManagedInstallation.ts";
import { SqliteUpgradePreflightRepository } from "../../../../src/contexts/daemon/adapters/SqliteUpgradePreflightRepository.ts";
import type { DaemonPaths } from "../../../../src/contexts/daemon/models/DaemonPaths.ts";
import type { CheckedManagedReleaseManifest } from "../../../../src/contexts/daemon/models/ManagedRelease.ts";
import type { UpgradePreflightRepository } from "../../../../src/contexts/daemon/ports/UpgradePreflightRepository.ts";
import { ManagedUpgradePreflight } from "../../../../src/contexts/daemon/services/ManagedUpgradePreflight.ts";
import { SqliteProjectRepository } from "../../../../src/contexts/project/adapters/SqliteProjectRepository.ts";
import { SqliteRevisionRepository } from "../../../../src/contexts/workflow/adapters/SqliteRevisionRepository.ts";
import { SqliteRunRepository } from "../../../../src/contexts/workflow/adapters/SqliteRunRepository.ts";
import type { RevisionManifest } from "../../../../src/contexts/workflow/models/RevisionManifest.ts";
import {
  canonicalJson,
  sha256Text,
} from "../../../../src/contexts/workflow/services/canonicalJson.ts";
import { publishConsoleRelease } from "../../../support/daemon/consoleRelease.ts";

const removeTree = (path: string): void => {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    unlinkSync(path);
    return;
  }
  if (stat.isDirectory()) {
    chmodSync(path, 0o700);
    for (const child of readdirSync(path)) removeTree(join(path, child));
  } else {
    chmodSync(path, 0o600);
  }
  rmSync(path, { recursive: true, force: true });
};

const write = (path: string, value: string, mode = 0o600): void => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, value, { mode });
  chmodSync(path, mode);
};

const pathsAt = (root: string): DaemonPaths => ({
  installationRoot: join(root, "installation"),
  dataRoot: join(root, "data"),
  configurationRoot: join(root, "configuration"),
  cacheRoot: join(root, "cache"),
  runtimeRoot: join(root, "runtime"),
  serviceDefinition: join(root, "configuration", "kojo.service"),
  managedCli: join(root, "installation", "bin", "kojo"),
  managedLauncher: join(root, "installation", "bin", "kojo-launcher"),
});

const candidate = (): CheckedManagedReleaseManifest => ({
  formatVersion: 2,
  releaseId: "candidate-release",
  kojoVersion: "2.0.0",
  bunVersion: Bun.version,
  createdAt: "2026-09-01T12:00:00.000Z",
  host: { os: process.platform, arch: process.arch },
  compatibility: {
    dataFormats: [1],
    revisionFormats: [1],
    runnerProtocols: [1],
    requiredFeatures: [],
  },
  files: [],
});

describe("managed release staging", () => {
  it("publishes exact checksums without changing active release and survives removed global Kojo and Bun", async () => {
    const root = mkdtempSync(join(tmpdir(), "kojo-upgrade-stage-"));
    try {
      const paths = pathsAt(root);
      const source = join(root, "global-kojo");
      const globalBun = join(root, "global-bun");
      write(join(source, "package.json"), '{"name":"fixture-kojo","version":"9.8.7"}\n');
      write(
        join(source, "managed-release.json"),
        '{"formatVersion":1,"compatibility":{"dataFormats":[1],"revisionFormats":[1],"runnerProtocols":[1],"requiredFeatures":[]}}\n',
      );
      write(
        join(source, "src", "main.ts"),
        'if (Bun.argv.includes("--version")) console.log("fixture-kojo-9.8.7");\n',
      );
      write(join(source, "src", "launcher", "main.ts"), 'console.log("fixture-launcher");\n');
      write(join(source, "console", "index.html"), "<html>fixture console</html>\n");
      copyFileSync(process.execPath, globalBun);
      chmodSync(globalBun, 0o700);
      write(join(paths.installationRoot, "active-release"), "source-release\n");

      const manifest = await Effect.runPromise(
        stageManagedRelease({
          paths,
          expectedVersion: "9.8.7",
          sourceRoot: source,
          bunExecutable: globalBun,
          now: () => Date.parse("2026-09-01T12:00:00.000Z"),
        }),
      );

      expect(readFileSync(join(paths.installationRoot, "active-release"), "utf8")).toBe(
        "source-release\n",
      );
      expect(manifest.files.map((file) => file.path)).toEqual(
        expect.arrayContaining([
          "cli.js",
          "launcher.js",
          "runtime/bun",
          "console/index.html",
          "managed-release.json",
        ]),
      );
      expect(manifest.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256))).toBe(true);

      removeTree(source);
      unlinkSync(globalBun);
      const retained = readCheckedManagedRelease(paths, manifest.releaseId);
      const command = Bun.spawnSync([
        join(paths.installationRoot, "releases", retained.releaseId, "runtime", "bun"),
        join(paths.installationRoot, "releases", retained.releaseId, "cli.js"),
        "--version",
      ]);
      expect(command.exitCode).toBe(0);
      expect(command.stdout.toString()).toContain("fixture-kojo-9.8.7");
    } finally {
      removeTree(root);
    }
  }, 30_000);

  it("fails closed when retained candidate staging is incomplete", () => {
    const root = mkdtempSync(join(tmpdir(), "kojo-upgrade-incomplete-"));
    try {
      const paths = pathsAt(root);
      const release = join(paths.installationRoot, "releases", "incomplete-release");
      write(join(release, "release.json"), '{"formatVersion":2}\n');
      expect(() => readCheckedManagedRelease(paths, "incomplete-release")).toThrow(
        "candidate manifest is incomplete",
      );
    } finally {
      removeTree(root);
    }
  });

  it("lets only the sole Daemon owner check the exact staged candidate and retain its status", async () => {
    const root = mkdtempSync(join(tmpdir(), "kojo-upgrade-owner-"));
    try {
      const paths = pathsAt(root);
      publishConsoleRelease(paths);
      const source = join(root, "candidate-source");
      write(join(source, "package.json"), '{"name":"fixture-kojo","version":"2.0.0"}\n');
      write(
        join(source, "managed-release.json"),
        '{"formatVersion":1,"compatibility":{"dataFormats":[2],"revisionFormats":[1],"runnerProtocols":[1],"requiredFeatures":[]},"migration":{"fromDataFormat":1,"toDataFormat":2,"rollback":"lost","description":"Rewrite the fixture Daemon data without rollback."}}\n',
      );
      write(join(source, "src", "main.ts"), 'console.log("candidate");\n');
      write(join(source, "src", "launcher", "main.ts"), 'console.log("launcher");\n');
      write(join(source, "console", "index.html"), "<html>candidate console</html>\n");
      const staged = await Effect.runPromise(
        stageManagedRelease({
          paths,
          expectedVersion: "2.0.0",
          sourceRoot: source,
          bunExecutable: process.execPath,
          now: () => Date.parse("2026-09-01T12:00:00.000Z"),
        }),
      );
      const daemon = startDaemon(paths, { automaticRefresh: false });
      try {
        const checked = await fetch("http://localhost/api/v1/daemon/upgrade-check", {
          unix: daemon.endpoint.socketPath,
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ candidateReleaseId: staged.releaseId }),
        } as RequestInit & { readonly unix: string });
        expect(checked.status).toBe(200);
        const initial = (await checked.json()) as {
          readonly approvalToken: string;
          readonly report: { readonly outcome: string };
        };
        expect(initial).toMatchObject({
          report: {
            outcome: "approval-required",
            candidateReleaseId: staged.releaseId,
            sourceReleaseId: "kojo-test",
          },
        });
        expect(initial.approvalToken).toEqual(expect.any(String));

        const repeated = await Effect.runPromise(
          stageManagedRelease({
            paths,
            expectedVersion: "2.0.0",
            sourceRoot: source,
            bunExecutable: process.execPath,
            now: () => Date.parse("2026-09-01T12:05:00.000Z"),
          }),
        );
        expect(repeated.releaseId).toBe(staged.releaseId);
        expect(repeated.createdAt).toBe(staged.createdAt);
        removeTree(source);

        const approved = await fetch("http://localhost/api/v1/daemon/upgrade-check", {
          unix: daemon.endpoint.socketPath,
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            candidateReleaseId: repeated.releaseId,
            approvalToken: initial.approvalToken,
          }),
        } as RequestInit & { readonly unix: string });
        expect(approved.status).toBe(200);
        expect(await approved.json()).toMatchObject({
          report: {
            outcome: "staged",
            candidateReleaseId: staged.releaseId,
            rollbackApproval: "approved",
          },
        });
        const replayedApproval = await fetch("http://localhost/api/v1/daemon/upgrade-check", {
          unix: daemon.endpoint.socketPath,
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            candidateReleaseId: repeated.releaseId,
            approvalToken: initial.approvalToken,
          }),
        } as RequestInit & { readonly unix: string });
        expect(await replayedApproval.json()).toMatchObject({
          report: {
            outcome: "staged",
            candidateReleaseId: staged.releaseId,
            rollbackApproval: "approved",
          },
        });
        const repeatedCheck = await fetch("http://localhost/api/v1/daemon/upgrade-check", {
          unix: daemon.endpoint.socketPath,
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ candidateReleaseId: repeated.releaseId }),
        } as RequestInit & { readonly unix: string });
        const repeatedResult = (await repeatedCheck.json()) as {
          readonly approvalToken?: string;
          readonly report: { readonly outcome: string; readonly rollbackApproval: string };
        };
        expect(repeatedResult).toMatchObject({
          report: { outcome: "staged", rollbackApproval: "approved" },
        });
        expect(repeatedResult.approvalToken).toBeUndefined();
        const status = await fetch("http://localhost/api/v1/daemon/upgrade-check", {
          unix: daemon.endpoint.socketPath,
        } as RequestInit & { readonly unix: string });
        expect(await status.json()).toMatchObject({
          outcome: "staged",
          candidateReleaseId: staged.releaseId,
        });

        write(join(paths.installationRoot, "active-release"), `${staged.releaseId}\n`);
        const changedSource = await fetch("http://localhost/api/v1/daemon/upgrade-check", {
          unix: daemon.endpoint.socketPath,
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ candidateReleaseId: staged.releaseId }),
        } as RequestInit & { readonly unix: string });
        expect(changedSource.status).toBe(409);
        expect(await changedSource.json()).toMatchObject({ code: "ACTIVE_RELEASE_CHANGED" });
        write(join(paths.installationRoot, "active-release"), "kojo-test\n");
      } finally {
        await Effect.runPromise(daemon.stop);
      }
    } finally {
      removeTree(root);
    }
  }, 30_000);
});

describe("real retained upgrade evidence", () => {
  it("checks terminal Runs and readers, scopes corrupt evidence, and detects a changed retained set", async () => {
    const root = mkdtempSync(join(tmpdir(), "kojo-upgrade-evidence-"));
    let database: Database | undefined;
    try {
      const dataRoot = join(root, "data");
      mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
      database = new Database(join(dataRoot, "kojo.db"), { create: true, strict: true });
      database.run("PRAGMA foreign_keys = ON");
      database.run(
        "CREATE TABLE daemon_metadata (name TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL) STRICT",
      );
      database.run("INSERT INTO daemon_metadata VALUES ('data_identity', 'daemon-data')");
      new SqliteProjectRepository(database);
      new SqliteRunRepository(database, { enforceProjectEligibility: false });
      const revisions = new SqliteRevisionRepository(database, dataRoot);
      const manifest: RevisionManifest = {
        formatVersion: 1,
        workflowName: "review",
        entrySource: "workflows/review.ts",
        sources: [],
        assets: [],
        sharedConfiguration: [],
        packages: [],
        resolution: [],
        runtime: {
          packageId: "runtime",
          manifestHash: "a".repeat(64),
          runner: "src/runner/main.ts",
          protocols: [1],
          requiredFeatures: [],
        },
        sharedEffect: { packageId: "effect", resolvedEntryHash: "b".repeat(64) },
        compatibility: {
          bun: Bun.version,
          os: process.platform,
          arch: process.arch,
          nativeContent: false,
        },
        dependencyEvidence: { lockfileHashes: [], resolutionInputHashes: [] },
      };
      const revisionId = sha256Text(canonicalJson(manifest));
      const retained = join(dataRoot, "revisions", revisionId);
      write(join(retained, "manifest.json"), `${canonicalJson(manifest)}\n`);
      database.run(
        `INSERT INTO projects
           (project_id, location, project_state, factory_state, refresh_state,
            registered_at, refreshed_at)
         VALUES ('project', '/fixture', 'available', 'available', 'current', 'now', 'now')`,
      );
      database.run(
        `INSERT INTO workflow_revisions
           (revision_id, package_graph_id, manifest_json, published_path, published_at)
         VALUES (?, 'graph', ?, ?, 'now')`,
        [revisionId, canonicalJson(manifest), retained],
      );
      database.run(
        `INSERT INTO project_workflows
           (project_id, workflow_name, activity, availability, source, current_revision_id,
            trigger_state, refreshed_at)
         VALUES ('project', 'review', 'inactive', 'available', '.kojo/workflows/review.ts', ?,
                 'not-declared', 'now')`,
        [revisionId],
      );
      database.run(
        `INSERT INTO workflow_runs
           (run_id, project_id, workflow_name, idempotency_key, payload_json, revision_id,
            package_graph_id, state, admission_sequence, admitted_at, finished_at)
         VALUES ('run-terminal', 'project', 'review', 'terminal', '{}', ?, 'graph',
                 'succeeded', 1, 'now', 'now')`,
        [revisionId],
      );
      await Effect.runPromise(revisions.protectValidation(revisionId, "validation", "now"));
      await Effect.runPromise(
        revisions.acquireReader({
          readerId: "reader",
          revisionId,
          kind: "active",
          acquiredAt: "2026-09-01T12:00:00.000Z",
        }),
      );
      await Effect.runPromise(
        revisions.acquireReader({
          readerId: "loaded-reader",
          revisionId,
          kind: "loaded",
          runnerInstanceId: "runner-one",
          acquiredAt: "2026-09-01T12:00:00.000Z",
        }),
      );
      const repository = new SqliteUpgradePreflightRepository(database, "daemon-data", revisions);
      const first = await Effect.runPromise(repository.capture("2026-09-01T12:00:00.000Z"));
      expect(first.requirements).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "current-workflow" }),
          expect.objectContaining({ kind: "retained-run", state: "succeeded" }),
          expect.objectContaining({ kind: "validation" }),
          expect.objectContaining({ kind: "active-reader" }),
          expect.objectContaining({ kind: "loaded-registration", ownerId: "runner-one" }),
        ]),
      );

      write(join(retained, "manifest.json"), "{}\n");
      const corrupt = await Effect.runPromise(repository.capture("2026-09-01T12:00:01.000Z"));
      expect(corrupt.revisions[0]?.faults).toContainEqual(
        expect.objectContaining({ code: "CONTENT_CORRUPT", path: "manifest.json" }),
      );
      write(join(retained, "manifest.json"), `${canonicalJson(manifest)}\n`);

      let captures = 0;
      const changing: UpgradePreflightRepository = {
        capture: (observedAt) =>
          repository.capture(observedAt).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                captures += 1;
                if (captures === 1) {
                  database?.run(
                    `INSERT INTO workflow_runs
                       (run_id, project_id, workflow_name, idempotency_key, payload_json, revision_id,
                        package_graph_id, state, admission_sequence, admitted_at, finished_at)
                     VALUES ('run-added', 'project', 'review', 'added', '{}', ?, 'graph',
                             'failed', 2, 'now', 'now')`,
                    [revisionId],
                  );
                }
              }),
            ),
          ),
        issueNoRollbackPlan: repository.issueNoRollbackPlan,
        approveNoRollbackPlan: repository.approveNoRollbackPlan,
        record: repository.record,
        latest: repository.latest,
      };
      const result = await Effect.runPromise(
        new ManagedUpgradePreflight(changing).check({
          candidate: candidate(),
          sourceReleaseId: "source-release",
        }),
      );
      expect(result.report.outcome).toBe("incompatible");
      expect(result.report.compatibilityFaults).toContainEqual(
        expect.objectContaining({ code: "RETAINED_SET_CHANGED" }),
      );
      expect(result.report.checked.terminalRuns).toBe(1);
    } finally {
      database?.close(false);
      removeTree(root);
    }
  });
});
