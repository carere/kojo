import { cpSync, existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { standaloneValidation } from "../../../../src/contexts/scaffold/services/standaloneValidation.ts";
import { installedPackage } from "../../../../src/contexts/shared/services/resolvePackage.ts";
import { refreshFactory } from "../../../../src/contexts/workflow/services/refreshFactory.ts";
import { linkEngine } from "../../../support/linkEngine.ts";
import { shippedMacosControlledWorkflow } from "../../../support/release/ShippedMacosEvidence.ts";

const packageRoot = new URL("../../../../", import.meta.url).pathname.replace(/\/$/, "");
const roots: Array<string> = [];

const project = async (
  options: { readonly duplicateEffect?: boolean } = {},
): Promise<{ readonly root: string; readonly executed: string }> => {
  const root = await mkdtemp(join(tmpdir(), "kojo-validator-"));
  roots.push(root);
  const factory = join(root, ".kojo");
  const workflows = join(factory, "workflows");
  const executed = join(root, "workflow-executed");
  await mkdir(workflows, { recursive: true });
  await mkdir(join(root, "node_modules"), { recursive: true });
  linkEngine({
    root,
    packageRoot,
    ...(options.duplicateEffect === true
      ? { dependencies: ["@ai-hero", "@effect", "@types"] }
      : {}),
  });
  if (options.duplicateEffect === true) {
    const effect = installedPackage(packageRoot, "effect");
    if (effect === undefined) throw new Error("the test cannot resolve its Effect package");
    cpSync(effect.directory, join(root, "node_modules", "effect"), {
      recursive: true,
      dereference: true,
    });
  }

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

  it("marks the Factory Invalid when authored code resolves a second physical Effect", async () => {
    const fixture = await project({ duplicateEffect: true });
    const dataRoot = await mkdtemp(join(tmpdir(), "kojo-validator-data-"));
    roots.push(dataRoot);

    const observation = await Effect.runPromise(
      refreshFactory({ project: fixture.root, dataRoot }),
    );

    expect(observation.factoryState).toBe("invalid");
    expect(observation.fault).toContain("Factory resolves");
    expect(observation.fault).toContain("Project runtime resolves");
    expect(observation.workflows).toEqual([
      expect.objectContaining({ workflowName: "safe", availability: "invalid" }),
    ]);
    expect(existsSync(fixture.executed)).toBe(false);
  });

  it("accepts the controlled shipped macOS Workflow contract without running it", async () => {
    const fixture = await project();
    await writeFile(
      join(fixture.root, ".kojo", "workflows", "release-evidence.ts"),
      shippedMacosControlledWorkflow(fixture.root),
    );

    const diagnostics = await Effect.runPromise(standaloneValidation(fixture.root));

    expect(diagnostics.find((finding) => finding.subject === "workflow:release-evidence")).toEqual({
      subject: "workflow:release-evidence",
      standing: "ok",
      detail: "declaration, Layer, payload, and key are valid",
      triggerDeclared: false,
    });
    expect(existsSync(fixture.executed)).toBe(false);
  });
});
