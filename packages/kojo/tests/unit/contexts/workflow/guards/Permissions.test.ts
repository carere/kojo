import { describe, expect, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import { Workspace } from "../../../../../src/contexts/sandbox/ports/Workspace.ts";
import * as Permissions from "../../../../../src/contexts/workflow/guards/Permissions.ts";
import { PermissionBreach } from "../../../../../src/contexts/workflow/models/PermissionBreach.ts";
import type { PermissionPolicy } from "../../../../../src/contexts/workflow/models/PermissionPolicy.ts";
import { factoryOwnPaths } from "../../../../../src/contexts/workflow/models/PermissionPolicy.ts";
import { fingerprintedTree, untracked } from "../../../../support/fingerprintedTree.ts";

const dataDirectory = ".kojo/data/";

const policy = (agent: string, writes: PermissionPolicy["writes"]): PermissionPolicy => ({
  agent,
  writes,
  protectedPaths: factoryOwnPaths,
  alwaysWritable: [dataDirectory],
});

const builder = policy("hotfixer", { _tag: "Unrestricted" });
const scout = policy("scout", { _tag: "LimitedTo", patterns: [] });
const librarian = policy("librarian", { _tag: "LimitedTo", patterns: [".kojo/workflows/*.ts"] });

/** Assert the guard refused, and hand the breach back so the test can read what it holds. */
const breachIn = <A, E>(outcome: Result.Result<A, E>): PermissionBreach => {
  const failure = Result.isFailure(outcome) ? outcome.failure : undefined;
  if (failure instanceof PermissionBreach) return failure;
  throw new Error(`expected a permission breach, got ${JSON.stringify(outcome)}`);
};

describe("what an agent may change", () => {
  it("lets every agent record its own work, whatever its scope", () => {
    // A read-only agent is read-only with respect to the repository, never to its own report.
    expect(Permissions.permits(scout, ".kojo/data/runs/run_1/envelope.json")).toBe(true);
    expect(Permissions.permits(builder, ".kojo/data/runs/run_1/prompt.md")).toBe(true);
  });

  it("bars an unrestricted agent from the factory's own files", () => {
    expect(Permissions.permits(builder, "src/health.ts")).toBe(true);
    expect(Permissions.permits(builder, ".kojo/workflows/factory.ts")).toBe(false);
    expect(Permissions.permits(builder, ".kojo/kojo.config.yaml")).toBe(false);
  });

  it("bars a read-only agent from the repository entirely", () => {
    expect(Permissions.permits(scout, "src/health.ts")).toBe(false);
    expect(Permissions.permits(scout, "notes.md")).toBe(false);
  });

  it("unlocks a protected path for the one agent that names it", () => {
    // Naming a path is what makes a maintainer of it, and it is tested before the protected list.
    expect(Permissions.permits(librarian, ".kojo/workflows/factory.ts")).toBe(true);
    expect(Permissions.permits(librarian, ".kojo/kojo.config.yaml")).toBe(false);
    // The scope is still a scope: it says workflows, so it does not say source.
    expect(Permissions.permits(librarian, "src/health.ts")).toBe(false);
  });
});

describe("the change-set of a working tree", () => {
  it.effect("reads tracked counts and untracked names out of git", () =>
    Effect.gen(function* () {
      const fingerprints = yield* Permissions.snapshot;
      expect([...fingerprints]).toEqual([
        ["src/health.ts", "3,1"],
        ["notes.md", untracked],
      ]);
    }).pipe(
      Effect.provide(fingerprintedTree({ "src/health.ts": "3,1", "notes.md": untracked }).layer),
    ),
  );

  it.effect("fails loudly on a repository it cannot read", () =>
    Effect.gen(function* () {
      // The dangerous failure is the quiet one: an empty answer from a failed `git diff` reads as
      // "nothing changed", so the guard would clear every path on exactly the trees it cannot see.
      const outcome = yield* Permissions.snapshot.pipe(Effect.result);

      expect(Result.isFailure(outcome)).toBe(true);
      if (Result.isFailure(outcome)) {
        expect(outcome.failure.reason).toContain("could not be fingerprinted");
      }
    }).pipe(Effect.provide(fingerprintedTree({}, { unreadable: true }).layer)),
  );

  it("counts a reversion as a change", () => {
    // The `git checkout` case: a path that was dirty before and is clean now has been modified,
    // and a guard that only watched for writes would never see it.
    const before = new Map([
      ["src/health.ts", "3,1"],
      ["notes.md", untracked],
    ]);
    const after = new Map([
      ["src/other.ts", "1,0"],
      ["notes.md", untracked],
    ]);

    expect(Permissions.changedPaths(before, after)).toEqual(["src/health.ts", "src/other.ts"]);
  });
});

describe("enforcing what an agent was permitted", () => {
  it.effect("reports what the agent legitimately touched", () =>
    Effect.gen(function* () {
      const before = yield* Permissions.snapshot;
      const workspace = yield* Workspace;
      yield* workspace.write("src/health.ts", "fixed");

      expect(yield* Permissions.enforce(builder, before)).toEqual(["src/health.ts"]);
    }).pipe(Effect.provide(fingerprintedTree({}).layer)),
  );

  it.effect("deletes a file the agent created outside its scope", () =>
    Effect.gen(function* () {
      const tree = fingerprintedTree({});

      const outcome = yield* Effect.gen(function* () {
        const before = yield* Permissions.snapshot;
        const workspace = yield* Workspace;
        yield* workspace.write(".kojo/workflows/grader.ts", "always pass");
        return yield* Permissions.enforce(builder, before).pipe(Effect.result);
      }).pipe(Effect.provide(tree.layer));

      const breach = breachIn(outcome);
      expect(breach.agent).toBe("hotfixer");
      expect(breach.scope).toContain("barred from");
      expect(breach.paths.map((rollback) => rollback.path)).toEqual([".kojo/workflows/grader.ts"]);
      expect(breach.paths[0]?.outcome).toEqual({ _tag: "Deleted" });
      // Detection alone would leave the repository holding the change while reporting a failure.
      expect(tree.changes.has(".kojo/workflows/grader.ts")).toBe(false);
    }),
  );

  it.effect("restores a tracked file the agent edited outside its scope", () =>
    Effect.gen(function* () {
      const tree = fingerprintedTree({});

      const outcome = yield* Effect.gen(function* () {
        const before = yield* Permissions.snapshot;
        // Already tracked, and the agent edited it: a change-set entry with numstat counts.
        tree.changes.set(".kojo/checks.ts", "0,12");
        return yield* Permissions.enforce(scout, before).pipe(Effect.result);
      }).pipe(Effect.provide(tree.layer));

      const breach = breachIn(outcome);
      expect(breach.scope).toBe("read-only");
      expect(breach.paths[0]?.outcome).toEqual({ _tag: "Restored" });
      expect(tree.changes.has(".kojo/checks.ts")).toBe(false);
    }),
  );

  it.effect("removes a file the agent created and then staged", () =>
    Effect.gen(function* () {
      // Staging puts a new file in `git diff HEAD`, so it is tracked — and `HEAD` has nothing to
      // restore it from. Removing it is the same undo for that case.
      const tree = fingerprintedTree({}, { absentFromHead: [".kojo/commands.ts"] });

      const outcome = yield* Effect.gen(function* () {
        const before = yield* Permissions.snapshot;
        tree.changes.set(".kojo/commands.ts", "9,0");
        return yield* Permissions.enforce(builder, before).pipe(Effect.result);
      }).pipe(Effect.provide(tree.layer));

      expect(breachIn(outcome).paths[0]?.outcome).toEqual({ _tag: "Deleted" });
      expect(tree.changes.has(".kojo/commands.ts")).toBe(false);
    }),
  );

  it.effect("leaves a path that was already dirty exactly as it is", () =>
    Effect.gen(function* () {
      const tree = fingerprintedTree({ ".kojo/checks.ts": "2,0" });

      const outcome = yield* Effect.gen(function* () {
        const before = yield* Permissions.snapshot;
        tree.changes.set(".kojo/checks.ts", "7,3");
        return yield* Permissions.enforce(builder, before).pipe(Effect.result);
      }).pipe(Effect.provide(tree.layer));

      expect(breachIn(outcome).paths[0]?.outcome).toEqual({ _tag: "LeftAsIs" });
      // Somebody had uncommitted work here. Discarding it to tidy up would be this guard doing
      // the harm it exists to prevent.
      expect(tree.changes.get(".kojo/checks.ts")).toBe("7,3");
    }),
  );

  it.effect("names the uncommitted work an agent reverted, because nothing can restore it", () =>
    Effect.gen(function* () {
      const tree = fingerprintedTree({ ".kojo/checks.ts": "2,0" });

      const outcome = yield* Effect.gen(function* () {
        const before = yield* Permissions.snapshot;
        // What `git checkout .kojo/` inside a shell looks like from the outside.
        tree.changes.delete(".kojo/checks.ts");
        return yield* Permissions.enforce(builder, before).pipe(Effect.result);
      }).pipe(Effect.provide(tree.layer));

      expect(breachIn(outcome).paths[0]?.outcome).toEqual({ _tag: "WorkLost" });
    }),
  );

  it.effect("says which paths it could not undo", () =>
    Effect.gen(function* () {
      const tree = fingerprintedTree({}, { refuses: [".kojo/workflows/grader.ts"] });

      const outcome = yield* Effect.gen(function* () {
        const before = yield* Permissions.snapshot;
        const workspace = yield* Workspace;
        yield* workspace.write(".kojo/workflows/grader.ts", "always pass");
        return yield* Permissions.enforce(builder, before).pipe(Effect.result);
      }).pipe(Effect.provide(tree.layer));

      expect(breachIn(outcome).paths[0]?.outcome).toEqual({
        _tag: "NotUndone",
        reason: "refused the undo",
      });
      // What it cannot undo, it names. The repository is still holding this one.
      expect(tree.changes.has(".kojo/workflows/grader.ts")).toBe(true);
    }),
  );
});

describe("guarding one agent call", () => {
  it.effect("fingerprints before and after, and hands back what changed", () =>
    Effect.gen(function* () {
      const call = Effect.gen(function* () {
        const workspace = yield* Workspace;
        yield* workspace.write("src/health.ts", "fixed");
        return "done";
      });

      const permitted = yield* Permissions.withPermissions(builder, call);
      expect(permitted.value).toBe("done");
      expect(permitted.changed).toEqual(["src/health.ts"]);
    }).pipe(Effect.provide(fingerprintedTree({}).layer)),
  );

  it.effect("kills the call that overstepped, and reverts it", () =>
    Effect.gen(function* () {
      const tree = fingerprintedTree({});
      const call = Effect.gen(function* () {
        const workspace = yield* Workspace;
        yield* workspace.write("src/health.ts", "fixed");
        yield* workspace.write(".kojo/workflows/grader.ts", "always pass");
        return "done";
      });

      const outcome = yield* Permissions.withPermissions(builder, call).pipe(
        Effect.result,
        Effect.provide(tree.layer),
      );

      expect(breachIn(outcome).paths[0]?.path).toBe(".kojo/workflows/grader.ts");
      expect(tree.changes.has(".kojo/workflows/grader.ts")).toBe(false);
      // The permitted change is the agent's work, and it stays.
      expect(tree.changes.has("src/health.ts")).toBe(true);
    }),
  );

  it.effect("enforces on the failing path too", () =>
    Effect.gen(function* () {
      const tree = fingerprintedTree({});
      // An agent whose call errored may have written first. Leaving the change behind because the
      // call also failed is the one outcome nobody wants.
      const call = Effect.gen(function* () {
        const workspace = yield* Workspace;
        yield* workspace.write(".kojo/workflows/grader.ts", "always pass");
        return yield* Effect.fail("the agent gave up" as const);
      });

      const outcome = yield* Permissions.withPermissions(builder, call).pipe(
        Effect.result,
        Effect.provide(tree.layer),
      );

      // The breach wins over the call's own failure: it is the fact about the repository.
      expect(breachIn(outcome).paths[0]?.path).toBe(".kojo/workflows/grader.ts");
      expect(tree.changes.has(".kojo/workflows/grader.ts")).toBe(false);
    }),
  );
});
