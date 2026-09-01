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
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { startDaemon } from "../../../../src/contexts/daemon/adapters/DaemonOwner.ts";
import {
  managedReleaseSelection,
  stageManagedRelease,
} from "../../../../src/contexts/daemon/adapters/ManagedInstallation.ts";
import type { DaemonPaths } from "../../../../src/contexts/daemon/models/DaemonPaths.ts";
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

describe("recoverable managed upgrade activation", () => {
  it("holds ordinary mutations, verifies backup, migrates restricted, and activates without Workflow execution", async () => {
    const root = mkdtempSync(join(tmpdir(), "kojo-upgrade-activation-"));
    let sourceDaemon: ReturnType<typeof startDaemon> | undefined;
    let candidateDaemon: ReturnType<typeof startDaemon> | undefined;
    try {
      const paths = pathsAt(root);
      publishConsoleRelease(paths);
      const candidateSource = join(root, "candidate-source");
      const retainedBun = join(root, "candidate-bun");
      write(join(candidateSource, "package.json"), '{"name":"fixture-kojo","version":"2.0.0"}\n');
      write(
        join(candidateSource, "managed-release.json"),
        '{"formatVersion":1,"compatibility":{"dataFormats":[2],"revisionFormats":[1],"runnerProtocols":[1],"requiredFeatures":[]},"migration":{"fromDataFormat":1,"toDataFormat":2,"rollback":"preserved","description":"Add the fixture activation record transactionally."}}\n',
      );
      write(join(candidateSource, "src", "main.ts"), 'console.log("candidate");\n');
      write(
        join(candidateSource, "src", "launcher", "main.ts"),
        'console.log("candidate launcher");\n',
      );
      write(join(candidateSource, "console", "index.html"), "<html>candidate</html>\n");
      copyFileSync(process.execPath, retainedBun);
      chmodSync(retainedBun, 0o700);
      const candidate = await Effect.runPromise(
        stageManagedRelease({
          paths,
          expectedVersion: "2.0.0",
          sourceRoot: candidateSource,
          bunExecutable: retainedBun,
        }),
      );

      sourceDaemon = startDaemon(paths, { automaticRefresh: false });
      const checkResponse = await fetch("http://localhost/api/v1/daemon/upgrade-check", {
        unix: sourceDaemon.endpoint.socketPath,
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ candidateReleaseId: candidate.releaseId }),
      } as RequestInit & { readonly unix: string });
      const checked = (await checkResponse.json()) as {
        readonly report: { readonly outcome: string; readonly retainedSetHash: string };
      };
      expect(checked.report.outcome).toBe("staged");

      const operationId = "upgrade-activation-one";
      const requestHash = "a".repeat(64);
      await expect(
        Effect.runPromise(
          sourceDaemon.upgradeControl.inspectPreflight(
            "upgrade-activation-mismatched-check",
            sourceDaemon.endpoint.dataIdentity,
            requestHash,
            "kojo-test",
            candidate.releaseId,
            "f".repeat(64),
          ),
        ),
      ).rejects.toThrow(/matching accepted managed upgrade check/);
      const sourceOwner = await Effect.runPromise(
        sourceDaemon.upgradeControl.inspectPreflight(
          operationId,
          sourceDaemon.endpoint.dataIdentity,
          requestHash,
          "kojo-test",
          candidate.releaseId,
          checked.report.retainedSetHash,
        ),
      );
      await Effect.runPromise(sourceDaemon.upgradeControl.beginDrain(operationId));
      await Effect.runPromise(sourceDaemon.upgradeControl.beginDrain(operationId));
      await Effect.runPromise(sourceDaemon.upgradeControl.holdMutations(operationId));
      await Effect.runPromise(sourceDaemon.upgradeControl.holdMutations(operationId));

      const heldResponse = await fetch("http://localhost/api/v1/gate-answers", {
        unix: sourceDaemon.endpoint.socketPath,
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      } as RequestInit & { readonly unix: string });
      expect(await heldResponse.json()).toMatchObject({ code: "daemon-mutations-held" });

      const finalPreflight = await Effect.runPromise(
        sourceDaemon.upgradeControl.repeatFinalPreflight(
          operationId,
          candidate.releaseId,
          checked.report.retainedSetHash,
        ),
      );
      expect(finalPreflight.outcome).toBe("accepted");
      expect(
        await Effect.runPromise(
          sourceDaemon.upgradeControl.repeatFinalPreflight(
            operationId,
            candidate.releaseId,
            checked.report.retainedSetHash,
          ),
        ),
      ).toEqual(finalPreflight);
      const handoff = await Effect.runPromise(
        sourceDaemon.upgradeControl.prepareHandoff(operationId),
      );
      expect(
        await Effect.runPromise(sourceDaemon.upgradeControl.prepareHandoff(operationId)),
      ).toEqual(handoff);
      await Effect.runPromise(
        sourceDaemon.upgradeControl.confirmControllerReady(operationId, handoff.digest),
      );
      await Effect.runPromise(
        sourceDaemon.upgradeControl.confirmControllerReady(operationId, handoff.digest),
      );
      write(
        join(paths.dataRoot, "lifecycle", "backups", `${operationId}.sqlite.staging`),
        "interrupted backup",
      );
      const backup = await Effect.runPromise(
        sourceDaemon.upgradeControl.createVerifiedBackup(operationId),
      );
      expect(backup.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(
        await Effect.runPromise(sourceDaemon.upgradeControl.createVerifiedBackup(operationId)),
      ).toEqual(backup);
      await Effect.runPromise(sourceDaemon.upgradeControl.stopOwnedProcesses(operationId, 30_000));
      await Effect.runPromise(sourceDaemon.upgradeControl.stopOwnedProcesses(operationId, 30_000));
      await Effect.runPromise(sourceDaemon.stop);
      sourceDaemon = undefined;

      expect(managedReleaseSelection(paths).select("kojo-test", candidate.releaseId)).toBe(
        candidate.releaseId,
      );
      let candidateRestoreCalls = 0;
      let candidateReadyCalls = 0;
      candidateDaemon = startDaemon(paths, {
        automaticRefresh: false,
        runRestore: () =>
          Effect.sync(() => {
            candidateRestoreCalls += 1;
          }),
        managedSupervision: {
          recordReady: () => {
            candidateReadyCalls += 1;
          },
          recordPlannedStop: () => undefined,
          activatePolicy: () => undefined,
        },
        upgradeMigration: ({ database, operationId: migrationOperationId }) => {
          database.run(
            "CREATE TABLE upgrade_activation_fixture (operation_id TEXT PRIMARY KEY NOT NULL)",
          );
          database.run("INSERT INTO upgrade_activation_fixture VALUES (?)", [migrationOperationId]);
          return { checkpoint: "fixture-migration-committed" };
        },
      });
      await Effect.runPromise(candidateDaemon.ready);
      expect(candidateRestoreCalls).toBe(0);
      expect(candidateReadyCalls).toBe(0);
      await expect(
        Effect.runPromise(
          candidateDaemon.upgradeControl.readCandidateReadiness(
            operationId,
            candidateDaemon.endpoint.instanceId,
          ),
        ),
      ).rejects.toThrow(/new Daemon owner/);
      expect(candidateRestoreCalls).toBe(0);
      expect(candidateReadyCalls).toBe(0);
      const candidateReadiness = await Effect.runPromise(
        candidateDaemon.upgradeControl.readCandidateReadiness(
          operationId,
          sourceOwner.daemonInstanceId,
        ),
      );
      expect(candidateReadiness).toMatchObject({
        daemonInstanceId: candidateDaemon.endpoint.instanceId,
        dataIdentity: candidateDaemon.endpoint.dataIdentity,
        candidateReleaseId: candidate.releaseId,
        integrity: "ok",
        transports: "ready",
        workflowExecutions: 0,
      });
      expect(candidateRestoreCalls).toBe(0);
      expect(candidateReadyCalls).toBe(1);
      expect(
        await Effect.runPromise(
          candidateDaemon.upgradeControl.readCandidateReadiness(
            operationId,
            sourceOwner.daemonInstanceId,
          ),
        ),
      ).toEqual(candidateReadiness);
      await Effect.runPromise(
        candidateDaemon.upgradeControl.authorizeActivation(operationId, candidateReadiness),
      );
      expect(candidateRestoreCalls).toBe(1);
      await Effect.runPromise(
        candidateDaemon.upgradeControl.authorizeActivation(operationId, candidateReadiness),
      );

      const noLongerHeld = await fetch("http://localhost/api/v1/gate-answers", {
        unix: candidateDaemon.endpoint.socketPath,
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      } as RequestInit & { readonly unix: string });
      expect((await noLongerHeld.json()) as { readonly code: string }).not.toMatchObject({
        code: "daemon-mutations-held",
      });
      await Effect.runPromise(candidateDaemon.stop);
      candidateDaemon = undefined;

      const database = new Database(join(paths.dataRoot, "kojo.db"), {
        readonly: true,
        strict: true,
      });
      try {
        expect(
          database
            .query<{ readonly value: string }, []>(
              "SELECT value FROM daemon_metadata WHERE name = 'data_format_version'",
            )
            .get()?.value,
        ).toBe("2");
        expect(
          database
            .query<{ readonly operation_id: string }, []>(
              "SELECT operation_id FROM upgrade_activation_fixture",
            )
            .get()?.operation_id,
        ).toBe(operationId);
        const receipt = database
          .query<{ readonly receipt_json: string }, [string]>(
            "SELECT receipt_json FROM daemon_upgrade_activation_receipts WHERE operation_id = ?",
          )
          .get(operationId);
        expect(JSON.parse(receipt?.receipt_json ?? "null")).toMatchObject({
          stage: "activation-authorized",
          dispatchHeld: false,
          mutationsHeld: false,
          migrationCheckpoint: "fixture-migration-committed",
        });
      } finally {
        database.close(false);
      }
      expect(
        readFileSync(join(paths.dataRoot, "lifecycle", "backups", `${operationId}.sqlite`))
          .byteLength,
      ).toBeGreaterThan(0);
      expect(
        lstatSync(join(paths.dataRoot, "lifecycle", "backups", `${operationId}.sqlite`)).mode &
          0o777,
      ).toBe(0o400);
    } finally {
      if (sourceDaemon !== undefined) await Effect.runPromise(sourceDaemon.stop).catch(() => {});
      if (candidateDaemon !== undefined)
        await Effect.runPromise(candidateDaemon.stop).catch(() => {});
      removeTree(root);
    }
  }, 30_000);
});
