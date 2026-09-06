import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { installedPackage } from "../../../../src/contexts/shared/services/resolvePackage.ts";
import { captureWorkflowRevision } from "../../../../src/contexts/workflow/services/captureRevision.ts";

it("retains a JSR Runtime installed under its canonical Factory alias", () => {
  const root = mkdtempSync(join(tmpdir(), "kojo-jsr-runtime-"));
  try {
    const runtime = join(root, "node_modules/@carere/kojo-runtime");
    mkdirSync(join(runtime, "src/runner"), { recursive: true });
    mkdirSync(join(root, ".kojo/workflows"), { recursive: true });
    const effectRoot = dirname(
      Bun.resolveSync("effect/package.json", dirname(new URL(import.meta.url).pathname)),
    );
    symlinkSync(effectRoot, join(root, "node_modules/effect"));
    const effectVersion = JSON.parse(
      readFileSync(join(effectRoot, "package.json"), "utf8"),
    ).version;
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "jsr-fixture", private: true }),
    );
    writeFileSync(
      join(root, ".kojo/factory.json"),
      JSON.stringify({ formatVersion: 1, assets: [] }),
    );
    writeFileSync(
      join(root, ".kojo/workflows/example.ts"),
      'import { marker } from "@carere/kojo-runtime/example"; export const example = marker;',
    );
    writeFileSync(
      join(runtime, "package.json"),
      JSON.stringify({
        name: "@jsr/carere__kojo-runtime",
        version: "0.1.0-alpha.1",
        type: "module",
        exports: {
          "./example": "./src/example.js",
          "./runtime-manifest.json": "./runtime-manifest.json",
        },
        dependencies: { effect: effectVersion },
      }),
    );
    writeFileSync(join(runtime, "src/example.js"), "export const marker = 1;");
    writeFileSync(join(runtime, "src/runner/main.js"), "export const runnerEntryPointVersion = 1;");
    writeFileSync(
      join(runtime, "runtime-manifest.json"),
      JSON.stringify({
        manifestVersion: 1,
        packageName: "@carere/kojo-runtime",
        packageVersion: "0.1.0-alpha.1",
        runner: "./src/runner/main.js",
        runnerProtocols: [1],
        requiredFeatures: [],
        effectPeer: effectVersion,
        bun: { minimum: "1.3.14" },
        hosts: [process.platform],
      }),
    );
    expect(installedPackage(root, "@carere/kojo-runtime")?.name).toBe("@carere/kojo-runtime");
    const capture = captureWorkflowRevision({
      project: root,
      dataRoot: join(root, "data"),
      workflowName: "example",
    });
    expect(capture.manifest.runtime.runner).toBe("./src/runner/main.js");
    expect(capture.manifest.packages.some((pkg) => pkg.name === "@carere/kojo-runtime")).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
