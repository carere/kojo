import { describe, expect, it } from "@effect/vitest";
import { Option } from "effect";
import {
  strictly,
  worktreeIsUsable,
} from "../../../../../src/contexts/sandbox/guards/worktreeIsUsable.ts";
import { WorktreeState } from "../../../../../src/contexts/sandbox/models/WorktreeState.ts";
import type { WorktreeFault } from "../../../../../src/contexts/sandbox/models/WorktreeUnusable.ts";

const branch = "kojo/lane";

type Reading = ConstructorParameters<typeof WorktreeState>[0];

/** A tree with nothing wrong with it. Each case below changes exactly one thing. */
const healthy: Reading = {
  head: branch,
  detached: false,
  modified: false,
  tracked: true,
  behind: 0,
  ahead: 0,
};

const reading = (changes: Partial<Reading>) => new WorktreeState({ ...healthy, ...changes });

const faultOf = (
  changes: Partial<Reading>,
  policy?: Parameters<typeof worktreeIsUsable>[0]["policy"],
): WorktreeFault | undefined =>
  Option.getOrUndefined(
    Option.map(
      worktreeIsUsable({
        branch,
        worktreePath: "/worktrees/kojo/lane",
        state: reading(changes),
        ...(policy === undefined ? {} : { policy }),
      }),
      (unusable) => unusable.fault,
    ),
  );

describe("reading a worktree on the way into a sandbox", () => {
  it("lets a healthy tree through", () => {
    expect(faultOf({})).toBeUndefined();
  });

  // The four cases are Sandcastle's four silent skip paths, one by one. Each of them reuses the
  // worktree behind a log line upstream, which is the whole reason Kojo reads the tree itself.
  const skipPaths: ReadonlyArray<{
    readonly name: string;
    readonly changes: Partial<Reading>;
    readonly fault: WorktreeFault;
  }> = [
    {
      name: "a detached HEAD — the state a suspended run can leave",
      changes: { detached: true, head: "" },
      fault: "detached",
    },
    {
      name: "somebody else's branch checked out in our worktree",
      changes: { head: "kojo/other" },
      fault: "wrong-branch",
    },
    {
      name: "uncommitted work, which the branch does not carry",
      changes: { modified: true },
      fault: "modified",
    },
    {
      name: "a branch that moved under the run while it waited",
      changes: { behind: 3 },
      fault: "behind-origin",
    },
  ];

  for (const path of skipPaths) {
    it(`stops on ${path.name}`, () => {
      expect(faultOf(path.changes)).toBe(path.fault);
    });
  }

  it("does not read the run's own commits as a fault", () => {
    // Ahead of origin is what a working lane looks like. Failing on it would fail every run that
    // did anything.
    expect(faultOf({ ahead: 7 })).toBeUndefined();
  });

  it("says nothing about origin for a branch that has none", () => {
    // `behind` is meaningless without an upstream, and a local-only branch is the ordinary case on
    // a machine with no remote. Reading a stale count here would stop runs for no reason.
    expect(faultOf({ tracked: false, behind: 9 })).toBeUndefined();
  });

  it("reports the first fault rather than all of them", () => {
    // A detached HEAD makes the comparison with origin meaningless, so the later readings are
    // consequences. Naming the first says what to fix; naming four says what the first one caused.
    expect(faultOf({ detached: true, head: "", modified: true, behind: 2 })).toBe("detached");
  });

  it("carries the whole reading, so a human need not re-derive it", () => {
    const unusable = Option.getOrThrow(
      worktreeIsUsable({
        branch,
        worktreePath: "/worktrees/kojo/lane",
        state: reading({ behind: 4 }),
      }),
    );

    expect(unusable.branch).toBe(branch);
    expect(unusable.state.behind).toBe(4);
    expect(unusable.summary).toContain("4 commits behind origin");
  });
});

describe("declaring a laxer policy", () => {
  it("keeps the reading and changes only what stops the run", () => {
    expect(faultOf({ modified: true }, { requireCommitted: false })).toBeUndefined();
    expect(faultOf({ behind: 2 }, { requireUpToDate: false })).toBeUndefined();
    expect(faultOf({ head: "kojo/other" }, { requireBranch: false })).toBeUndefined();
  });

  it("turns off one check without turning off the others", () => {
    expect(faultOf({ modified: true, behind: 2 }, { requireCommitted: false })).toBe(
      "behind-origin",
    );
  });

  it("defaults to all three, because each one unchecked is a claim nobody verified", () => {
    expect(strictly).toEqual({
      requireBranch: true,
      requireCommitted: true,
      requireUpToDate: true,
    });
  });
});
