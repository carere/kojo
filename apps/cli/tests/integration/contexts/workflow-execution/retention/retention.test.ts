import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { runKojoCli as runCli } from "../../../../../../../tests/support/cli-process";
import { startKojoHostProcess } from "../../../../../../../tests/support/host-process";

const cleanups: Array<() => Promise<void>> = [];
const workflowPackagePath = fileURLToPath(
  new URL("../../../../../../../packages/workflow", import.meta.url),
);

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

it("shows, partially sets, and resets durable retention policy through the CLI", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kojo-retention-cli-"));
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

  const shown = await runCli(
    ["retention", "show", "--project-id", identity, "--json"],
    host.socketPath,
    directory,
  );
  expect(shown.exitCode).toBe(0);
  expect(JSON.parse(shown.stdout).result.retention.policy).toEqual({
    diagnosticMaxAgeMs: 14 * 24 * 60 * 60 * 1_000,
    diagnosticMaxBytes: 100 * 1024 * 1024,
    disposableMaxAgeMs: 30 * 24 * 60 * 60 * 1_000,
    disposableMaxBytes: 5 * 1024 ** 3,
  });
  expect(JSON.parse(shown.stdout).result.retention.hostDiagnosticMaxBytes).toBe(500 * 1024 ** 2);

  const explicit = await runCli(
    [
      "retention",
      "set",
      "--project-id",
      identity,
      "--diagnostics-age",
      "14d",
      "--diagnostics-size",
      "100MiB",
      "--disposable-age",
      "30d",
      "--disposable-size",
      "5GiB",
      "--request-key",
      "retention-cli-explicit",
      "--json",
    ],
    host.socketPath,
    directory,
  );
  expect(explicit.exitCode, `${explicit.stdout}${explicit.stderr}`).toBe(0);
  expect(JSON.parse(explicit.stdout).result.retention.policy).toEqual({
    diagnosticMaxAgeMs: 14 * 24 * 60 * 60 * 1_000,
    diagnosticMaxBytes: 100 * 1024 ** 2,
    disposableMaxAgeMs: 30 * 24 * 60 * 60 * 1_000,
    disposableMaxBytes: 5 * 1024 ** 3,
  });

  const changed = await runCli(
    [
      "retention",
      "set",
      "--project-id",
      identity,
      "--diagnostics-age",
      "off",
      "--disposable-size",
      "1MiB",
      "--request-key",
      "retention-cli-set",
      "--json",
    ],
    host.socketPath,
    directory,
  );
  expect(changed.exitCode).toBe(0);
  expect(JSON.parse(changed.stdout).result.retention.policy).toMatchObject({
    diagnosticMaxAgeMs: null,
    diagnosticMaxBytes: 100 * 1024 ** 2,
    disposableMaxAgeMs: 30 * 24 * 60 * 60 * 1_000,
    disposableMaxBytes: 1024 ** 2,
  });

  const disabled = await runCli(
    [
      "retention",
      "set",
      "--project-id",
      identity,
      "--diagnostics-age",
      "off",
      "--diagnostics-size",
      "off",
      "--disposable-age",
      "off",
      "--disposable-size",
      "off",
      "--request-key",
      "retention-cli-off",
      "--json",
    ],
    host.socketPath,
    directory,
  );
  expect(disabled.exitCode, `${disabled.stdout}${disabled.stderr}`).toBe(0);
  expect(JSON.parse(disabled.stdout).result.retention.policy).toEqual({
    diagnosticMaxAgeMs: null,
    diagnosticMaxBytes: null,
    disposableMaxAgeMs: null,
    disposableMaxBytes: null,
  });

  const reset = await runCli(
    [
      "retention",
      "reset",
      "--project-id",
      identity,
      "--request-key",
      "retention-cli-reset",
      "--json",
    ],
    host.socketPath,
    directory,
  );
  expect(reset.exitCode).toBe(0);
  expect(JSON.parse(reset.stdout).result.retention.policy).toEqual({
    diagnosticMaxAgeMs: 14 * 24 * 60 * 60 * 1_000,
    diagnosticMaxBytes: 100 * 1024 ** 2,
    disposableMaxAgeMs: 30 * 24 * 60 * 60 * 1_000,
    disposableMaxBytes: 5 * 1024 ** 3,
  });
});
