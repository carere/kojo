import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runKojoCli as runCli } from "../../../../../../../tests/support/cli-process";
import { startKojoHostProcess } from "../../../../../../../tests/support/host-process";

const cleanups: Array<() => Promise<void>> = [];
const unknownIdentity = "00000000-0000-7000-8000-000000000036";
const workflowPackagePath = fileURLToPath(
  new URL("../../../../../../../packages/workflow", import.meta.url),
);

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("kojo readiness", () => {
  it("returns a versioned safe assessment error instead of a Host exception", async () => {
    const host = await startKojoHostProcess();
    cleanups.push(host.stop);

    const result = await runCli(
      ["readiness", "show", "--project-id", unknownIdentity, "--json"],
      host.socketPath,
    );

    expect(result.exitCode).toBe(1);
    if (result.stdout.length === 0) {
      throw new Error(`Readiness command produced no JSON. stderr: ${result.stderr}`);
    }
    expect(JSON.parse(result.stdout)).toEqual({
      schemaVersion: 1,
      command: "readiness.show",
      error: {
        code: "project-not-found",
        message: "Kojo Project was not found in the Project Index.",
        next: "Register the Project or choose a listed Project Identity.",
        findingKeys: [],
      },
      warnings: [],
    });
    expect(result.stderr).toBe(
      "Kojo Project was not found in the Project Index.\nNext: Register the Project or choose a listed Project Identity.\n",
    );
  });

  it("shows, refreshes, and repairs safe readiness guidance through the local Host", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kojo-readiness-cli-"));
    cleanups.push(() => rm(directory, { recursive: true }));
    const project = join(directory, "project");
    const initialized = Bun.spawn(["git", "init", project], { stdout: "ignore", stderr: "ignore" });
    expect(await initialized.exited).toBe(0);
    await mkdir(join(project, "node_modules", "@kojo"), { recursive: true });
    await symlink(workflowPackagePath, join(project, "node_modules", "@kojo", "workflow"), "dir");
    const host = await startKojoHostProcess();
    cleanups.push(host.stop);

    const initializedProject = await runCli(["init", project], host.socketPath, directory);
    expect(initializedProject.exitCode).toBe(0);
    const identity = JSON.parse(await readFile(join(project, ".kojo", "project.json"), "utf8"))
      .projectIdentity as string;
    await writeFile(join(project, ".gitignore"), "dist/\n");

    const shown = await runCli(
      ["readiness", "show", "--project-id", identity, "--json"],
      host.socketPath,
      directory,
    );
    expect(shown.exitCode).toBe(0);
    const assessment = JSON.parse(shown.stdout).result.assessment;
    expect(assessment).toMatchObject({
      condition: "needs-attention",
      findings: [expect.objectContaining({ code: "layout.ignore-rule-missing" })],
    });
    expect(shown.stderr).not.toContain("Error");

    const refreshed = await runCli(
      ["readiness", "refresh", "--project-id", identity, "--json"],
      host.socketPath,
      directory,
    );
    expect(refreshed.exitCode).toBe(0);
    expect(JSON.parse(refreshed.stdout).result.assessment.revision).toBe(assessment.revision);

    const repaired = await runCli(
      [
        "readiness",
        "repair",
        "layout.add-ignore-rule",
        "--project-id",
        identity,
        "--revision",
        assessment.revision,
        "--request-key",
        "readiness-cli-ignore-repair",
        "--json",
      ],
      host.socketPath,
      directory,
    );
    expect(repaired.exitCode).toBe(0);
    expect(JSON.parse(repaired.stdout)).toMatchObject({
      command: "readiness.repair",
      requestKey: "readiness-cli-ignore-repair",
      result: { assessment: { condition: "ready", findings: [] } },
      warnings: [],
    });
    expect(await readFile(join(project, ".gitignore"), "utf8")).toBe("dist/\n/.kojo/\n");

    await rm(join(project, ".kojo", "artifacts"), { recursive: true });
    await rm(join(project, ".kojo", "sandboxes"), { recursive: true });
    const recreated = await runCli(
      ["readiness", "refresh", "--project-id", identity, "--json"],
      host.socketPath,
      directory,
    );
    expect(recreated.exitCode).toBe(0);
    expect(JSON.parse(recreated.stdout).result.assessment).toMatchObject({
      condition: "ready",
      repairs: expect.arrayContaining([
        expect.objectContaining({ code: "layout.artifacts-recreated" }),
        expect.objectContaining({ code: "layout.empty-sandboxes-recreated" }),
      ]),
    });
    expect((await stat(join(project, ".kojo", "artifacts"))).mode & 0o777).toBe(0o700);
    expect((await stat(join(project, ".kojo", "sandboxes"))).mode & 0o777).toBe(0o700);

    await chmod(join(project, ".kojo", "artifacts"), 0o755);
    const permissions = await runCli(
      ["readiness", "refresh", "--project-id", identity, "--json"],
      host.socketPath,
      directory,
    );
    expect(permissions.exitCode).toBe(0);
    expect(JSON.parse(permissions.stdout).result.assessment.repairs).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "layout.permissions-tightened" })]),
    );
    expect((await stat(join(project, ".kojo", "artifacts"))).mode & 0o777).toBe(0o700);
  });
});
