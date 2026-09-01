import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { materializeRevision } from "../../../../src/contexts/project/services/materializeRevision.ts";
import { refreshFactory } from "../../../../src/contexts/workflow/services/refreshFactory.ts";
import { linkEngine } from "../../../support/linkEngine.ts";

const roots: string[] = [];
const packageRoot = new URL("../../../../", import.meta.url).pathname.replace(/\/$/, "");

const fixture = (): {
  readonly root: string;
  readonly dataRoot: string;
  readonly marker: string;
  readonly linkedBytes: string;
} => {
  const parent = mkdtempSync(join(tmpdir(), "kojo-revision-"));
  roots.push(parent);
  const root = join(parent, "project");
  const dataRoot = join(parent, "daemon-data");
  const factory = join(root, ".kojo");
  const workflows = join(factory, "workflows");
  const localPackage = join(parent, "local-package");
  const linkedSource = join(parent, "linked-source.txt");
  const marker = join(parent, "workflow-executed");
  mkdirSync(workflows, { recursive: true });
  mkdirSync(join(root, "node_modules", "@carere"), { recursive: true });
  mkdirSync(localPackage, { recursive: true });
  mkdirSync(join(dataRoot, "staging"), { recursive: true });
  mkdirSync(join(dataRoot, "revisions"), { recursive: true });
  mkdirSync(join(dataRoot, "objects"), { recursive: true });

  linkEngine({ root, packageRoot });
  symlinkSync(
    relative(join(root, "node_modules"), localPackage),
    join(root, "node_modules", "fixture-local"),
  );
  writeFileSync(
    join(root, "package.json"),
    `${JSON.stringify({ name: "fixture", private: true })}\n`,
  );
  writeFileSync(
    join(localPackage, "package.json"),
    `${JSON.stringify({ name: "fixture-local", version: "1.0.0", exports: "./index.ts" })}\n`,
  );
  writeFileSync(join(localPackage, "index.ts"), 'export const retained = "retained";\n');
  writeFileSync(linkedSource, "individual linked file bytes\n");
  symlinkSync(relative(localPackage, linkedSource), join(localPackage, "linked.txt"));
  for (const side of ["left", "right"] as const) {
    const branch = join(parent, `fixture-${side}`);
    const shared = join(branch, "node_modules", "fixture-shared");
    const peer = join(branch, "node_modules", "fixture-peer");
    mkdirSync(shared, { recursive: true });
    mkdirSync(peer, { recursive: true });
    writeFileSync(
      join(branch, "package.json"),
      `${JSON.stringify({
        name: `fixture-${side}`,
        version: "1.0.0",
        exports: "./index.ts",
        dependencies: { "fixture-shared": "1.0.0" },
      })}\n`,
    );
    writeFileSync(join(branch, "index.ts"), `export const ${side} = "${side}";\n`);
    writeFileSync(
      join(shared, "package.json"),
      `${JSON.stringify({
        name: "fixture-shared",
        version: "1.0.0",
        exports: "./index.ts",
        peerDependencies: { "fixture-peer": "1.0.0" },
      })}\n`,
    );
    writeFileSync(join(shared, "index.ts"), 'export const shared = "same-bytes";\n');
    writeFileSync(
      join(peer, "package.json"),
      `${JSON.stringify({ name: "fixture-peer", version: "1.0.0", exports: "./index.ts" })}\n`,
    );
    writeFileSync(join(peer, "index.ts"), 'export const peer = "same-bytes";\n');
    symlinkSync(
      relative(join(root, "node_modules"), branch),
      join(root, "node_modules", `fixture-${side}`),
    );
  }

  writeFileSync(
    join(factory, "factory.json"),
    `${JSON.stringify({ formatVersion: 1, assets: ["kojo.config.yaml", "prompt.md"] })}\n`,
  );
  writeFileSync(join(factory, "tsconfig.json"), '{"compilerOptions":{"module":"Preserve"}}\n');
  writeFileSync(join(factory, "kojo.config.yaml"), "agents: {}\n");
  writeFileSync(join(factory, "prompt.md"), "exact prompt bytes\n");
  writeFileSync(join(factory, "commands.ts"), 'export const commands = { test: "true" };\n');
  writeFileSync(join(factory, "envelopes.ts"), "export const none = 1;\n");
  writeFileSync(join(workflows, "dynamic.ts"), 'export const dynamic = "captured";\n');
  writeFileSync(
    join(workflows, "support.ts"),
    'export const dynamic = () => import("./dynamic.ts");\n',
  );
  writeFileSync(
    join(workflows, "safe.ts"),
    [
      'import { writeFileSync } from "node:fs";',
      'import { Layer } from "effect";',
      'import { left } from "fixture-left";',
      'import { retained } from "fixture-local";',
      'import { right } from "fixture-right";',
      'import { dynamic } from "./support.ts";',
      `const marker = ${JSON.stringify(marker)};`,
      "void retained; void dynamic; void left; void right;",
      "const definition = Object.assign(function Safe() {}, {",
      '  _tag: "safe",',
      '  execute: () => writeFileSync(marker, "executed"),',
      "  poll: () => undefined,",
      '  idempotencyKey: () => "safe",',
      "  payloadSchema: { fields: {} },",
      "});",
      "export const safe = { definition, layer: Layer.empty };",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(workflows, "computed.ts"),
    [
      'import { Layer } from "effect";',
      'const name = "./dynamic.ts";',
      "export const load = () => import(name);",
      "const definition = Object.assign(function Computed() {}, {",
      '  _tag: "computed", execute: () => undefined, poll: () => undefined,',
      '  idempotencyKey: () => "computed", payloadSchema: { fields: {} },',
      "});",
      "export const computed = { definition, layer: Layer.empty };",
      "",
    ].join("\n"),
  );
  return { root, dataRoot, marker, linkedBytes: readFileSync(linkedSource, "utf8") };
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("real Workflow Revision capture", () => {
  it("materializes exact source, assets, packages, links, resolution, and Effect evidence", async () => {
    const subject = fixture();
    const refreshed = await Effect.runPromise(
      refreshFactory({ project: subject.root, dataRoot: subject.dataRoot }),
    );
    const safe = refreshed.workflows.find((workflow) => workflow.workflowName === "safe");
    const computed = refreshed.workflows.find((workflow) => workflow.workflowName === "computed");

    expect(refreshed.factoryState).toBe("available");
    expect(computed).toMatchObject({
      availability: "invalid",
      sourceFault: expect.stringContaining("computed"),
    });
    expect(safe?.availability).toBe("available");
    expect(safe?.revision?.revisionId).toMatch(/^[a-f0-9]{64}$/);
    expect(safe?.revision?.manifest.sources.map((file) => file.path)).toEqual([
      "workflows/dynamic.ts",
      "workflows/safe.ts",
      "workflows/support.ts",
    ]);
    expect(safe?.revision?.manifest.assets.map((file) => file.path)).toEqual([
      "kojo.config.yaml",
      "prompt.md",
    ]);
    expect(safe?.revision?.manifest.sharedConfiguration.map((file) => file.path)).toEqual([
      "factory.json",
      "tsconfig.json",
    ]);
    const local = safe?.revision?.manifest.packages.find((entry) => entry.name === "fixture-local");
    expect(local?.files.map((file) => file.path)).toEqual([
      "index.ts",
      "linked.txt",
      "package.json",
    ]);
    expect(
      readFileSync(
        join(safe?.revision?.publishedPath ?? "", "packages", local?.packageId ?? "", "linked.txt"),
        "utf8",
      ),
    ).toBe(subject.linkedBytes);
    expect(safe?.revision?.manifest.resolution).toContainEqual(
      expect.objectContaining({ specifier: "fixture-local", targetPackageId: local?.packageId }),
    );
    expect(safe?.revision?.manifest.sharedEffect.packageId).toBe(
      safe?.revision?.manifest.packages.find((entry) => entry.name === "effect")?.packageId,
    );
    const packages = safe?.revision?.manifest.packages ?? [];
    const resolution = safe?.revision?.manifest.resolution ?? [];
    const left = packages.find((entry) => entry.name === "fixture-left");
    const right = packages.find((entry) => entry.name === "fixture-right");
    const leftSharedId = resolution.find(
      (edge) => edge.fromPackageId === left?.packageId && edge.specifier === "fixture-shared",
    )?.targetPackageId;
    const rightSharedId = resolution.find(
      (edge) => edge.fromPackageId === right?.packageId && edge.specifier === "fixture-shared",
    )?.targetPackageId;
    expect(leftSharedId).toMatch(/^[a-f0-9]{64}$/);
    expect(rightSharedId).toMatch(/^[a-f0-9]{64}$/);
    expect(leftSharedId).not.toBe(rightSharedId);
    const leftPeerId = resolution.find(
      (edge) => edge.fromPackageId === leftSharedId && edge.specifier === "fixture-peer",
    )?.targetPackageId;
    const rightPeerId = resolution.find(
      (edge) => edge.fromPackageId === rightSharedId && edge.specifier === "fixture-peer",
    )?.targetPackageId;
    expect(leftPeerId).toMatch(/^[a-f0-9]{64}$/);
    expect(rightPeerId).toMatch(/^[a-f0-9]{64}$/);
    expect(leftPeerId).not.toBe(rightPeerId);
    expect(
      readFileSync(join(safe?.revision?.publishedPath ?? "", "manifest.json"), "utf8"),
    ).toContain(safe?.revision?.revisionId === undefined ? "never" : '"workflowName":"safe"');
    expect(Bun.file(subject.marker).exists()).resolves.toBe(false);

    const materialized = materializeRevision({
      retainedRoot: safe?.revision?.publishedPath ?? "missing",
      executionRoot: join(subject.dataRoot, "materialized"),
      revisionId: safe?.revision?.revisionId ?? "missing",
      packageGraphId: safe?.revision?.packageGraphId ?? "missing",
    });
    expect(readFileSync(join(materialized.root, ".kojo", "prompt.md"), "utf8")).toBe(
      "exact prompt bytes\n",
    );
    expect(readFileSync(join(materialized.root, ".kojo", "factory.json"), "utf8")).toContain(
      '"formatVersion":1',
    );
    expect(realpathSync(join(materialized.root, "node_modules", "fixture-local"))).toBe(
      realpathSync(
        join(materialized.root, ".kojo-retained", "packages", local?.packageId ?? "missing"),
      ),
    );
    const runtimeRoot = join(
      materialized.root,
      ".kojo-retained",
      "packages",
      materialized.manifest.runtime.packageId,
    );
    expect(realpathSync(join(runtimeRoot, "node_modules", "effect"))).toBe(
      realpathSync(join(materialized.root, "node_modules", "effect")),
    );
    const retainedPackages = join(materialized.root, ".kojo-retained", "packages");
    expect(
      realpathSync(
        join(retainedPackages, left?.packageId ?? "missing", "node_modules", "fixture-shared"),
      ),
    ).toBe(realpathSync(join(retainedPackages, leftSharedId ?? "missing")));
    expect(
      realpathSync(
        join(retainedPackages, right?.packageId ?? "missing", "node_modules", "fixture-shared"),
      ),
    ).toBe(realpathSync(join(retainedPackages, rightSharedId ?? "missing")));
    expect(
      realpathSync(
        join(retainedPackages, leftSharedId ?? "missing", "node_modules", "fixture-peer"),
      ),
    ).toBe(realpathSync(join(retainedPackages, leftPeerId ?? "missing")));
    expect(
      realpathSync(
        join(retainedPackages, rightSharedId ?? "missing", "node_modules", "fixture-peer"),
      ),
    ).toBe(realpathSync(join(retainedPackages, rightPeerId ?? "missing")));
    materialized.dispose();

    writeFileSync(join(subject.root, ".kojo", "prompt.md"), "changed prompt bytes\n");
    const changed = await Effect.runPromise(
      refreshFactory({ project: subject.root, dataRoot: subject.dataRoot }),
    );
    expect(
      changed.workflows.find((workflow) => workflow.workflowName === "safe")?.revision?.revisionId,
    ).not.toBe(safe?.revision?.revisionId);
  });

  it("keeps credential declarations outside every revision", async () => {
    const subject = fixture();
    writeFileSync(join(subject.root, ".kojo", ".env"), "TOKEN=secret\n");
    writeFileSync(
      join(subject.root, ".kojo", "factory.json"),
      `${JSON.stringify({ formatVersion: 1, assets: [".env"] })}\n`,
    );

    const refreshed = await Effect.runPromise(
      refreshFactory({ project: subject.root, dataRoot: subject.dataRoot }),
    );
    expect(refreshed.factoryState).toBe("invalid");
    expect(refreshed.fault).toContain("credential");
    expect(refreshed.workflows.every((workflow) => workflow.revision === undefined)).toBe(true);
  });
});
