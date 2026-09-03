import { readFileSync } from "node:fs";
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
    expect(guide).toContain("The next action is a version-only PR for `0.1.0-alpha.1`");
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
