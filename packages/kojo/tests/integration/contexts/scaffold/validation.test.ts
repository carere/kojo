import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { standaloneValidation } from "../../../../src/contexts/scaffold/services/standaloneValidation.ts";
import { linkEngine } from "../../../support/linkEngine.ts";

const packageRoot = new URL("../../../../", import.meta.url).pathname.replace(/\/$/, "");
const roots: Array<string> = [];

const project = async (): Promise<{ readonly root: string; readonly executed: string }> => {
  const root = await mkdtemp(join(tmpdir(), "kojo-validator-"));
  roots.push(root);
  const factory = join(root, ".kojo");
  const workflows = join(factory, "workflows");
  const executed = join(root, "workflow-executed");
  await mkdir(workflows, { recursive: true });
  await mkdir(join(root, "node_modules"), { recursive: true });
  linkEngine({ root, packageRoot });

  await writeFile(
    join(factory, "factory.json"),
    `${JSON.stringify({ formatVersion: 1, assets: ["kojo.config.yaml"] }, undefined, 2)}\n`,
  );
  await writeFile(join(factory, "kojo.config.yaml"), "agents: {}\n");
  await writeFile(join(factory, "commands.ts"), 'export const commands = { test: "true" };\n');
  await writeFile(join(factory, "envelopes.ts"), "export const none = 1;\n");
  await writeFile(
    join(workflows, "safe.ts"),
    [
      'import { writeFileSync } from "node:fs";',
      'import { Layer } from "effect";',
      `const executed = ${JSON.stringify(executed)};`,
      "const definition = Object.assign(function Safe() {}, {",
      '  _tag: "safe",',
      '  execute: () => writeFileSync(executed, "executed"),',
      "  poll: () => undefined,",
      '  idempotencyKey: () => "safe",',
      "  payloadSchema: { fields: {} },",
      "});",
      "export const safe = { definition, layer: Layer.empty };",
      "",
    ].join("\n"),
  );

  return { root, executed };
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("standalone Project validation", () => {
  it("returns plain diagnostics without executing a Workflow", async () => {
    const fixture = await project();
    const diagnostics = await Effect.runPromise(standaloneValidation(fixture.root));

    expect(diagnostics.every((finding) => finding.standing === "ok")).toBe(true);
    expect(diagnostics.some((finding) => finding.subject === "workflows")).toBe(true);
    expect(diagnostics.some((finding) => finding.subject === "layers")).toBe(true);
    expect(existsSync(fixture.executed)).toBe(false);
    expect(existsSync(join(fixture.root, ".kojo", "data"))).toBe(false);
  });

  it("diagnoses a missing Project runtime without a Daemon", async () => {
    const root = await mkdtemp(join(tmpdir(), "kojo-validator-missing-"));
    roots.push(root);
    const diagnostics = await Effect.runPromise(standaloneValidation(root));

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.standing).toBe("failed");
    expect(diagnostics[0]?.detail).toContain("Project-local validator could not run");
    expect(diagnostics[0]?.remedy).toContain("@carere/kojo-runtime");
  });
});
