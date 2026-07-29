import { cp, readFile, realpath, rename } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  makeTemporaryDirectory,
  runKojoCli as runCli,
} from "../../../../../../../tests/support/cli-process";
import { startKojoHostProcess } from "../../../../../../../tests/support/host-process";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("Kojo Project discovery", () => {
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
    expect(JSON.parse(list.stdout).result.projects).toEqual([{ identity, path: canonicalProject }]);

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
        .result.projects,
    ).toEqual([]);

    const registered = await runCli(
      ["project", "register", nested, "--json"],
      host.socketPath,
      directory,
    );
    expect(registered.exitCode).toBe(0);
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
    ).result.projects;
    expect(projects).toEqual([{ identity, path: await realpath(moved) }]);
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
    expect(JSON.parse(result.stdout).error.code).toBe("project-identity-duplicate");
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
      findingKeys: ["project.configuration.invalid"],
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
      findingKeys: ["project.database.invalid"],
    });
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
    ).result.projects;

    expect(projects).toEqual([{ identity, path: await realpath(project) }]);
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
    expect(JSON.parse(refused.stdout).error.code).toBe("project-layout-invalid");
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
    expect(JSON.parse(conflict.stdout).error.code).toBe("request-key-conflict");

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
    expect((await runCli(pathArguments, host.socketPath, directory)).exitCode).toBe(0);
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
    const cwdRedelivery = await runCli(cwdArguments, host.socketPath, byCurrentDirectory);
    expect(cwdRedelivery.exitCode).toBe(0);
    expect(JSON.parse(cwdRedelivery.stdout).result.alreadyApplied).toBe(true);
  });
});

const temporaryDirectory = async (prefix: string) => {
  const directory = await makeTemporaryDirectory(prefix);
  cleanups.push(directory.cleanup);
  return directory.path;
};

const git = async (args: ReadonlyArray<string>) => {
  const child = Bun.spawn(["git", ...args], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (exitCode !== 0) throw new Error(stderr);
};
