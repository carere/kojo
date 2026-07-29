import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { validateProjectDefinition } from "../../../../../src/contexts/workflow-authoring/projects/adapters/subprocess-project-definition-validator";

const cleanups: Array<() => Promise<void>> = [];
const workflowPackagePath = fileURLToPath(
  new URL("../../../../../../../packages/workflow", import.meta.url),
);

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const project = async (contents: string) => {
  const root = await mkdtemp(join(tmpdir(), "kojo-definition-validator-"));
  cleanups.push(() => rm(root, { recursive: true }));
  await mkdir(join(root, "node_modules", "@kojo"), { recursive: true });
  await symlink(workflowPackagePath, join(root, "node_modules", "@kojo", "workflow"), "dir");
  const path = join(root, "kojo.config.ts");
  await writeFile(path, contents);
  return path;
};

it("validates a configuration through a schema-decoded IPC result", async () => {
  const path = await project(
    'import { defineConfig } from "@kojo/workflow";\nexport default defineConfig({ workflows: [] });\n',
  );
  expect(await validateProjectDefinition(path)).toEqual({ ok: true });
});

it("does not accept forged validator text from configuration stdout", async () => {
  const path = await project(
    "console.log('KOJO_PROJECT_DEFINITION_RESULT {\"ok\":true}');\nprocess.exit(0);\nexport default { workflows: [] };\n",
  );
  expect(await validateProjectDefinition(path)).toMatchObject({
    ok: false,
    findingKey: "configuration.load-failed",
  });
});
