import { Database } from "bun:sqlite";
import { mkdir, readFile, realpath, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { makeTemporaryDirectory, runKojoCli } from "../../../../../../../tests/support/cli-process";
import { startKojoHostProcess } from "../../../../../../../tests/support/host-process";
import {
  assertClassicZipBounds,
  TraceExportArchiveTooLargeError,
  writeClassicZip,
} from "../../../../../src/contexts/workflow-execution/traces/services/write-execution-trace-export";

const cleanups: Array<() => Promise<void>> = [];
const workflowPackagePath = fileURLToPath(
  new URL("../../../../../../../packages/workflow", import.meta.url),
);
const effectPackagePath = fileURLToPath(
  new URL("../../../../../../../apps/host/node_modules/effect", import.meta.url),
);

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const initializeGit = async (path: string) => {
  const child = Bun.spawn(["git", "init", path], { stdout: "ignore", stderr: "pipe" });
  if ((await child.exited) !== 0) throw new Error(await new Response(child.stderr).text());
};

const commitInitialGitState = async (path: string) => {
  const child = Bun.spawn(
    [
      "git",
      "-c",
      "user.name=Kojo Test",
      "-c",
      "user.email=kojo@example.test",
      "commit",
      "--allow-empty",
      "--message",
      "initial",
    ],
    { cwd: path, stdout: "ignore", stderr: "pipe" },
  );
  if ((await child.exited) !== 0) throw new Error(await new Response(child.stderr).text());
};

const installWorkflowDependencies = async (path: string) => {
  await mkdir(join(path, "node_modules", "@kojo"), { recursive: true });
  await symlink(workflowPackagePath, join(path, "node_modules", "@kojo", "workflow"), "dir");
  await symlink(await realpath(effectPackagePath), join(path, "node_modules", "effect"), "dir");
};

const traceExportConfiguration = `
import { Effect, Schema } from "effect";
import { Command, CommandFailure, CommandResult, Sandbox, defineCommand, defineConfig, defineSandbox, defineWorkflow } from "@kojo/workflow";
import { unsafeHost } from "@kojo/workflow/sandboxes/unsafe-host";

const input = Schema.Struct({ message: Schema.String });
const sandbox = defineSandbox({
  sandboxKey: "local-command",
  revision: "1",
  provider: unsafeHost({ providerKey: "trusted-local", revision: "1" }),
});
const command = defineCommand({
  commandKey: "echo-environment",
  revision: "1",
  arguments: ["/bin/sh", "-lc", "printf '%s:%s' \\"$KOJO_SANDBOX_VALUE\\" \\"$PWD\\""],
  environment: { KOJO_SANDBOX_VALUE: "present" },
  workingDirectory: ".",
});

export default defineConfig({
  workflows: [
    defineWorkflow({
      workflowKey: "slow",
      revision: "1",
      inputSchema: input,
      successSchema: Schema.String,
      failureSchema: Schema.String,
      handler: ({ message }) => Effect.sleep("3 seconds").pipe(Effect.as("echo:" + message)),
    }),
    defineWorkflow({
      workflowKey: "sandbox-command",
      revision: "1",
      inputSchema: input,
      successSchema: CommandResult,
      failureSchema: CommandFailure,
      handler: () => Effect.gen(function* () {
        const acquired = yield* Sandbox.acquire({ operationKey: "sandbox", sandbox });
        return yield* Command.run({ operationKey: "command", sandbox: acquired, command });
      }),
    }),
  ],
});
`;

const waitForCondition = async (
  label: string,
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 8_000,
) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await Bun.sleep(25);
  }
  throw new Error(`Timed out waiting for ${label}.`);
};

const waitForFinalRun = async (socketPath: string, project: string, runId: string) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const shown = await runKojoCli(["run", "show", runId, "--json"], socketPath, project);
    if (shown.exitCode === 0) {
      const run = JSON.parse(shown.stdout).result.run as Record<string, unknown>;
      if (run.state === "completed" || run.state === "failed") return run;
    }
    await Bun.sleep(50);
  }
  throw new Error(`Timed out waiting for Workflow Run ${runId}.`);
};

const startTraceExportProject = async () => {
  const directory = await makeTemporaryDirectory("kojo-trace-export-");
  cleanups.push(directory.cleanup);
  const project = join(directory.path, "project");
  await initializeGit(project);
  await commitInitialGitState(project);
  await installWorkflowDependencies(project);
  await writeFile(join(project, "kojo.config.ts"), traceExportConfiguration);
  const host = await startKojoHostProcess();
  cleanups.push(host.stop);
  expect((await runKojoCli(["init", project], host.socketPath)).exitCode).toBe(0);
  return { directory, host, project };
};

const startSandboxRun = async (socketPath: string, project: string, message = "hello") => {
  const started = await runKojoCli(
    ["run", "start", "sandbox-command", "--input", JSON.stringify({ message }), "--json"],
    socketPath,
    project,
  );
  expect(started.exitCode, `${started.stdout}${started.stderr}`).toBe(0);
  return JSON.parse(started.stdout).result.run.runId as string;
};

it("rejects ZIP64-sized entries and archive totals before creating or overwriting an export", async () => {
  const directory = await makeTemporaryDirectory("kojo-trace-zip-bounds-");
  cleanups.push(directory.cleanup);
  const destination = join(directory.path, "trace.zip");
  const oversizedEntry = {
    contents: { byteLength: 0x1_0000_0000 } as Uint8Array,
    name: "artifacts/oversized",
  };

  expect(() => assertClassicZipBounds([oversizedEntry])).toThrow(TraceExportArchiveTooLargeError);
  await expect(writeClassicZip(destination, [oversizedEntry])).rejects.toBeInstanceOf(
    TraceExportArchiveTooLargeError,
  );
  await expect(readFile(destination)).rejects.toMatchObject({ code: "ENOENT" });

  await writeFile(destination, "preserve this existing export");
  await expect(writeClassicZip(destination, [oversizedEntry])).rejects.toBeInstanceOf(
    TraceExportArchiveTooLargeError,
  );
  await expect(readFile(destination, "utf8")).resolves.toBe("preserve this existing export");

  const aggregateOverflow = {
    contents: { byteLength: 0xffffffff - 31 } as Uint8Array,
    name: "a",
  };
  expect(() => assertClassicZipBounds([aggregateOverflow])).toThrow(
    TraceExportArchiveTooLargeError,
  );
  const emptyEntry = { contents: new Uint8Array(), name: "entry" };
  expect(() => assertClassicZipBounds(Array.from({ length: 0x1_0000 }, () => emptyEntry))).toThrow(
    TraceExportArchiveTooLargeError,
  );
});

it("exports only the captured high-water Trace while a Run continues recording evidence", async () => {
  const { directory, host, project } = await startTraceExportProject();
  const started = await runKojoCli(
    ["run", "start", "slow", "--input", '{"message":"later"}', "--json"],
    host.socketPath,
    project,
  );
  expect(started.exitCode, `${started.stdout}${started.stderr}`).toBe(0);
  const runId = JSON.parse(started.stdout).result.run.runId as string;
  await waitForCondition("initial durable Execution Trace evidence", async () => {
    const trace = await runKojoCli(["trace", "show", runId, "--json"], host.socketPath, project);
    return trace.exitCode === 0 && JSON.parse(trace.stdout).result.page.highWaterSequence > 0;
  });

  const destination = join(directory.path, "running-trace.zip");
  const exported = await runKojoCli(
    ["trace", "export", runId, "--output", destination, "--json"],
    host.socketPath,
    project,
  );
  expect(exported.exitCode, `${exported.stdout}${exported.stderr}`).toBe(0);
  const highWaterSequence = JSON.parse(exported.stdout).result.highWaterSequence as number;
  expect(await waitForFinalRun(host.socketPath, project, runId)).toMatchObject({
    state: "completed",
  });
  const afterFinal = await runKojoCli(["trace", "show", runId, "--json"], host.socketPath, project);
  expect(afterFinal.exitCode).toBe(0);
  expect(JSON.parse(afterFinal.stdout).result.page.highWaterSequence).toBeGreaterThan(
    highWaterSequence,
  );
  const archive = await readFile(destination, "utf8");
  expect(archive).toContain(`"highWaterSequence":${highWaterSequence}`);
  expect(archive).not.toContain('"kind":"run.completed"');
});

it("keeps payload reveal, warnings, and Artifact inclusion as separate export actions", async () => {
  const { directory, host, project } = await startTraceExportProject();
  const runId = await startSandboxRun(host.socketPath, project);
  const completed = await waitForFinalRun(host.socketPath, project, runId);
  const trace = completed.sandboxTrace as ReadonlyArray<Record<string, unknown>>;
  const commandArtifactId = (
    trace.find((entry) => entry.kind === "command.completed")?.artifactIds as
      | ReadonlyArray<string>
      | undefined
  )?.[0];
  if (typeof commandArtifactId !== "string") {
    throw new Error("The sandbox fixture did not record its command Artifact.");
  }

  const redactedExport = join(directory.path, "trace-redacted.zip");
  const redacted = await runKojoCli(
    ["trace", "export", runId, "--output", redactedExport, "--json"],
    host.socketPath,
    project,
  );
  expect(redacted.exitCode, `${redacted.stdout}${redacted.stderr}`).toBe(0);
  expect(JSON.parse(redacted.stdout)).toMatchObject({
    result: { artifactCount: 0, payloadsRevealed: false },
  });
  const redactedArchive = await readFile(redactedExport, "utf8");
  expect(redactedArchive).toContain('"redactionMode":"redacted"');
  expect(redactedArchive).not.toContain(`artifacts/${commandArtifactId}`);

  const originalArchive = await readFile(redactedExport);
  const overwritten = await runKojoCli(
    ["trace", "export", runId, "--output", redactedExport],
    host.socketPath,
    project,
  );
  expect(overwritten.exitCode).not.toBe(0);
  expect(await readFile(redactedExport)).toEqual(originalArchive);

  const unacknowledged = await runKojoCli(
    [
      "trace",
      "export",
      runId,
      "--output",
      join(directory.path, "trace-unacknowledged.zip"),
      "--reveal",
    ],
    host.socketPath,
    project,
  );
  expect(unacknowledged.exitCode).not.toBe(0);

  const revealedExport = join(directory.path, "trace-revealed.zip");
  const revealed = await runKojoCli(
    [
      "trace",
      "export",
      runId,
      "--output",
      revealedExport,
      "--reveal",
      "--acknowledge-sensitive-export",
    ],
    host.socketPath,
    project,
  );
  expect(revealed.exitCode, `${revealed.stdout}${revealed.stderr}`).toBe(0);
  expect(revealed.stderr).toContain("Warning: Revealed payloads may contain arbitrary secrets");
  const revealedArchive = await readFile(revealedExport, "utf8");
  expect(revealedArchive).toContain('"redactionMode":"unredacted"');
  expect(revealedArchive).not.toContain(`artifacts/${commandArtifactId}`);

  const includedExport = join(directory.path, "trace-with-artifacts.zip");
  const included = await runKojoCli(
    ["trace", "export", runId, "--output", includedExport, "--include-artifacts"],
    host.socketPath,
    project,
  );
  expect(included.exitCode, `${included.stdout}${included.stderr}`).toBe(0);
  expect(await readFile(includedExport, "utf8")).toContain(`artifacts/${commandArtifactId}`);
});

it("records later unavailable evidence for traversed, symbolic-link, and missing Artifacts", async () => {
  const { directory, host, project } = await startTraceExportProject();
  const runId = await startSandboxRun(host.socketPath, project);
  const completed = await waitForFinalRun(host.socketPath, project, runId);
  const trace = completed.sandboxTrace as ReadonlyArray<Record<string, unknown>>;
  const acquisitionArtifactId = (
    trace.find((entry) => entry.kind === "sandbox.acquired")?.artifactIds as
      | ReadonlyArray<string>
      | undefined
  )?.[0];
  const commandArtifactId = (
    trace.find((entry) => entry.kind === "command.completed")?.artifactIds as
      | ReadonlyArray<string>
      | undefined
  )?.[0];
  if (typeof acquisitionArtifactId !== "string" || typeof commandArtifactId !== "string") {
    throw new Error("The sandbox fixture did not record both expected Artifacts.");
  }

  const missingRunId = await startSandboxRun(host.socketPath, project, "missing");
  const missingCompleted = await waitForFinalRun(host.socketPath, project, missingRunId);
  const missingArtifactId = (
    (missingCompleted.sandboxTrace as ReadonlyArray<Record<string, unknown>>).find(
      (entry) => entry.kind === "command.completed",
    )?.artifactIds as ReadonlyArray<string> | undefined
  )?.[0];
  if (typeof missingArtifactId !== "string") {
    throw new Error("The sandbox fixture did not record its expected missing Artifact.");
  }

  const database = new Database(join(project, ".kojo", "kojo.sqlite"));
  database
    .query(
      "UPDATE kojo_execution_artifacts SET storage_key = ? WHERE run_id = ? AND artifact_id = ?",
    )
    .run("../outside.json", runId, acquisitionArtifactId);
  database.close();
  const traversalArchive = join(directory.path, "traversal.zip");
  const traversal = await runKojoCli(
    ["trace", "export", runId, "--output", traversalArchive, "--include-artifacts"],
    host.socketPath,
    project,
  );
  expect(traversal.exitCode, `${traversal.stdout}${traversal.stderr}`).toBe(0);
  expect(await readFile(traversalArchive, "utf8")).toContain("artifact.unsafe-path");

  const commandArtifactPath = join(
    project,
    ".kojo",
    "artifacts",
    runId,
    `${commandArtifactId}.json`,
  );
  await unlink(commandArtifactPath);
  await symlink(join(project, "kojo.config.ts"), commandArtifactPath);
  const symlinkArchive = join(directory.path, "symlink.zip");
  const symlinked = await runKojoCli(
    ["trace", "export", runId, "--output", symlinkArchive, "--include-artifacts"],
    host.socketPath,
    project,
  );
  expect(symlinked.exitCode, `${symlinked.stdout}${symlinked.stderr}`).toBe(0);
  expect(await readFile(symlinkArchive, "utf8")).toContain("artifact.unsafe-path");

  await unlink(join(project, ".kojo", "artifacts", missingRunId, `${missingArtifactId}.json`));
  const missingArchive = join(directory.path, "missing.zip");
  const missing = await runKojoCli(
    ["trace", "export", missingRunId, "--output", missingArchive, "--include-artifacts"],
    host.socketPath,
    project,
  );
  expect(missing.exitCode, `${missing.stdout}${missing.stderr}`).toBe(0);
  expect(await readFile(missingArchive, "utf8")).toContain("artifact.missing");

  const afterArtifactChecks = await runKojoCli(
    ["trace", "show", runId, "--json"],
    host.socketPath,
    project,
  );
  expect(afterArtifactChecks.exitCode).toBe(0);
  expect(JSON.parse(afterArtifactChecks.stdout).result.page.events).toEqual(
    expect.arrayContaining([expect.objectContaining({ kind: "artifact.unavailable" })]),
  );
  expect(await waitForFinalRun(host.socketPath, project, runId)).toMatchObject({
    outcome: { kind: "completed" },
    state: "completed",
  });
  expect(await waitForFinalRun(host.socketPath, project, missingRunId)).toMatchObject({
    outcome: { kind: "completed" },
    state: "completed",
  });
});
