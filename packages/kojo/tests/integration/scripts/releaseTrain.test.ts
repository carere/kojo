import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryFile = (path: string): string =>
  readFileSync(new URL(`../../../../../${path}`, import.meta.url), "utf8");

describe("the Release train", () => {
  it("runs one manual Release pipeline with candidate validation before promotion", () => {
    const workflow = Bun.YAML.parse(repositoryFile(".github/workflows/release.yml")) as {
      on: Record<string, unknown>;
      jobs: Record<string, { needs?: string[]; environment?: string }>;
    };
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
    expect(workflow.jobs["publish-npm"]?.needs).toEqual(["prepare", "checks"]);
    expect(workflow.jobs["validate-public"]?.needs).toContain("publish-npm");
    expect(workflow.jobs.accept?.needs).toEqual(["prepare", "validate-public"]);
    expect(workflow.jobs.accept?.environment).toBe(
      `\${{ needs.prepare.outputs.stage == 'stable' && 'npm-production' || 'npm-prerelease' }}`,
    );
    expect(workflow.jobs["dry-run"]?.needs).toEqual(["checks"]);
    expect(Object.keys(workflow.jobs).some((name) => name.includes("jsr"))).toBe(false);
  });

  it("uses the checked npm archives in each publication and acceptance job", () => {
    const workflow = Bun.YAML.parse(repositoryFile(".github/workflows/release.yml")) as {
      jobs: Record<string, { steps: Array<{ uses?: string; with?: { name?: string } }> }>;
    };
    for (const job of ["publish-npm", "validate-public", "accept"]) {
      const downloads = workflow.jobs[job]?.steps.filter((step) =>
        step.uses?.startsWith("actions/download-artifact@"),
      );
      expect(downloads?.[0]?.with?.name).toBe("release-candidate");
    }
    const checks = repositoryFile(".github/workflows/release-checks.yml");
    expect(checks).toContain("name: release-candidate");
  });

  it("limits full Host evidence to Release checks", () => {
    const ci = repositoryFile(".github/workflows/ci.yml");
    const checks = Bun.YAML.parse(repositoryFile(".github/workflows/release-checks.yml")) as {
      jobs: Record<string, { if?: string }>;
    };
    for (const job of [
      "native-systemd-host",
      "shipped-systemd-release",
      "shipped-macos-release",
      "complete-release-evidence",
    ]) {
      expect(ci).not.toContain(`  ${job}:`);
      expect(checks.jobs[job]?.if).toBe(`\${{ inputs.full_evidence }}`);
    }
  });

  it("documents workflow operation and immutable candidates", () => {
    const guide = repositoryFile("docs/release-process.md");
    expect(guide).toContain("Run workflow");
    expect(guide).toContain("Do not reuse a published version.");
    expect(guide).toContain("RELEASE_GITHUB_TOKEN");
    expect(guide).not.toContain("git push --atomic origin main");
  });

  it("uses Cocogitto for the coordinated version commit and tags", () => {
    const configuration = repositoryFile("cog.toml");
    const releaseScript = repositoryFile(".github/scripts/release-train.ts");

    expect(configuration).toContain('tag_prefix = "v"');
    expect(configuration).toContain(
      'pre_package_bump_hooks = ["bun ../../.github/scripts/cocogitto-package-version.ts {{version}}"]',
    );
    expect(configuration).toContain("post_bump_hooks = []");
    expect(configuration).not.toContain("console = { path =");
    expect(releaseScript).toContain("assertCocogittoBump(version)");
    expect(releaseScript).toMatch(/directory.*@v.*version/);
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

  it("binds accepted prereleases to their tag, workflow, and public bytes", () => {
    const verification = repositoryFile(".github/scripts/verify-accepted-prerelease.sh");

    expect(verification).toContain("--json isPrerelease");
    expect(verification).toContain('git rev-list -n 1 "$release_tag"');
    expect(verification).toContain('.name == "Accept Release"');
    expect(verification).toContain('release-train.ts verify-published "$manifest"');
    expect(verification).not.toContain("release-jsr");
  });
});
