import { describe, expect, it } from "@effect/vitest";
import {
  canHide,
  hiddenFiles,
  hideFiles,
  listHidden,
  pathspecsOf,
  restoreFiles,
  showFiles,
} from "../../../../../src/contexts/sandbox/guards/hiddenPaths.ts";
import { factoryOwnPaths } from "../../../../../src/contexts/workflow/models/PermissionPolicy.ts";

/**
 * The pure half of taking the factory's own files out of a worktree.
 *
 * Every claim here was measured against real git first — see the docstrings in `hiddenPaths.ts` —
 * and what is graded below is that the argv Kojo builds is the argv those measurements were about.
 * The removal itself, the tree the run commits and the trunk the merge lands are the integration
 * tier's, because none of them can be answered without a repository.
 */

describe("which providers a filesystem mask can reach", () => {
  it("masks the two kinds whose worktree is the tree the agent reads", () => {
    expect(canHide("bind-mount")).toBe(true);
    // `none` is masked as well, and it buys almost nothing — the agent is a host process with the
    // unmasked repository three directories up. `noSandbox` says so where an author will read it.
    expect(canHide("none")).toBe(true);
  });

  it("refuses to mask an isolated provider, whose tree comes from the object database", () => {
    // `syncIn` bundles the repository, clones it inside the sandbox and checks the branch out, so
    // `.kojo/` reappears whatever the host worktree looks like. Masking anyway would leave a host
    // worktree missing its factory and a sandbox that still has it.
    expect(canHide("isolated")).toBe(false);
  });
});

describe("the author's list as git pathspecs", () => {
  it("keeps the factory's own paths exactly as they are written", () => {
    // Trailing slashes included. A directory pathspec is how git spells "this tree and everything
    // in it", so nothing here has to expand `.kojo/workflows/` by hand.
    expect(pathspecsOf(factoryOwnPaths)).toEqual([...factoryOwnPaths]);
  });

  it("drops blank entries and repeats, which would mark the same file twice", () => {
    expect(pathspecsOf([" .kojo/checks.ts ", "", "   ", ".kojo/checks.ts"])).toEqual([
      ".kojo/checks.ts",
    ]);
  });

  it("produces nothing at all from an empty list, which is the explicit opt-out", () => {
    expect(pathspecsOf([])).toEqual([]);
  });
});

describe("the four commands the mask is made of", () => {
  const files = [".kojo/checks.ts", ".kojo/workflows/factory.ts"];

  it("asks git which tracked files the pathspecs name, NUL separated", () => {
    // `-z` because a path may hold a newline, and git quotes such a path in every other form. The
    // `--` is what stops a pathspec that happens to look like an option being read as one.
    expect(listHidden([".kojo/workflows/"])).toEqual(["ls-files", "-z", "--", ".kojo/workflows/"]);
  });

  it("reads the NUL list back without the empty tail git always emits", () => {
    expect(hiddenFiles(".kojo/checks.ts\0.kojo/workflows/factory.ts\0")).toEqual(files);
    expect(hiddenFiles("")).toEqual([]);
  });

  it("marks the files skip-worktree rather than removing them from the index", () => {
    // The index is what makes the run's own commit carry the original blobs. A command here that
    // touched it — `rm --cached`, say — would land a deleted `.kojo/` on the trunk, which is the
    // worse of the two faults this whole guard exists to avoid.
    expect(hideFiles(files)).toEqual(["update-index", "--skip-worktree", "--", ...files]);
  });

  it("unsets the bit before restoring, because git will not check out a path it is ignoring", () => {
    expect(showFiles(files)).toEqual(["update-index", "--no-skip-worktree", "--", ...files]);
    // From the index and not from HEAD: the index still holds the blobs the worktree was cut with,
    // even after the run has committed on top of them.
    expect(restoreFiles(files)).toEqual(["checkout", "--", ...files]);
  });
});
