import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const packageRoot = resolve(import.meta.dir, "..");

describe("published package", () => {
  test("publishes one ESM root with JavaScript, declarations, and source maps", async () => {
    const manifest = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
    const files = await readdir(resolve(packageRoot, "dist"));
    const javascript = await readFile(resolve(packageRoot, "dist/index.js"), "utf8");

    expect(manifest.type).toBe("module");
    expect(Object.keys(manifest.exports)).toEqual(["."]);
    expect(manifest.exports["."]).toEqual({
      types: "./dist/index.d.ts",
      import: "./dist/index.js",
    });
    expect(manifest.peerDependencies.effect).toBe("4.0.0-beta.98");
    expect(manifest.dependencies?.effect).toBeUndefined();
    expect(manifest.engines.bun).toBe("1.3.14");
    expect(manifest.devDependencies).toEqual({
      "@effect/vitest": "4.0.0-beta.98",
      "@types/bun": "1.3.14",
      effect: "4.0.0-beta.98",
      typescript: "7.0.2",
      vitest: "4.1.10",
    });
    expect(files).toEqual(
      expect.arrayContaining(["index.js", "index.js.map", "index.d.ts", "index.d.ts.map"]),
    );
    expect(files.some((file) => file.endsWith(".cjs"))).toBe(false);
    expect(manifest.files).not.toContain("src");
    expect(javascript).toContain('from "effect"');
    expect(javascript).not.toContain("effect/dist/");
  });

  test("does not expose runtime or persistence internals", async () => {
    const root = await import("@kojo/workflow");

    expect(Object.keys(root).sort()).toEqual([
      "ActivityRetry",
      "COMPATIBILITY",
      "Loop",
      "RegistryValidationError",
      "Schedule",
      "Workflow",
      "WorkflowTest",
      "defineConfig",
    ]);
    expect(root).not.toHaveProperty("WorkflowEngine");
    expect(root).not.toHaveProperty("WorkflowJournal");
    expect(root).not.toHaveProperty("Persistence");
  });

  test("rejects unsupported deep imports", async () => {
    await expect(import("@kojo/workflow/dist/index.js")).rejects.toThrow();
    await expect(import("@kojo/workflow/src/index.ts")).rejects.toThrow();
  });
});
