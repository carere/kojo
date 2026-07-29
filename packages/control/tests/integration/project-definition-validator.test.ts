import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { validateProjectDefinition } from "../../src/project-definition-validator";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const configuration = async (contents: string) => {
  const directory = await mkdtemp(join(tmpdir(), "kojo-definition-validator-"));
  cleanups.push(() => rm(directory, { recursive: true }));
  const path = join(directory, "kojo.config.ts");
  await writeFile(path, contents);
  return path;
};

it("validates a static Kojo Configuration in a child process", async () => {
  const path = await configuration(
    'import { defineConfig } from "@kojo/workflow";\nexport default defineConfig({ workflows: [] });\n',
  );

  expect(await validateProjectDefinition(path)).toEqual({ ok: true });
});

it("returns a structured load failure when configuration exits its process", async () => {
  const path = await configuration("process.exit(0);\nexport default { workflows: [] };\n");

  expect(await validateProjectDefinition(path)).toMatchObject({
    ok: false,
    findingKey: "configuration.load-failed",
  });
});

it("terminates configuration validation after its bound", async () => {
  const path = await configuration("while (true) {}\nexport default { workflows: [] };\n");

  expect(await validateProjectDefinition(path, { timeoutMs: 250 })).toMatchObject({
    ok: false,
    findingKey: "configuration.load-failed",
    message: expect.stringContaining("timed out"),
  });
});
