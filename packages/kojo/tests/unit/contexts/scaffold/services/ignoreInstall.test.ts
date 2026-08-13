import { describe, expect, it } from "@effect/vitest";
import {
  ignoreFor,
  installArtifacts,
} from "../../../../../src/contexts/scaffold/services/ignoreInstall.ts";

/**
 * The decision ticket 47 turns on, put to a value.
 *
 * `kojo init` instructs an install; the install writes `node_modules/`; the first approved run
 * then refuses its merge over it. So initialisation must arrange for what its own instructions
 * create to be ignored — without rewriting a `.gitignore` the repository already has, because that
 * file is the person's.
 */
describe("what the repository's .gitignore becomes", () => {
  it("covers node_modules/, which is what the instructed install writes", () => {
    expect(installArtifacts).toContain("node_modules/");
  });

  it("creates the file, commented, when the repository has none", () => {
    const decision = ignoreFor({});

    expect(decision.outcome).toBe("created");
    expect(decision.added).toEqual(installArtifacts);
    // One commented block — the same shape an appended one has, so the file reads the same
    // whichever way it arrived. The comment says who wrote it.
    expect(decision.content).toContain("kojo init");
    expect(decision.content).toContain("node_modules/");
    expect(decision.content?.endsWith("\n")).toBe(true);
  });

  it("appends the missing entries and keeps every byte the person had", () => {
    const mine = "# my rules\ndist\n*.log\n";
    const decision = ignoreFor({ existing: mine });

    expect(decision.outcome).toBe("updated");
    expect(decision.added).toEqual(["node_modules/"]);
    // Never rewritten, never reordered: the existing content is the prefix, byte for byte.
    expect(decision.content?.startsWith(mine)).toBe(true);
    expect(decision.content).toContain("node_modules/");
    expect(decision.content).toContain("kojo init");
  });

  it("mends a file whose last line has no newline, rather than gluing onto it", () => {
    const decision = ignoreFor({ existing: "dist" });

    expect(decision.outcome).toBe("updated");
    expect(decision.content?.startsWith("dist\n")).toBe(true);
    // `dist` stayed its own line; the block did not fuse into `dist# What …`.
    expect(decision.content).not.toContain("dist#");
  });

  it.each(["node_modules", "node_modules/", "/node_modules", "/node_modules/", "**/node_modules"])(
    "appends nothing when %s already covers it",
    (spelling) => {
      const decision = ignoreFor({ existing: `${spelling}\n` });

      expect(decision.outcome).toBe("kept");
      expect(decision.added).toEqual([]);
      expect(decision.content).toBeUndefined();
    },
  );

  it("does not mistake a comment, a blank line, or a negation for a cover", () => {
    const decision = ignoreFor({
      existing: ["# node_modules", "", "!node_modules", ""].join("\n"),
    });

    expect(decision.outcome).toBe("updated");
    expect(decision.added).toEqual(["node_modules/"]);
  });

  it("is idempotent: what one run appended, the next run counts as covered", () => {
    const first = ignoreFor({ existing: "dist\n" });
    const second = ignoreFor({ existing: first.content });

    expect(second.outcome).toBe("kept");
    expect(second.content).toBeUndefined();
  });

  it("deliberately leaves the lockfile out: the sandbox installs against it, frozen", () => {
    // `commands.install` is `bun install --frozen-lockfile` / `npm ci` — both fail in a worktree
    // cut from a branch that never committed the lockfile. Ignoring it here would make every
    // stamped sandbox install fail, so the commit step in init's instructions carries it instead.
    for (const entry of installArtifacts) {
      expect(entry).not.toContain("lock");
    }
    const decision = ignoreFor({});
    expect(decision.content).not.toContain("bun.lock\n");
    expect(decision.content).not.toContain("package-lock.json\n");
  });
});
