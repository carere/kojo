import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repositoryFile = (path: string): string =>
  readFileSync(new URL(`../../../../../${path}`, import.meta.url), "utf8");

describe("the Release train", () => {
  it("publishes a prerelease as a hidden candidate before Host validation", () => {
    const workflow = repositoryFile(".github/workflows/prerelease.yml");
    const publish = workflow.indexOf(
      "release-train.ts publish .release-train/release-manifest.json candidate",
    );
    const validate = workflow.indexOf("  validate:\n");
    const accept = workflow.indexOf("  accept:\n");

    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).not.toMatch(/^ {2}(push|schedule):/m);
    expect(workflow).toContain("ubuntu-24.04");
    expect(workflow).toContain("macos-15");
    expect(workflow).toContain("complete-breaking-release-evidence");
    expect(workflow).toContain("verify-published .release-train/release-manifest.json");
    expect(workflow).toContain("needs: validate");
    expect(publish).toBeGreaterThan(0);
    expect(validate).toBeGreaterThan(publish);
    expect(accept).toBeGreaterThan(validate);
    expect(workflow.slice(accept)).toContain(
      "bun .github/scripts/release-tags.ts .release-train/release-manifest.json",
    );
    expect(workflow.indexOf("Record the accepted prerelease")).toBeLessThan(
      workflow.indexOf("Activate the accepted prerelease tags"),
    );
  });

  it("promotes a validated stable candidate without republishing it", () => {
    const workflow = repositoryFile(".github/workflows/release.yml");
    const candidatePublish = workflow.indexOf(
      "release-train.ts publish .release-train/release-manifest.json candidate",
    );
    const validation = workflow.indexOf("  validate-candidate:\n");
    const promotion = workflow.indexOf("  promote:\n");

    expect(workflow).toContain("release_candidate:");
    expect(workflow).toContain(
      "verify-manifest .release-train/accepted-rc/release-manifest.json rc",
    );
    expect(workflow).toContain("Prove that validation accepted the Release Candidate");
    expect(workflow).toContain(
      "verify-accepted-prerelease.sh .release-train/accepted-rc/release-manifest.json",
    );
    expect(workflow).toContain("Refuse code changes after the accepted Release Candidate");
    expect(workflow).toContain("release-train.ts validate-stable-source");
    expect(workflow).toContain("environment: npm-production");
    expect(workflow).toContain("complete-breaking-release-evidence");
    expect(candidatePublish).toBeGreaterThan(0);
    expect(validation).toBeGreaterThan(candidatePublish);
    expect(promotion).toBeGreaterThan(validation);
    expect(workflow.slice(promotion)).not.toContain("bun publish");
    expect(workflow.slice(promotion)).toContain(
      "bun .github/scripts/release-tags.ts .release-train/release-manifest.json",
    );
  });

  it("documents the complete stage order and immutable candidate rule", () => {
    const guide = repositoryFile("docs/release-process.md");

    expect(guide.indexOf("| Alpha |")).toBeLessThan(guide.indexOf("| Beta |"));
    expect(guide.indexOf("| Beta |")).toBeLessThan(guide.indexOf("| Release Candidate |"));
    expect(guide.indexOf("| Release Candidate |")).toBeLessThan(guide.indexOf("| Stable |"));
    expect(guide).toContain("Do not reuse a published version.");
    expect(guide).toContain("Promotion moves `latest` and `next`");
    expect(guide).toContain("cog bump --version 0.1.0-alpha.1 --include-packages");
    expect(guide).toContain("git push --atomic origin main");
    expect(guide).toContain("Select `v0.1.0-alpha.1` in the workflow ref selector.");
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
      { directory: "kojo-client-contracts", name: "@carere/kojo-client-contracts" },
      { directory: "kojo-runner-contracts", name: "@carere/kojo-runner-contracts" },
      { directory: "kojo-runtime", name: "@carere/kojo-runtime" },
      { directory: "kojo", name: "@carere/kojo" },
    ]);
  });

  it("binds accepted prereleases to their tag, workflow, and public bytes", () => {
    const verification = repositoryFile(".github/scripts/verify-accepted-prerelease.sh");

    expect(verification).toContain("--json isPrerelease");
    expect(verification).toContain('git rev-list -n 1 "$release_tag"');
    expect(verification).toContain('.name == "Accept the prerelease"');
    expect(verification).toContain('release-train.ts verify-published "$manifest"');
    expect(verification).toContain('release-train.ts verify-active-tags "$manifest"');
  });
});
