import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { makeTemporaryDirectory, runKojoCli } from "../../../../../../../tests/support/cli-process";
import { startKojoHostProcess } from "../../../../../../../tests/support/host-process";

const cleanups: Array<() => Promise<void>> = [];
const workflowPackagePath = fileURLToPath(
  new URL("../../../../../../../packages/workflow", import.meta.url),
);

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const initializeGit = async (path: string) => {
  const child = Bun.spawn(["git", "init", path], { stdout: "ignore", stderr: "pipe" });
  if ((await child.exited) !== 0) throw new Error(await new Response(child.stderr).text());
};

const installWorkflowPackage = async (path: string) => {
  await mkdir(join(path, "node_modules", "@kojo"), { recursive: true });
  await symlink(workflowPackagePath, join(path, "node_modules", "@kojo", "workflow"), "dir");
};

const validConfiguration = `
import { defineConfig, defineWorkflow } from "@kojo/workflow";

const schema = { ast: { _tag: "StringKeyword" } };
export default defineConfig({
  workflows: [
    defineWorkflow({
      workflowKey: "echo",
      revision: "1",
      inputSchema: schema,
      successSchema: schema,
      failureSchema: schema,
      sensitivity: { input: ["token"] },
      handler: () => ({})
    })
  ]
});
`;

it("validates source without contacting the Host", async () => {
  const directory = await makeTemporaryDirectory("kojo-workflow-validate-");
  cleanups.push(directory.cleanup);
  await installWorkflowPackage(directory.path);
  await writeFile(join(directory.path, "kojo.config.ts"), validConfiguration);

  const result = await runKojoCli(
    ["workflow", "validate", directory.path, "--json"],
    join(directory.path, "missing.sock"),
  );

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toMatchObject({
    command: "workflow.validate",
    result: { workflows: [{ workflowKey: "echo", revision: "1" }] },
  });
});

it("lists the Host-accepted snapshot and keeps it after an invalid replacement", async () => {
  const directory = await makeTemporaryDirectory("kojo-workflow-snapshot-");
  cleanups.push(directory.cleanup);
  const project = join(directory.path, "project");
  await initializeGit(project);
  await installWorkflowPackage(project);
  const host = await startKojoHostProcess();
  cleanups.push(host.stop);
  expect((await runKojoCli(["init", project], host.socketPath)).exitCode).toBe(0);
  await writeFile(join(project, "kojo.config.ts"), validConfiguration);

  const listed = await runKojoCli(["workflow", "list", "--json"], host.socketPath, project);
  expect(listed.exitCode).toBe(0);
  expect(JSON.parse(listed.stdout)).toMatchObject({
    command: "workflow.list",
    result: { definitions: { workflows: [{ workflowKey: "echo", revision: "1" }] } },
  });
  const shown = await runKojoCli(["workflow", "show", "echo", "--json"], host.socketPath, project);
  expect(shown.exitCode).toBe(0);
  expect(JSON.parse(shown.stdout)).toMatchObject({
    command: "workflow.show",
    result: { workflow: { workflowKey: "echo", sensitivity: { input: ["token"] } } },
  });

  await writeFile(join(project, "kojo.config.ts"), 'export default { workflows: "invalid" };\n');
  const retained = await runKojoCli(["workflow", "list", "--json"], host.socketPath, project);
  expect(retained.exitCode).toBe(0);
  expect(JSON.parse(retained.stdout)).toMatchObject({
    result: { definitions: { workflows: [{ workflowKey: "echo", revision: "1" }] } },
  });
  const projects = await runKojoCli(
    ["project", "list", "--condition", "limited", "--json"],
    host.socketPath,
    project,
  );
  expect(JSON.parse(projects.stdout).result.items).toHaveLength(1);
});
