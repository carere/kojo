import { describe, expect, it } from "@effect/vitest";
import { packageManagerFrom } from "../../../../../src/contexts/scaffold/services/detectPackageManager.ts";

/**
 * The decision, put to a table.
 *
 * It is a pure function of evidence precisely so this can be a table: the looking is one effect,
 * the deciding is one function, and only the second one has a precedence order that can be wrong.
 */
describe("reading which package manager a repository is built with", () => {
  it("believes the packageManager field over any lockfile", () => {
    const read = packageManagerFrom({
      declared: "pnpm@9.1.0",
      present: ["bun.lock", "package-lock.json"],
    });

    expect(read.manager).toBe("pnpm");
    expect(read.evidence).toBe("the packageManager field of package.json");
  });

  it("ignores a packageManager field naming something it has never heard of", () => {
    const read = packageManagerFrom({ declared: "cargo@1.0.0", present: ["yarn.lock"] });
    expect(read.manager).toBe("yarn");
  });

  it.each([
    ["bun.lockb", "bun"],
    ["bun.lock", "bun"],
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["package-lock.json", "npm"],
  ] as const)("reads %s as %s", (lockfile, manager) => {
    expect(packageManagerFrom({ present: [lockfile] }).manager).toBe(manager);
  });

  it("resolves two lockfiles the way Sandcastle does, so the two tools never disagree", () => {
    // A repository that migrated and left the old file behind is the ordinary case, not a strange
    // one. Sandcastle builds the worktree this repository is checked out into; if it read the pair
    // the other way round, the image and the command block would name two different managers.
    expect(packageManagerFrom({ present: ["package-lock.json", "bun.lock"] }).manager).toBe("bun");
    expect(packageManagerFrom({ present: ["yarn.lock", "pnpm-lock.yaml"] }).manager).toBe("pnpm");
  });

  it("records that npm with no evidence was a guess", () => {
    const read = packageManagerFrom({ present: [] });
    expect(read.manager).toBe("npm");
    // Absent, and read by both stamped files: they say "no lockfile was found, so npm was assumed"
    // rather than asserting a file that is not there.
    expect(read.evidence).toBeUndefined();
  });

  it("gives every manager an install command and a way into the image", () => {
    // npm is the one manager the base image already carries, so its image block is empty on
    // purpose. Every other manager must contribute a line, or edge 7 is open for that answer.
    for (const lockfile of ["bun.lock", "pnpm-lock.yaml", "yarn.lock"] as const) {
      const read = packageManagerFrom({ present: [lockfile] });
      expect(read.install).toContain(read.manager);
      expect(read.image.length).toBeGreaterThan(0);
    }
    expect(packageManagerFrom({ present: ["package-lock.json"] }).install).toBe("npm ci");
  });
});
