import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryFile = (path: string): string =>
  readFileSync(new URL(`../../../../../${path}`, import.meta.url), "utf8");

describe("the Release train", () => {
  it("requires successful checks before publication and publication before the Release record", () => {
    const workflow = Bun.YAML.parse(repositoryFile(".github/workflows/release.yml")) as {
      jobs: Record<string, { needs?: string[] }>;
    };
    expect(workflow.jobs["publish-npm"]?.needs).toContain("checks");
    expect(workflow.jobs.accept?.needs).toContain("publish-npm");
  });

  it("keeps Cocogitto package versions in the lockfile and runtime manifest", () => {
    const fixture = mkdtempSync(resolve(tmpdir(), "kojo-cocogitto-version-"));
    const runtime = resolve(fixture, "packages/kojo-runtime");
    const targetVersion = "0.1.0-alpha.1";
    const versionScript = new URL(
      "../../../../../.github/scripts/cocogitto-package-version.ts",
      import.meta.url,
    ).pathname;

    try {
      mkdirSync(resolve(fixture, ".github"), { recursive: true });
      mkdirSync(runtime, { recursive: true });
      writeFileSync(
        resolve(fixture, "package.json"),
        `${JSON.stringify({ name: "fixture", private: true, workspaces: ["packages/*"] }, null, 2)}\n`,
      );
      writeFileSync(
        resolve(fixture, ".github/release-packages.json"),
        `${JSON.stringify([{ directory: "kojo-runtime", name: "@carere/kojo-runtime" }], null, 2)}\n`,
      );
      writeFileSync(
        resolve(runtime, "package.json"),
        `${JSON.stringify({ name: "@carere/kojo-runtime", version: "0.0.0" }, null, 2)}\n`,
      );
      writeFileSync(
        resolve(runtime, "runtime-manifest.json"),
        '{\n  "packageVersion": "0.0.0"\n}\n',
      );
      writeFileSync(
        resolve(fixture, "bun.lock"),
        '{\n  "lockfileVersion": 1,\n  "workspaces": {\n    "packages/kojo-runtime": {\n      "name": "@carere/kojo-runtime",\n      "version": "0.0.0"\n    }\n  }\n}\n',
      );
      expect(spawnSync("git", ["init", "--initial-branch=main"], { cwd: fixture }).status).toBe(0);
      expect(spawnSync("git", ["add", "."], { cwd: fixture }).status).toBe(0);

      const bump = spawnSync("bun", [versionScript, targetVersion], {
        cwd: runtime,
        encoding: "utf8",
      });
      expect(bump.status, bump.stderr).toBe(0);
      expect(JSON.parse(readFileSync(resolve(runtime, "package.json"), "utf8")).version).toBe(
        targetVersion,
      );
      expect(
        JSON.parse(readFileSync(resolve(runtime, "runtime-manifest.json"), "utf8")).packageVersion,
      ).toBe(targetVersion);
      expect(readFileSync(resolve(fixture, "bun.lock"), "utf8")).toContain(targetVersion);
      expect(spawnSync("git", ["diff", "--cached", "--quiet"], { cwd: fixture }).status).toBe(1);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("keeps one machine-readable package order", () => {
    expect(JSON.parse(repositoryFile(".github/release-packages.json"))).toEqual([
      { directory: "kojo-runtime", name: "@carere/kojo-runtime" },
      { directory: "kojo", name: "@carere/kojo" },
    ]);
  });
});
