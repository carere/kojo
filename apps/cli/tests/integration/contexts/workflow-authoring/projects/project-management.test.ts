import { Database } from "bun:sqlite";
import {
  chmod,
  cp,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  makeTemporaryDirectory,
  runKojoCli as runCli,
} from "../../../../../../../tests/support/cli-process";
import { startKojoHostProcess } from "../../../../../../../tests/support/host-process";

const cleanups: Array<() => Promise<void>> = [];
const workflowPackagePath = fileURLToPath(
  new URL("../../../../../../../packages/workflow", import.meta.url),
);

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("Kojo Project discovery", () => {
  it("rejects an empty replacement for an initialized Project database", async () => {
    const directory = await temporaryDirectory("kojo-project-replaced-store-");
    const project = join(directory, "project");
    await git(["init", project]);
    const unavailableSocket = join(directory, "missing.sock");
    expect((await runCli(["init", project], unavailableSocket, directory)).exitCode).toBe(0);
    const databasePath = join(project, ".kojo", "kojo.sqlite");
    await unlink(databasePath);
    const replacement = new Database(databasePath, { create: true });
    replacement.exec("PRAGMA user_version = 0");
    replacement.close();
    await chmod(databasePath, 0o600);

    const repeated = await runCli(["init", project, "--json"], unavailableSocket, directory);
    expect(repeated.exitCode).toBe(1);
    expect(JSON.parse(repeated.stdout).error.code).toBe("project-initialization-failed");
  });

  it("rejects a version-zero migration backup bound to another Project", async () => {
    const directory = await temporaryDirectory("kojo-project-foreign-v0-backup-");
    const first = join(directory, "first");
    const second = join(directory, "second");
    await git(["init", first]);
    await git(["init", second]);
    const unavailableSocket = join(directory, "missing.sock");
    expect((await runCli(["init", first], unavailableSocket, directory)).exitCode).toBe(0);
    expect((await runCli(["init", second], unavailableSocket, directory)).exitCode).toBe(0);
    const secondDatabase = join(second, ".kojo", "kojo.sqlite");
    await cp(join(first, ".kojo", "kojo.sqlite"), `${secondDatabase}.migration-backup`);
    await chmod(`${secondDatabase}.migration-backup`, 0o600);

    const host = await startKojoHostProcess();
    cleanups.push(host.stop);
    const refused = await runCli(
      ["project", "register", second, "--request-key", "foreign-v0", "--json"],
      host.socketPath,
      directory,
    );
    expect(refused.exitCode).toBe(1);
    expect(JSON.parse(refused.stdout).error.findingKeys).toEqual(["store.migration-failed"]);
    expect(await Bun.file(`${secondDatabase}.migration-backup`).exists()).toBe(true);
  });

  it("filters and paginates Project lists with the settled JSON envelope", async () => {
    const directory = await temporaryDirectory("kojo-project-list-page-");
    const host = await startKojoHostProcess();
    cleanups.push(host.stop);
    const projects = ["first", "second", "damaged"].map((name) => join(directory, name));
    for (const project of projects) {
      await git(["init", project]);
      expect((await runCli(["init", project], host.socketPath, directory)).exitCode).toBe(0);
    }
    await Bun.write(join(projects[2], "kojo.config.ts"), "export default {}\n");

    const firstPage = await runCli(
      ["project", "list", "--condition", "ready", "--limit", "1", "--json"],
      host.socketPath,
      directory,
    );
    const firstResult = JSON.parse(firstPage.stdout).result;
    expect(firstResult.items).toHaveLength(1);
    expect(firstResult.items[0].condition).toBe("ready");
    expect(firstResult.nextCursor).toEqual(expect.any(String));

    const secondPage = await runCli(
      [
        "project",
        "list",
        "--condition",
        "ready",
        "--limit",
        "1",
        "--cursor",
        firstResult.nextCursor,
        "--json",
      ],
      host.socketPath,
      directory,
    );
    expect(JSON.parse(secondPage.stdout).result).toMatchObject({
      items: [expect.objectContaining({ condition: "ready" })],
      nextCursor: null,
    });

    const combined = await runCli(
      ["project", "list", "--condition", "ready", "--condition", "needs-attention", "--json"],
      host.socketPath,
      directory,
    );
    expect(JSON.parse(combined.stdout).result.items).toHaveLength(3);

    const malformed = await runCli(
      ["project", "list", "--cursor", "not-a-cursor", "--json"],
      host.socketPath,
      directory,
    );
    expect(malformed.exitCode).toBe(2);
    expect(JSON.parse(malformed.stdout).error.code).toBe("project-cursor-malformed");

    const decodedCursor = JSON.parse(
      Buffer.from(firstResult.nextCursor, "base64url").toString("utf8"),
    );
    decodedCursor.version = 2;
    const unsupportedCursor = Buffer.from(JSON.stringify(decodedCursor)).toString("base64url");
    const unsupported = await runCli(
      ["project", "list", "--cursor", unsupportedCursor, "--json"],
      host.socketPath,
      directory,
    );
    expect(unsupported.exitCode).toBe(2);
    expect(JSON.parse(unsupported.stdout).error.code).toBe("project-cursor-version-unsupported");

    const mismatched = await runCli(
      [
        "project",
        "list",
        "--condition",
        "needs-attention",
        "--cursor",
        firstResult.nextCursor,
        "--json",
      ],
      host.socketPath,
      directory,
    );
    expect(mismatched.exitCode).toBe(2);
    expect(JSON.parse(mismatched.stdout).error.code).toBe("project-cursor-filter-mismatch");

    expect(
      (
        await runCli(
          ["project", "forget", "--project-id", firstResult.items[0].identity],
          host.socketPath,
          directory,
        )
      ).exitCode,
    ).toBe(0);
    const continuedAfterDeletedAnchor = await runCli(
      ["project", "list", "--condition", "ready", "--cursor", firstResult.nextCursor, "--json"],
      host.socketPath,
      directory,
    );
    expect(continuedAfterDeletedAnchor.exitCode).toBe(0);
    expect(JSON.parse(continuedAfterDeletedAnchor.stdout).result).toMatchObject({
      items: [expect.objectContaining({ condition: "ready" })],
      nextCursor: null,
    });

    expect(
      (await runCli(["project", "list", "--limit", "201"], host.socketPath, directory)).exitCode,
    ).toBe(2);
  }, 15_000);

  it("selects Projects beyond the first 200 authoritative Index entries", async () => {
    const directory = await temporaryDirectory("kojo-project-large-index-");
    const hostStore = join(directory, "host-store");
    await mkdir(hostStore, { mode: 0o700 });
    const projects = Array.from({ length: 201 }, (_, index) => ({
      identity: `00000000-0000-7000-8000-${index.toString(16).padStart(12, "0")}`,
      path: join(directory, `missing-project-${index}`),
    }));
    const indexPath = join(hostStore, "projects.json");
    await Bun.write(
      indexPath,
      `${JSON.stringify({ layoutVersion: 1, projects, receipts: [] }, null, 2)}\n`,
    );
    await chmod(indexPath, 0o600);
    const host = await startKojoHostProcess({ storePath: hostStore });
    cleanups.push(host.stop);

    const selected = await runCli(
      ["project", "show", "--project-id", projects[200].identity, "--json"],
      host.socketPath,
      directory,
    );

    expect(selected.exitCode).toBe(0);
    expect(JSON.parse(selected.stdout).result.project).toEqual(projects[200]);
  });

  it("lists, selects, shows, registers, and forgets Host-authoritative Projects", async () => {
    const directory = await temporaryDirectory("kojo-project-management-");
    const project = join(directory, "project");
    await git(["init", project]);
    const host = await startKojoHostProcess();
    cleanups.push(host.stop);
    expect((await runCli(["init", project], host.socketPath, directory)).exitCode).toBe(0);
    const metadataPath = join(project, ".kojo", "project.json");
    const identity = JSON.parse(await readFile(metadataPath, "utf8")).projectIdentity as string;
    const canonicalProject = await realpath(project);

    const list = await runCli(["project", "list", "--json"], host.socketPath, directory);
    expect(list.exitCode).toBe(0);
    expect(JSON.parse(list.stdout).result.items).toEqual([
      { identity, path: canonicalProject, condition: "ready" },
    ]);

    const nested = join(project, ".kojo", "artifacts");
    const inferred = await runCli(["project", "show"], host.socketPath, nested);
    const byPath = await runCli(
      ["project", "show", "--project", project, "--json"],
      host.socketPath,
      directory,
    );
    const byIdentity = await runCli(
      ["project", "show", "--project-id", identity, "--json"],
      host.socketPath,
      directory,
    );

    expect(inferred.stdout).toContain(`Project Identity: ${identity}`);
    expect(JSON.parse(byPath.stdout).result.project.identity).toBe(identity);
    expect(JSON.parse(byIdentity.stdout).result.project.path).toBe(canonicalProject);

    const rejectedSelector = await runCli(
      ["project", "list", "--project-id", identity],
      host.socketPath,
      directory,
    );
    expect(rejectedSelector.exitCode).toBe(2);

    const forgotten = await runCli(
      ["project", "forget", "--project-id", identity],
      host.socketPath,
      directory,
    );
    expect(forgotten.exitCode).toBe(0);
    expect(forgotten.stdout).toContain("Project files were not changed");
    expect(JSON.parse(await readFile(metadataPath, "utf8")).projectIdentity).toBe(identity);
    expect(
      JSON.parse((await runCli(["project", "list", "--json"], host.socketPath, directory)).stdout)
        .result.items,
    ).toEqual([]);

    const registered = await runCli(
      ["project", "register", nested, "--json"],
      host.socketPath,
      directory,
    );
    expect(registered, registered.stderr).toMatchObject({ exitCode: 0 });
    expect(JSON.parse(registered.stdout).result.project).toEqual({
      identity,
      path: canonicalProject,
    });
  });

  it("updates an indexed path after a working tree moves", async () => {
    const directory = await temporaryDirectory("kojo-project-move-");
    const project = join(directory, "project");
    const moved = join(directory, "moved-project");
    await git(["init", project]);
    const host = await startKojoHostProcess();
    cleanups.push(host.stop);
    expect((await runCli(["init", project], host.socketPath, directory)).exitCode).toBe(0);
    const identity = JSON.parse(await readFile(join(project, ".kojo", "project.json"), "utf8"))
      .projectIdentity as string;

    await rename(project, moved);
    const registered = await runCli(
      ["project", "register", moved, "--json"],
      host.socketPath,
      directory,
    );

    expect(registered.exitCode).toBe(0);
    expect(JSON.parse(registered.stdout).result.project).toEqual({
      identity,
      path: await realpath(moved),
    });
    const projects = JSON.parse(
      (await runCli(["project", "list", "--json"], host.socketPath, directory)).stdout,
    ).result.items;
    expect(projects).toEqual([{ identity, path: await realpath(moved), condition: "ready" }]);
  });

  it("rejects one Project Identity at two live working-tree paths", async () => {
    const directory = await temporaryDirectory("kojo-project-duplicate-");
    const project = join(directory, "project");
    const duplicate = join(directory, "duplicate");
    await git(["init", project]);
    const host = await startKojoHostProcess();
    cleanups.push(host.stop);
    expect((await runCli(["init", project], host.socketPath, directory)).exitCode).toBe(0);
    await cp(project, duplicate, { recursive: true });

    const result = await runCli(
      ["project", "register", duplicate, "--json"],
      host.socketPath,
      directory,
    );

    expect(result.exitCode).toBe(4);
    expect(JSON.parse(result.stdout)).toMatchObject({
      requestKey: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
      error: { code: "project-identity-duplicate" },
    });
    expect(result.stderr).toContain("same Project Identity is present at two working-tree paths");
  });

  it("rejects registration when Kojo Configuration or the Project database is invalid", async () => {
    const directory = await temporaryDirectory("kojo-project-invalid-layout-");
    const host = await startKojoHostProcess();
    cleanups.push(host.stop);

    const invalidConfiguration = join(directory, "invalid-configuration");
    await git(["init", invalidConfiguration]);
    expect(
      (await runCli(["init", invalidConfiguration], host.socketPath, directory)).exitCode,
    ).toBe(0);
    const configurationIdentity = JSON.parse(
      await readFile(join(invalidConfiguration, ".kojo", "project.json"), "utf8"),
    ).projectIdentity as string;
    expect(
      (
        await runCli(
          ["project", "forget", "--project-id", configurationIdentity],
          host.socketPath,
          directory,
        )
      ).exitCode,
    ).toBe(0);
    await Bun.write(
      join(invalidConfiguration, "kojo.config.ts"),
      'export default { workflows: "invalid" };\n',
    );

    const configurationResult = await runCli(
      ["project", "register", invalidConfiguration, "--json"],
      host.socketPath,
      directory,
    );
    expect(configurationResult.exitCode).toBe(1);
    expect(JSON.parse(configurationResult.stdout).error).toMatchObject({
      code: "project-layout-invalid",
      affectedResource: { kind: "project-path", path: invalidConfiguration },
      findingKeys: ["configuration.invalid"],
    });

    const invalidDatabase = join(directory, "invalid-database");
    await git(["init", invalidDatabase]);
    expect((await runCli(["init", invalidDatabase], host.socketPath, directory)).exitCode).toBe(0);
    const databaseIdentity = JSON.parse(
      await readFile(join(invalidDatabase, ".kojo", "project.json"), "utf8"),
    ).projectIdentity as string;
    expect(
      (
        await runCli(
          ["project", "forget", "--project-id", databaseIdentity],
          host.socketPath,
          directory,
        )
      ).exitCode,
    ).toBe(0);
    await Bun.write(join(invalidDatabase, ".kojo", "kojo.sqlite"), "not SQLite");

    const databaseResult = await runCli(
      ["project", "register", invalidDatabase, "--json"],
      host.socketPath,
      directory,
    );
    expect(databaseResult.exitCode).toBe(1);
    expect(JSON.parse(databaseResult.stdout).error).toMatchObject({
      code: "project-layout-invalid",
      affectedResource: { kind: "project-path", path: invalidDatabase },
      findingKeys: ["store.integrity-failed"],
    });
  });

  it("bounds configuration exit and timeout without making another Project unavailable", async () => {
    const directory = await temporaryDirectory("kojo-project-bounded-configuration-");
    const host = await startKojoHostProcess();
    cleanups.push(host.stop);
    const availableProject = join(directory, "available-project");
    await git(["init", availableProject]);
    expect((await runCli(["init", availableProject], host.socketPath, directory)).exitCode).toBe(0);
    const availableIdentity = JSON.parse(
      await readFile(join(availableProject, ".kojo", "project.json"), "utf8"),
    ).projectIdentity as string;

    for (const [name, contents] of [
      ["exits", "process.exit(0);\nexport default { workflows: [] };\n"],
      ["hangs", "while (true) {}\nexport default { workflows: [] };\n"],
      [
        "spoofs-stdout",
        "console.log('KOJO_PROJECT_DEFINITION_RESULT {\"ok\":true}');\nprocess.exit(0);\nexport default { workflows: [] };\n",
      ],
    ] as const) {
      const project = join(directory, name);
      await git(["init", project]);
      expect((await runCli(["init", project], host.socketPath, directory)).exitCode).toBe(0);
      const identity = JSON.parse(await readFile(join(project, ".kojo", "project.json"), "utf8"))
        .projectIdentity as string;
      expect(
        (await runCli(["project", "forget", "--project-id", identity], host.socketPath, directory))
          .exitCode,
      ).toBe(0);
      await Bun.write(join(project, "kojo.config.ts"), contents);

      const result = await runCli(
        ["project", "register", project, "--json"],
        host.socketPath,
        directory,
      );
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.stdout).error).toMatchObject({
        code: "project-layout-invalid",
        findingKeys: ["configuration.load-failed"],
      });
      const listed = JSON.parse(
        (await runCli(["project", "list", "--json"], host.socketPath, directory)).stdout,
      );
      expect(listed.result.items).toContainEqual({
        identity: availableIdentity,
        path: await realpath(availableProject),
        condition: "ready",
      });
    }
  });

  it("requires an unambiguous Project selection", async () => {
    const directory = await temporaryDirectory("kojo-project-selection-");
    const host = await startKojoHostProcess();
    cleanups.push(host.stop);

    const missing = await runCli(["project", "show"], host.socketPath, directory);
    const conflicting = await runCli(
      [
        "project",
        "show",
        "--project",
        directory,
        "--project-id",
        "00000000-0000-7000-8000-000000000000",
      ],
      host.socketPath,
      directory,
    );

    expect(missing.exitCode).toBe(4);
    expect(missing.stderr).toContain("could not be inferred");
    expect(conflicting.exitCode).toBe(2);
  });

  it("blocks forget through the control boundary for enabled Schedules and non-final Runs", async () => {
    const directory = await temporaryDirectory("kojo-project-forget-blockers-");
    const host = await startKojoHostProcess();
    cleanups.push(host.stop);

    const scheduledProject = join(directory, "scheduled-project");
    await git(["init", scheduledProject]);
    expect((await runCli(["init", scheduledProject], host.socketPath, directory)).exitCode).toBe(0);
    const scheduledIdentity = JSON.parse(
      await readFile(join(scheduledProject, ".kojo", "project.json"), "utf8"),
    ).projectIdentity as string;
    const scheduleDatabase = new Database(join(scheduledProject, ".kojo", "kojo.sqlite"));
    scheduleDatabase.exec(
      "INSERT INTO kojo_workflow_schedule_states(schedule_key, enabled_intent, condition, row_version, created_at_ms, updated_at_ms) VALUES ('nightly', 1, 'available', 1, 1, 1);",
    );
    scheduleDatabase.close();

    const scheduleKey = "10000000-0000-4000-8000-000000000020";
    const scheduleResult = await runCli(
      [
        "project",
        "forget",
        "--project-id",
        scheduledIdentity,
        "--request-key",
        scheduleKey,
        "--json",
      ],
      host.socketPath,
      directory,
    );
    expect(scheduleResult.exitCode).toBe(4);
    expect(JSON.parse(scheduleResult.stdout)).toMatchObject({
      requestKey: scheduleKey,
      error: { code: "project-forget-blocked" },
    });

    const runningProject = join(directory, "running-project");
    await git(["init", runningProject]);
    expect((await runCli(["init", runningProject], host.socketPath, directory)).exitCode).toBe(0);
    const runningIdentity = JSON.parse(
      await readFile(join(runningProject, ".kojo", "project.json"), "utf8"),
    ).projectIdentity as string;
    const runDatabase = new Database(join(runningProject, ".kojo", "kojo.sqlite"));
    runDatabase.exec(
      "INSERT INTO kojo_workflow_runs(run_id, start_request_key, start_request_sha256, workflow_key, workflow_revision, engine_reference_version, engine_reference_json, engine_reference_sha256, trigger_kind, state, row_version, accepted_at_ms, updated_at_ms) VALUES ('run-in-progress', 'start-key', zeroblob(32), 'workflow', 'revision', 1, '{}', zeroblob(32), 'manual', 'running', 1, 1, 1);",
    );
    runDatabase.close();

    const runKey = "10000000-0000-4000-8000-000000000021";
    const runResult = await runCli(
      ["project", "forget", "--project-id", runningIdentity, "--request-key", runKey, "--json"],
      host.socketPath,
      directory,
    );
    expect(runResult.exitCode).toBe(4);
    expect(JSON.parse(runResult.stdout)).toMatchObject({
      requestKey: runKey,
      error: { code: "project-forget-blocked" },
    });
  });

  it("fails closed without recreating a missing Project database during forget", async () => {
    const directory = await temporaryDirectory("kojo-project-missing-store-forget-");
    const project = join(directory, "project");
    await git(["init", project]);
    const host = await startKojoHostProcess();
    cleanups.push(host.stop);
    expect((await runCli(["init", project], host.socketPath, directory)).exitCode).toBe(0);
    const identity = JSON.parse(await readFile(join(project, ".kojo", "project.json"), "utf8"))
      .projectIdentity as string;
    const databasePath = join(project, ".kojo", "kojo.sqlite");
    await unlink(databasePath);

    const forgotten = await runCli(
      [
        "project",
        "forget",
        "--project-id",
        identity,
        "--request-key",
        "missing-store-key",
        "--json",
      ],
      host.socketPath,
      directory,
    );

    expect(forgotten.exitCode).toBe(4);
    expect(JSON.parse(forgotten.stdout).error).toMatchObject({
      code: "project-forget-blocked",
      findingKeys: ["store.open-failed"],
    });
    expect(await Bun.file(databasePath).exists()).toBe(false);
  });

  it("marks an indexed Project needs-attention when Project metadata identity changes", async () => {
    const directory = await temporaryDirectory("kojo-project-identity-drift-");
    const project = join(directory, "project");
    await git(["init", project]);
    const host = await startKojoHostProcess();
    cleanups.push(host.stop);
    expect((await runCli(["init", project], host.socketPath, directory)).exitCode).toBe(0);
    const metadataPath = join(project, ".kojo", "project.json");
    const indexedIdentity = JSON.parse(await readFile(metadataPath, "utf8")).projectIdentity;
    await Bun.write(
      metadataPath,
      `${JSON.stringify({
        layoutVersion: 1,
        projectIdentity: "00000000-0000-7000-8000-000000000099",
      })}\n`,
    );
    await chmod(metadataPath, 0o600);

    const listed = await runCli(["project", "list", "--json"], host.socketPath, directory);

    expect(listed.exitCode).toBe(0);
    expect(JSON.parse(listed.stdout).result.items).toContainEqual({
      identity: indexedIdentity,
      path: await realpath(project),
      condition: "needs-attention",
    });
  });

  it("restores and removes a pending verified migration backup before accepting registration", async () => {
    const directory = await temporaryDirectory("kojo-project-migration-recovery-");
    const hostStore = join(directory, "host-store");
    const project = join(directory, "project");
    await git(["init", project]);
    const firstHost = await startKojoHostProcess({ storePath: hostStore });
    expect((await runCli(["init", project], firstHost.socketPath, directory)).exitCode).toBe(0);
    await firstHost.stop();
    const databasePath = join(project, ".kojo", "kojo.sqlite");
    const backupPath = `${databasePath}.migration-backup`;
    const backupSource = new Database(databasePath, { readonly: true });
    backupSource.query("VACUUM INTO ?").run(backupPath);
    backupSource.close();
    await chmod(backupPath, 0o600);
    const database = new Database(databasePath);
    database.exec(
      "INSERT INTO kojo_retention_policy(singleton_key, row_version, updated_at_ms) VALUES (1, 1, 1)",
    );
    database.close();

    const restartedHost = await startKojoHostProcess({ storePath: hostStore });
    cleanups.push(restartedHost.stop);
    const registered = await runCli(
      ["project", "register", project, "--request-key", "migration-recovery", "--json"],
      restartedHost.socketPath,
      directory,
    );

    expect(registered, registered.stderr).toMatchObject({ exitCode: 0 });
    expect(await Bun.file(backupPath).exists()).toBe(false);
    const restored = new Database(databasePath, { readonly: true });
    expect(restored.query("SELECT * FROM kojo_retention_policy").all()).toEqual([]);
    restored.close();
  });

  it("quiesces an active Workflow backend before recovery and owns the restored database", async () => {
    const directory = await temporaryDirectory("kojo-project-active-recovery-");
    const project = join(directory, "project");
    await git(["init", project]);
    const firstHost = await startKojoHostProcess();
    expect((await runCli(["init", project], firstHost.socketPath, directory)).exitCode).toBe(0);
    const databasePath = join(project, ".kojo", "kojo.sqlite");
    const backupPath = `${databasePath}.migration-backup`;
    const backupSource = new Database(databasePath, { readonly: true });
    backupSource.query("VACUUM INTO ?").run(backupPath);
    backupSource.close();
    await chmod(backupPath, 0o600);
    const changed = new Database(databasePath);
    changed.exec(
      "INSERT INTO kojo_retention_policy(singleton_key, row_version, updated_at_ms) VALUES (1, 1, 1)",
    );
    changed.close();

    const recovered = await runCli(
      ["project", "register", project, "--request-key", "active-recovery", "--json"],
      firstHost.socketPath,
      directory,
    );
    expect(recovered, recovered.stderr).toMatchObject({ exitCode: 0 });
    const restored = new Database(databasePath, { readonly: true });
    expect(restored.query("SELECT * FROM kojo_retention_policy").all()).toEqual([]);
    restored.close();

    const secondHost = await startKojoHostProcess();
    cleanups.push(secondHost.stop);
    const contended = await runCli(
      ["project", "register", project, "--request-key", "restored-contended", "--json"],
      secondHost.socketPath,
      directory,
    );
    expect(contended.exitCode).toBe(1);
    await firstHost.stop();
    const reacquired = await runCli(
      ["project", "register", project, "--request-key", "restored-reacquired", "--json"],
      secondHost.socketPath,
      directory,
    );
    expect(reacquired, reacquired.stderr).toMatchObject({ exitCode: 0 });
  });

  it("rejects a pending migration backup owned by another Project", async () => {
    const directory = await temporaryDirectory("kojo-project-foreign-backup-");
    const hostStore = join(directory, "host-store");
    const firstProject = join(directory, "first");
    const secondProject = join(directory, "second");
    await git(["init", firstProject]);
    await git(["init", secondProject]);
    const firstHost = await startKojoHostProcess({ storePath: hostStore });
    expect((await runCli(["init", firstProject], firstHost.socketPath, directory)).exitCode).toBe(
      0,
    );
    expect((await runCli(["init", secondProject], firstHost.socketPath, directory)).exitCode).toBe(
      0,
    );
    await firstHost.stop();
    const secondDatabase = join(secondProject, ".kojo", "kojo.sqlite");
    const secondContents = await Bun.file(secondDatabase).arrayBuffer();
    const foreignBackup = `${secondDatabase}.migration-backup`;
    const foreignSource = new Database(join(firstProject, ".kojo", "kojo.sqlite"), {
      readonly: true,
    });
    foreignSource.query("VACUUM INTO ?").run(foreignBackup);
    foreignSource.close();
    await chmod(foreignBackup, 0o600);

    const restartedHost = await startKojoHostProcess({ storePath: hostStore });
    cleanups.push(restartedHost.stop);
    const registered = await runCli(
      ["project", "register", secondProject, "--request-key", "foreign-backup", "--json"],
      restartedHost.socketPath,
      directory,
    );

    expect(registered.exitCode).toBe(1);
    expect(JSON.parse(registered.stdout).error.findingKeys).toEqual(["store.migration-failed"]);
    expect(await Bun.file(secondDatabase).arrayBuffer()).toEqual(secondContents);
    expect(await Bun.file(foreignBackup).exists()).toBe(true);
  });

  it("finds indexed Projects after the Host restarts", async () => {
    const directory = await temporaryDirectory("kojo-project-restart-");
    const hostStore = join(directory, "host-store");
    const project = join(directory, "project");
    await git(["init", project]);
    const firstHost = await startKojoHostProcess({ storePath: hostStore });
    expect((await runCli(["init", project], firstHost.socketPath, directory)).exitCode).toBe(0);
    const identity = JSON.parse(await readFile(join(project, ".kojo", "project.json"), "utf8"))
      .projectIdentity as string;
    await firstHost.stop();

    const restartedHost = await startKojoHostProcess({ storePath: hostStore });
    cleanups.push(restartedHost.stop);
    const projects = JSON.parse(
      (await runCli(["project", "list", "--json"], restartedHost.socketPath, directory)).stdout,
    ).result.items;

    expect(projects).toEqual([{ identity, path: await realpath(project), condition: "ready" }]);
  });

  it("rejects incompatible Workflow backend metadata before engine activation", async () => {
    const directory = await temporaryDirectory("kojo-project-engine-compatibility-");
    const hostStore = join(directory, "host-store");
    const project = join(directory, "project");
    await git(["init", project]);
    const firstHost = await startKojoHostProcess({ storePath: hostStore });
    expect((await runCli(["init", project], firstHost.socketPath, directory)).exitCode).toBe(0);
    await firstHost.stop();
    const databasePath = join(project, ".kojo", "kojo.sqlite");
    const database = new Database(databasePath);
    database.exec("UPDATE kojo_store_metadata SET effect_family_version = 'future-effect'");
    database.close();

    const restartedHost = await startKojoHostProcess({ storePath: hostStore });
    cleanups.push(restartedHost.stop);
    const refused = await runCli(
      ["project", "register", project, "--request-key", "incompatible-engine", "--json"],
      restartedHost.socketPath,
      directory,
    );
    expect(refused.exitCode).toBe(1);
    expect(JSON.parse(refused.stdout).error.findingKeys).toEqual(["store.migration-failed"]);
    expect(await Bun.file(`${databasePath}.migration-backup`).exists()).toBe(false);
  });

  it("blocks a second Host from acquiring Workflow ownership for the same Project", async () => {
    const directory = await temporaryDirectory("kojo-project-engine-owner-");
    const project = join(directory, "project");
    await git(["init", project]);
    const firstHost = await startKojoHostProcess();
    cleanups.push(firstHost.stop);
    expect((await runCli(["init", project], firstHost.socketPath, directory)).exitCode).toBe(0);
    const secondHost = await startKojoHostProcess();
    cleanups.push(secondHost.stop);

    const refused = await runCli(
      ["project", "register", project, "--request-key", "second-engine-owner", "--json"],
      secondHost.socketPath,
      directory,
    );

    expect(refused.exitCode).toBe(1);
    expect(JSON.parse(refused.stdout).error.findingKeys).toEqual(["store.migration-failed"]);
    const firstView = await runCli(["project", "list", "--json"], firstHost.socketPath, directory);
    expect(JSON.parse(firstView.stdout).result.items).toMatchObject([{ condition: "ready" }]);
  });

  it("releases Workflow ownership after forget so another Host can reacquire", async () => {
    const directory = await temporaryDirectory("kojo-project-forget-reacquire-");
    const project = join(directory, "project");
    await git(["init", project]);
    const firstHost = await startKojoHostProcess();
    cleanups.push(firstHost.stop);
    expect((await runCli(["init", project], firstHost.socketPath, directory)).exitCode).toBe(0);
    const identity = JSON.parse(await readFile(join(project, ".kojo", "project.json"), "utf8"))
      .projectIdentity as string;
    expect(
      (
        await runCli(
          ["project", "forget", "--project-id", identity, "--request-key", "release-owner"],
          firstHost.socketPath,
          directory,
        )
      ).exitCode,
    ).toBe(0);

    const secondHost = await startKojoHostProcess();
    cleanups.push(secondHost.stop);
    const registered = await runCli(
      ["project", "register", project, "--request-key", "reacquire-after-forget", "--json"],
      secondHost.socketPath,
      directory,
    );
    expect(registered, registered.stderr).toMatchObject({ exitCode: 0 });
  });

  it("keeps concurrent register and forget ownership consistent with the Project Index", async () => {
    const directory = await temporaryDirectory("kojo-project-register-forget-race-");
    const project = join(directory, "project");
    await git(["init", project]);
    const firstHost = await startKojoHostProcess();
    cleanups.push(firstHost.stop);
    expect((await runCli(["init", project], firstHost.socketPath, directory)).exitCode).toBe(0);
    const identity = JSON.parse(await readFile(join(project, ".kojo", "project.json"), "utf8"))
      .projectIdentity as string;

    const [forgotten, registered] = await Promise.all([
      runCli(
        ["project", "forget", "--project-id", identity, "--request-key", "race-forget"],
        firstHost.socketPath,
        directory,
      ),
      runCli(
        ["project", "register", project, "--request-key", "race-register"],
        firstHost.socketPath,
        directory,
      ),
    ]);
    expect(forgotten.exitCode).toBe(0);
    expect(registered.exitCode).toBe(0);
    const indexed = JSON.parse(
      (await runCli(["project", "list", "--json"], firstHost.socketPath, directory)).stdout,
    ).result.items as ReadonlyArray<unknown>;

    const secondHost = await startKojoHostProcess();
    cleanups.push(secondHost.stop);
    const reacquired = await runCli(
      ["project", "register", project, "--request-key", "race-probe", "--json"],
      secondHost.socketPath,
      directory,
    );
    expect(reacquired.exitCode).toBe(indexed.length === 0 ? 0 : 1);
  });

  it("releases the old runtime when a moved Project is forgotten", async () => {
    const directory = await temporaryDirectory("kojo-project-move-rekey-");
    const project = join(directory, "project");
    const moved = join(directory, "moved");
    await git(["init", project]);
    const firstHost = await startKojoHostProcess();
    cleanups.push(firstHost.stop);
    expect((await runCli(["init", project], firstHost.socketPath, directory)).exitCode).toBe(0);
    const identity = JSON.parse(await readFile(join(project, ".kojo", "project.json"), "utf8"))
      .projectIdentity as string;
    await rename(project, moved);
    expect(
      (
        await runCli(
          ["project", "register", moved, "--request-key", "move-rekey"],
          firstHost.socketPath,
          directory,
        )
      ).exitCode,
    ).toBe(0);
    expect(
      (
        await runCli(
          ["project", "forget", "--project-id", identity, "--request-key", "forget-moved"],
          firstHost.socketPath,
          directory,
        )
      ).exitCode,
    ).toBe(0);

    const secondHost = await startKojoHostProcess();
    cleanups.push(secondHost.stop);
    const registered = await runCli(
      ["project", "register", moved, "--request-key", "reacquire-moved", "--json"],
      secondHost.socketPath,
      directory,
    );
    expect(registered, registered.stderr).toMatchObject({ exitCode: 0 });
  });

  it("correlates Project control diagnostics by Project Identity", async () => {
    const directory = await temporaryDirectory("kojo-project-diagnostics-");
    const hostStore = join(directory, "host-store");
    const project = join(directory, "project");
    await git(["init", project]);
    const host = await startKojoHostProcess({ storePath: hostStore });
    expect((await runCli(["init", project], host.socketPath, directory)).exitCode).toBe(0);
    const identity = JSON.parse(await readFile(join(project, ".kojo", "project.json"), "utf8"))
      .projectIdentity as string;
    expect(
      (await runCli(["project", "show", "--project-id", identity], host.socketPath, directory))
        .exitCode,
    ).toBe(0);
    const refused = await runCli(
      ["project", "register", join(directory, "missing"), "--request-key", "diagnostic-key"],
      host.socketPath,
      directory,
    );
    expect(refused.exitCode).toBe(1);
    expect(
      (await runCli(["project", "forget", "--project-id", identity], host.socketPath, directory))
        .exitCode,
    ).toBe(0);
    await host.stop();

    const events = (await readFile(join(hostStore, "diagnostics.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter(({ operation }) =>
        ["RegisterProject", "ShowProject", "ForgetProject"].includes(operation),
      );
    expect(
      events.map(({ operation, outcome, projectIdentity, safeErrorCode }) => ({
        operation,
        outcome,
        projectIdentity,
        safeErrorCode,
      })),
    ).toEqual([
      {
        operation: "RegisterProject",
        outcome: "success",
        projectIdentity: identity,
        safeErrorCode: undefined,
      },
      {
        operation: "ShowProject",
        outcome: "success",
        projectIdentity: identity,
        safeErrorCode: undefined,
      },
      {
        operation: "RegisterProject",
        outcome: "error",
        projectIdentity: undefined,
        safeErrorCode: "project-layout-invalid",
      },
      {
        operation: "ForgetProject",
        outcome: "success",
        projectIdentity: identity,
        safeErrorCode: undefined,
      },
    ]);
  });

  it("persists Request Key receipts, redelivers mutations, and rejects conflicting reuse", async () => {
    const directory = await temporaryDirectory("kojo-project-request-key-");
    const hostStore = join(directory, "host-store");
    const project = join(directory, "project");
    const registerKey = "10000000-0000-4000-8000-000000000001";
    const forgetKey = "10000000-0000-4000-8000-000000000002";
    const refusedKey = "10000000-0000-4000-8000-000000000003";
    await git(["init", project]);
    const firstHost = await startKojoHostProcess({ storePath: hostStore });
    expect((await runCli(["init", project], firstHost.socketPath, directory)).exitCode).toBe(0);
    const identity = JSON.parse(await readFile(join(project, ".kojo", "project.json"), "utf8"))
      .projectIdentity as string;

    const firstRegister = await runCli(
      ["project", "register", project, "--request-key", registerKey, "--json"],
      firstHost.socketPath,
      directory,
    );
    expect(firstRegister.exitCode).toBe(0);
    expect(JSON.parse(firstRegister.stdout)).toMatchObject({
      requestKey: registerKey,
      result: { alreadyApplied: false },
    });
    const initiallyInvalid = join(directory, "initially-invalid");
    const refused = await runCli(
      ["project", "register", initiallyInvalid, "--request-key", refusedKey, "--json"],
      firstHost.socketPath,
      directory,
    );
    expect(refused.exitCode).toBe(1);
    expect(JSON.parse(refused.stdout)).toMatchObject({
      requestKey: refusedKey,
      error: { code: "project-layout-invalid" },
    });
    const refusedText = await runCli(
      ["project", "register", initiallyInvalid, "--request-key", refusedKey],
      firstHost.socketPath,
      directory,
    );
    expect(refusedText.exitCode).toBe(1);
    expect(refusedText.stdout).toContain(`Request Key: ${refusedKey}`);
    await git(["init", initiallyInvalid]);
    expect(
      (await runCli(["init", initiallyInvalid], firstHost.socketPath, directory)).exitCode,
    ).toBe(0);
    await firstHost.stop();

    const restartedHost = await startKojoHostProcess({ storePath: hostStore });
    cleanups.push(restartedHost.stop);
    const repeatedRegister = await runCli(
      ["project", "register", project, "--request-key", registerKey, "--json"],
      restartedHost.socketPath,
      directory,
    );
    expect(repeatedRegister.exitCode).toBe(0);
    expect(JSON.parse(repeatedRegister.stdout)).toMatchObject({
      requestKey: registerKey,
      result: { alreadyApplied: true, project: { identity } },
    });
    const refusedRedelivery = await runCli(
      ["project", "register", initiallyInvalid, "--request-key", refusedKey, "--json"],
      restartedHost.socketPath,
      directory,
    );
    expect(refusedRedelivery.exitCode).toBe(1);
    expect(JSON.parse(refusedRedelivery.stdout).error).toEqual(JSON.parse(refused.stdout).error);

    const conflict = await runCli(
      ["project", "forget", "--project-id", identity, "--request-key", registerKey, "--json"],
      restartedHost.socketPath,
      directory,
    );
    expect(conflict.exitCode).toBe(4);
    expect(JSON.parse(conflict.stdout)).toMatchObject({
      requestKey: registerKey,
      error: { code: "request-key-conflict" },
    });

    const firstForget = await runCli(
      ["project", "forget", "--project-id", identity, "--request-key", forgetKey, "--json"],
      restartedHost.socketPath,
      directory,
    );
    const repeatedForget = await runCli(
      ["project", "forget", "--project-id", identity, "--request-key", forgetKey, "--json"],
      restartedHost.socketPath,
      directory,
    );
    expect(firstForget.exitCode).toBe(0);
    expect(JSON.parse(firstForget.stdout).result.alreadyApplied).toBe(false);
    expect(repeatedForget.exitCode).toBe(0);
    expect(JSON.parse(repeatedForget.stdout)).toMatchObject({
      requestKey: forgetKey,
      result: { alreadyApplied: true, project: { identity } },
    });
  });

  it("generates and prints a Request Key when one is omitted", async () => {
    const directory = await temporaryDirectory("kojo-project-generated-request-key-");
    const project = join(directory, "project");
    await git(["init", project]);
    const host = await startKojoHostProcess();
    cleanups.push(host.stop);
    expect((await runCli(["init", project], host.socketPath, directory)).exitCode).toBe(0);

    const registered = await runCli(
      ["project", "register", project, "--json"],
      host.socketPath,
      directory,
    );

    expect(registered.exitCode).toBe(0);
    expect(JSON.parse(registered.stdout).requestKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("redelivers forget by Project path and by current directory", async () => {
    const directory = await temporaryDirectory("kojo-project-forget-redelivery-");
    const host = await startKojoHostProcess();
    cleanups.push(host.stop);

    const byPath = join(directory, "by-path");
    await git(["init", byPath]);
    expect((await runCli(["init", byPath], host.socketPath, directory)).exitCode).toBe(0);
    const pathKey = "10000000-0000-4000-8000-000000000010";
    const pathArguments = [
      "project",
      "forget",
      "--project",
      byPath,
      "--request-key",
      pathKey,
      "--json",
    ];
    const initialPathForget = await runCli(pathArguments, host.socketPath, directory);
    expect(initialPathForget).toMatchObject({ exitCode: 0, stderr: "" });
    await rm(byPath, { recursive: true });

    const unrelated = join(directory, "unrelated");
    await git(["init", unrelated]);
    expect((await runCli(["init", unrelated], host.socketPath, directory)).exitCode).toBe(0);
    const crossSelector = await runCli(
      ["project", "forget", "--project", unrelated, "--request-key", pathKey, "--json"],
      host.socketPath,
      directory,
    );
    expect(crossSelector.exitCode).toBe(4);
    expect(JSON.parse(crossSelector.stdout).error.code).toBe("request-key-conflict");

    const pathRedelivery = await runCli(pathArguments, host.socketPath, directory);
    expect(pathRedelivery.exitCode).toBe(0);
    expect(JSON.parse(pathRedelivery.stdout).result.alreadyApplied).toBe(true);

    const byCurrentDirectory = join(directory, "by-current-directory");
    await git(["init", byCurrentDirectory]);
    expect((await runCli(["init", byCurrentDirectory], host.socketPath, directory)).exitCode).toBe(
      0,
    );
    const cwdKey = "10000000-0000-4000-8000-000000000011";
    const cwdArguments = ["project", "forget", "--request-key", cwdKey, "--json"];
    expect((await runCli(cwdArguments, host.socketPath, byCurrentDirectory)).exitCode).toBe(0);
    await unlink(join(byCurrentDirectory, ".kojo", "project.json"));
    const cwdRedelivery = await runCli(cwdArguments, host.socketPath, byCurrentDirectory);
    expect(cwdRedelivery.exitCode).toBe(0);
    expect(JSON.parse(cwdRedelivery.stdout).result.alreadyApplied).toBe(true);
  });
});

const temporaryDirectory = async (prefix: string) => {
  const directory = await makeTemporaryDirectory(prefix);
  cleanups.push(directory.cleanup);
  await mkdir(join(directory.path, "node_modules", "@kojo"), { recursive: true });
  await symlink(
    workflowPackagePath,
    join(directory.path, "node_modules", "@kojo", "workflow"),
    "dir",
  );
  return directory.path;
};

const git = async (args: ReadonlyArray<string>) => {
  const child = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (exitCode !== 0) throw new Error(stderr);
};
