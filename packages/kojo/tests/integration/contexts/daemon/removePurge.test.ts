import { Database } from "bun:sqlite";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MutationEnvelope } from "@carere/kojo-client-contracts/contexts/client/contracts/mutation";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireDaemonStartGate,
  DaemonDataPurger,
} from "../../../../src/contexts/daemon/adapters/DaemonDataPurger.ts";
import { startDaemon } from "../../../../src/contexts/daemon/adapters/DaemonOwner.ts";
import { FileLifecycleJournalRepository } from "../../../../src/contexts/daemon/adapters/FileLifecycleJournalRepository.ts";
import {
  installManagedRelease,
  removeManagedInstallation,
} from "../../../../src/contexts/daemon/adapters/ManagedInstallation.ts";
import {
  ensurePurgeRecoveryCapsule,
  readPurgeRecoveryCapsule,
} from "../../../../src/contexts/daemon/adapters/PurgeRecoveryCapsule.ts";
import { PurgeSafetyRecovery } from "../../../../src/contexts/daemon/adapters/PurgeSafetyRecovery.ts";
import { SqlitePurgeSafetyRepository } from "../../../../src/contexts/daemon/adapters/SqlitePurgeSafetyRepository.ts";
import type { DaemonPaths } from "../../../../src/contexts/daemon/models/DaemonPaths.ts";
import type {
  NativeService,
  NativeServiceObservation,
} from "../../../../src/contexts/daemon/ports/NativeService.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

const fixture = (
  dataIdentity = "data-old",
  observation: NativeServiceObservation = {
    automaticStart: "disabled",
    manager: "unloaded",
    process: "stopped",
    loginLifetime: "test",
    logoutPersistence: "enabled",
  },
) => {
  const root = mkdtempSync(join(tmpdir(), "kojo-purge-"));
  roots.push(root);
  chmodSync(root, 0o700);
  const paths: DaemonPaths = {
    installationRoot: join(root, "installation"),
    dataRoot: join(root, "data"),
    configurationRoot: join(root, "configuration"),
    cacheRoot: join(root, "cache"),
    runtimeRoot: join(root, "runtime"),
    serviceDefinition: join(root, "service", "kojo.service"),
    managedCli: join(root, "installation", "bin", "kojo"),
    managedLauncher: join(root, "installation", "bin", "kojo-launcher"),
  };
  mkdirSync(join(paths.dataRoot, "lifecycle"), { mode: 0o700, recursive: true });
  chmodSync(paths.dataRoot, 0o700);
  const database = new Database(join(paths.dataRoot, "kojo.db"), { create: true, strict: true });
  chmodSync(join(paths.dataRoot, "kojo.db"), 0o600);
  database.run(
    "CREATE TABLE daemon_metadata (name TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL) STRICT",
  );
  database.run("INSERT INTO daemon_metadata (name, value) VALUES ('data_identity', ?)", [
    dataIdentity,
  ]);
  database.run(
    "CREATE TABLE correctness_history (history_id TEXT PRIMARY KEY NOT NULL, detail TEXT NOT NULL) STRICT",
  );
  database.run("INSERT INTO correctness_history VALUES ('history-1', 'retained')");
  const native: NativeService = {
    serviceDocument: () => "test",
    assertSupported: () => undefined,
    inspect: () => observation,
    installAndStart: () => undefined,
    start: () => undefined,
    stop: () => undefined,
    enable: () => undefined,
    disable: () => undefined,
    keepRunningAfterLogout: () => undefined,
  };
  const journal = new FileLifecycleJournalRepository(join(paths.dataRoot, "lifecycle"));
  return { root, paths, database, native, journal, dataIdentity };
};

const seal = async (
  test: ReturnType<typeof fixture>,
  now = Date.parse("2026-09-01T10:00:00.000Z"),
) => {
  const repository = new SqlitePurgeSafetyRepository(
    test.database,
    test.dataIdentity,
    test.paths.dataRoot,
    test.paths.configurationRoot,
  );
  const evidence = await Effect.runPromise(
    repository.seal(
      "remove-1",
      {
        daemonInstanceId: "daemon-1",
        runnerInstanceIds: [],
        recordedAt: new Date(now).toISOString(),
      },
      new Date(now).toISOString(),
      new Date(now + 600_000).toISOString(),
    ),
  );
  return { repository, evidence };
};

describe("remove safety and exact offline purge", () => {
  it("recovers stale safety from the identity-bound capsule after managed removal", async () => {
    const test = fixture();
    mkdirSync(join(test.root, "service"), { mode: 0o700 });
    writeFileSync(
      join(test.paths.dataRoot, "lifecycle", "data-identity"),
      `${test.dataIdentity}\n`,
      { mode: 0o600 },
    );
    const installed = await Effect.runPromise(
      installManagedRelease({
        paths: test.paths,
        serviceDocument: () => "test service\n",
      }),
    );
    const capsule = ensurePurgeRecoveryCapsule(test.paths, test.dataIdentity, installed.releaseId);
    const staleAt = Date.now() - 60_000;
    await Effect.runPromise(
      new SqlitePurgeSafetyRepository(
        test.database,
        test.dataIdentity,
        test.paths.dataRoot,
        test.paths.configurationRoot,
      ).seal(
        "remove-stale",
        {
          daemonInstanceId: "daemon-stale",
          runnerInstanceIds: [],
          recordedAt: new Date(staleAt).toISOString(),
        },
        new Date(staleAt).toISOString(),
        new Date(staleAt + 1).toISOString(),
      ),
    );
    test.database.close(false);
    removeManagedInstallation(test.paths);

    expect(existsSync(join(test.paths.installationRoot, "active-release"))).toBe(false);
    expect(capsule.bun).not.toBe(process.execPath);
    expect(readPurgeRecoveryCapsule(test.paths, test.dataIdentity)).toMatchObject({
      dataIdentity: test.dataIdentity,
      sourceReleaseId: installed.releaseId,
    });
    const purger = new DaemonDataPurger({
      paths: test.paths,
      journal: test.journal,
      nativeService: test.native,
    });
    expect(purger.check).toThrow("stale");

    const recovery = new PurgeSafetyRecovery({
      paths: test.paths,
      journal: test.journal,
      nativeService: test.native,
    });
    const manifestPath = join(
      test.paths.dataRoot,
      "lifecycle",
      "purge-recovery-capsule",
      "manifest.json",
    );
    const exactLauncher = readFileSync(capsule.launcher);
    const exactManifest = readFileSync(manifestPath);
    writeFileSync(capsule.launcher, "tampered capsule", { mode: 0o600 });
    const forgedManifest = JSON.parse(exactManifest.toString("utf8")) as {
      launcherSha256: string;
    };
    forgedManifest.launcherSha256 = new Bun.CryptoHasher("sha256")
      .update(readFileSync(capsule.launcher))
      .digest("hex");
    writeFileSync(manifestPath, JSON.stringify(forgedManifest), { mode: 0o600 });
    expect(recovery.check).toThrow("signed identity authorization");
    writeFileSync(capsule.launcher, exactLauncher, { mode: 0o600 });
    writeFileSync(manifestPath, exactManifest, { mode: 0o600 });
    const checked = recovery.check();
    const forged = {
      ...checked.plan,
      expected: { ...checked.plan.expected, unknown: "unsafe" },
    };
    await expect(
      recovery.apply(Buffer.from(JSON.stringify(forged), "utf8").toString("base64url")),
    ).rejects.toThrow("plan is invalid");
    const recovered = await recovery.apply(checked.planToken);

    expect(recovered).toMatchObject({ outcome: "recovered", dataIdentity: test.dataIdentity });
    expect(purger.check().plan.evidenceId).toBe(recovered.evidenceId);
    expect(test.native.inspect()).toMatchObject({
      automaticStart: "disabled",
      process: "stopped",
    });

    unlinkSync(join(test.paths.dataRoot, "lifecycle", "purge-safety.json"));
    expect(purger.check).toThrow("missing");
    const missingEvidenceRecovery = recovery.check();
    const recoveredFromMissing = await recovery.apply(missingEvidenceRecovery.planToken);
    expect(purger.check().plan.evidenceId).toBe(recoveredFromMissing.evidenceId);
  }, 30_000);

  it("refuses an old mutation envelope in the fresh post-purge data lifetime", async () => {
    const test = fixture();
    test.database.close(false);
    mkdirSync(join(test.root, "service"), { mode: 0o700 });
    await Effect.runPromise(
      installManagedRelease({
        paths: test.paths,
        serviceDocument: () => "test service\n",
      }),
    );
    const oldDaemon = startDaemon(test.paths, {
      automaticRefresh: false,
      runRestore: () => Effect.void,
    });
    await Effect.runPromise(oldDaemon.ready);
    const oldDataIdentity = oldDaemon.endpoint.dataIdentity;
    await Effect.runPromise(oldDaemon.stop);

    const recovery = new PurgeSafetyRecovery({
      paths: test.paths,
      journal: test.journal,
      nativeService: test.native,
    });
    await recovery.apply(recovery.check().planToken);
    const purger = new DaemonDataPurger({
      paths: test.paths,
      journal: test.journal,
      nativeService: test.native,
    });
    purger.confirm(purger.check().planToken);

    const freshDaemon = startDaemon(test.paths, {
      automaticRefresh: false,
      runRestore: () => Effect.void,
    });
    try {
      await Effect.runPromise(freshDaemon.ready);
      expect(freshDaemon.endpoint.dataIdentity).not.toBe(oldDataIdentity);
      const oldEnvelope: MutationEnvelope = {
        mutationVersion: 1,
        requestId: "request-from-purged-lifetime",
        dataIdentity: oldDataIdentity,
        operation: "registerProject",
        target: {
          identityVersion: 1,
          kind: "daemonData",
          parts: [oldDataIdentity],
        },
        arguments: { location: join(test.root, "old-project") },
        preconditions: {},
      };
      const response = await fetch(
        `http://localhost/api/v1/client-requests/${oldEnvelope.requestId}`,
        {
          unix: freshDaemon.endpoint.socketPath,
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(oldEnvelope),
        } as RequestInit & { readonly unix: string },
      );
      expect(response.status, await response.clone().text()).toBe(422);
      const lookup = await fetch(
        `http://localhost/api/v1/client-requests/${oldEnvelope.requestId}`,
        { unix: freshDaemon.endpoint.socketPath } as RequestInit & { readonly unix: string },
      );
      expect(lookup.status, await lookup.clone().text()).toBe(404);
    } finally {
      await Effect.runPromise(freshDaemon.stop);
      removeManagedInstallation(test.paths);
    }
  }, 30_000);

  it("reuses the same signing identity on restart and discloses all correctness tables", async () => {
    const test = fixture();
    const first = await seal(test);
    const restarted = new SqlitePurgeSafetyRepository(
      test.database,
      test.dataIdentity,
      test.paths.dataRoot,
      test.paths.configurationRoot,
    );
    const replay = await Effect.runPromise(
      restarted.seal(
        "remove-1",
        first.evidence.owner,
        first.evidence.issuedAt,
        first.evidence.expiresAt,
      ),
    );

    expect(replay.evidenceId).toBe(first.evidence.evidenceId);
    expect(replay.correctness.recordsByTable.correctness_history).toBe(1);
    expect(replay.correctness.recordsByTable.daemon_metadata).toBeGreaterThanOrEqual(2);
  });

  it("keeps purge check read-only over Daemon correctness and lifecycle state", async () => {
    const test = fixture();
    await seal(test);
    test.database.close(false);
    const evidencePath = join(test.paths.dataRoot, "lifecycle", "purge-safety.json");
    const before = readFileSync(evidencePath);
    expect(test.journal.current()).toBeUndefined();

    const checked = new DaemonDataPurger({
      paths: test.paths,
      journal: test.journal,
      nativeService: test.native,
      now: () => Date.parse("2026-09-01T10:01:00.000Z"),
    }).check();

    expect(checked.plan.correctness.recordsByTable.correctness_history).toBe(1);
    expect(readFileSync(evidencePath)).toEqual(before);
    expect(test.journal.current()).toBeUndefined();
    expect(existsSync(join(test.paths.configurationRoot, "purge-control", "receipts"))).toBe(false);
  });

  it("refuses evidence that was changed and rehashed without the Daemon private key", async () => {
    const test = fixture();
    await seal(test);
    test.database.close(false);
    const evidencePath = join(test.paths.dataRoot, "lifecycle", "purge-safety.json");
    const changed = JSON.parse(readFileSync(evidencePath, "utf8")) as {
      resourceRisks: unknown[];
      correctness: { runs: number };
      seal: string;
    };
    changed.correctness.runs = 999;
    changed.seal = new Bun.CryptoHasher("sha256").update(JSON.stringify(changed)).digest("hex");
    writeFileSync(evidencePath, JSON.stringify(changed), { mode: 0o600 });
    const purger = new DaemonDataPurger({
      paths: test.paths,
      journal: test.journal,
      nativeService: test.native,
      now: () => Date.parse("2026-09-01T10:01:00.000Z"),
    });

    expect(purger.check).toThrow("not authored by the sole Daemon owner");
  });

  it("refuses stale plans and unresolved Resource leases", async () => {
    const test = fixture();
    test.database.run(`CREATE TABLE project_resource_leases (
      lease_id TEXT, project_id TEXT, run_id TEXT, resource_kind TEXT, state TEXT, reason TEXT
    ) STRICT`);
    test.database.run(
      "INSERT INTO project_resource_leases VALUES ('lease-1', 'project-1', 'run-1', 'sandbox', 'unresolved', 'inspection failed')",
    );
    await seal(test);
    test.database.close(false);
    let now = Date.parse("2026-09-01T10:01:00.000Z");
    const purger = new DaemonDataPurger({
      paths: test.paths,
      journal: test.journal,
      nativeService: test.native,
      now: () => now,
    });
    const checked = purger.check();
    expect(checked.plan.resourceRisks).toMatchObject([{ leaseId: "lease-1" }]);
    expect(() => purger.confirm(checked.planToken)).toThrow("not confirmed released");

    now = Date.parse("2026-09-01T10:11:00.000Z");
    expect(() => purger.confirm(checked.planToken)).toThrow("stale");
  });

  it("refuses an unplanned symbolic link instead of following it", async () => {
    const test = fixture();
    await seal(test);
    test.database.close(false);
    const purger = new DaemonDataPurger({
      paths: test.paths,
      journal: test.journal,
      nativeService: test.native,
      now: () => Date.parse("2026-09-01T10:01:00.000Z"),
    });
    const checked = purger.check();
    symlinkSync(test.root, join(test.paths.dataRoot, "foreign-link"));

    expect(() => purger.confirm(checked.planToken)).toThrow("linked");
    expect(existsSync(test.paths.dataRoot)).toBe(true);
  });

  it("requires stopped ownership and disabled automatic start", async () => {
    const test = fixture("data-old", {
      automaticStart: "enabled",
      manager: "loaded",
      process: "running",
      loginLifetime: "test",
      logoutPersistence: "enabled",
    });
    await seal(test);
    test.database.close(false);
    const purger = new DaemonDataPurger({
      paths: test.paths,
      journal: test.journal,
      nativeService: test.native,
      now: () => Date.parse("2026-09-01T10:01:00.000Z"),
    });
    const checked = purger.check();

    expect(checked.plan.observed).toEqual({ automaticStart: "enabled", process: "running" });
    expect(() => purger.confirm(checked.planToken)).toThrow("stopped ownership");
  });

  it("atomically quarantines one identity, blocks start during interruption, and preserves Projects", async () => {
    const test = fixture();
    const project = join(test.root, "project");
    mkdirSync(join(project, ".git"), { mode: 0o700, recursive: true });
    mkdirSync(join(project, ".kojo"), { mode: 0o700 });
    writeFileSync(join(project, ".git", "branch"), "refs/heads/run-1\n", { mode: 0o600 });
    writeFileSync(join(project, ".kojo", "credential"), "secret\n", { mode: 0o600 });
    await seal(test);
    test.database.close(false);
    const now = () => Date.parse("2026-09-01T10:01:00.000Z");
    const checked = new DaemonDataPurger({
      paths: test.paths,
      journal: test.journal,
      nativeService: test.native,
      now,
    }).check();
    const interrupted = new DaemonDataPurger({
      paths: test.paths,
      journal: test.journal,
      nativeService: test.native,
      now,
      boundary: (stage) => {
        if (stage === "renamed") throw new Error("crash after atomic quarantine");
      },
    });

    expect(() => interrupted.confirm(checked.planToken)).toThrow("crash after atomic quarantine");
    expect(existsSync(test.paths.dataRoot)).toBe(false);
    expect(() => acquireDaemonStartGate(test.paths)).toThrow(
      "must finish before a Daemon can start",
    );

    const result = new DaemonDataPurger({
      paths: test.paths,
      journal: test.journal,
      nativeService: test.native,
      now,
    }).confirm(checked.planToken);
    expect(result).toMatchObject({ outcome: "purged", dataIdentity: "data-old" });
    expect(
      new DaemonDataPurger({
        paths: test.paths,
        nativeService: test.native,
        now,
      }).confirm(checked.planToken),
    ).toEqual(result);
    expect(readFileSync(join(project, ".git", "branch"), "utf8")).toContain("run-1");
    expect(readFileSync(join(project, ".kojo", "credential"), "utf8")).toContain("secret");
  });

  it("publishes a new identity-specific verifier after purge and refuses the old plan", async () => {
    const test = fixture();
    await seal(test);
    test.database.close(false);
    const now = () => Date.parse("2026-09-01T10:01:00.000Z");
    const oldPurger = new DaemonDataPurger({
      paths: test.paths,
      journal: test.journal,
      nativeService: test.native,
      now,
    });
    const oldPlan = oldPurger.check();
    oldPurger.confirm(oldPlan.planToken);

    mkdirSync(join(test.paths.dataRoot, "lifecycle"), { mode: 0o700, recursive: true });
    const nextDatabase = new Database(join(test.paths.dataRoot, "kojo.db"), {
      create: true,
      strict: true,
    });
    chmodSync(join(test.paths.dataRoot, "kojo.db"), 0o600);
    nextDatabase.run(
      "CREATE TABLE daemon_metadata (name TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL) STRICT",
    );
    nextDatabase.run("INSERT INTO daemon_metadata VALUES ('data_identity', 'data-new')");
    writeFileSync(join(test.paths.dataRoot, "lifecycle", "data-identity"), "data-new\n", {
      mode: 0o600,
    });
    const nextRepository = new SqlitePurgeSafetyRepository(
      nextDatabase,
      "data-new",
      test.paths.dataRoot,
      test.paths.configurationRoot,
    );
    await Effect.runPromise(
      nextRepository.seal(
        "remove-new",
        {
          daemonInstanceId: "daemon-new",
          runnerInstanceIds: [],
          recordedAt: "2026-09-01T10:02:00.000Z",
        },
        "2026-09-01T10:02:00.000Z",
        "2026-09-01T10:12:00.000Z",
      ),
    );
    nextDatabase.close(false);
    const nextJournal = new FileLifecycleJournalRepository(join(test.paths.dataRoot, "lifecycle"));
    const nextPurger = new DaemonDataPurger({
      paths: test.paths,
      journal: nextJournal,
      nativeService: test.native,
      now: () => Date.parse("2026-09-01T10:03:00.000Z"),
    });

    expect(nextPurger.check().plan.dataIdentity).toBe("data-new");
    expect(() => nextPurger.confirm(oldPlan.planToken)).toThrow("prior Daemon data lifetime");
  });
});
