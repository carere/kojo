# 60 — A git error reads as "clean", and then the uncommitted work is force-deleted

**What to build:** Either a Kojo-side check that does not depend on Sandcastle's swallowed one, or a
recorded upstream fault with the blast radius stated. Today a `git status` that fails for any reason
means a run's uncommitted work is removed with `--force`, and nothing says so.

## What was measured

Read out of `@ai-hero/sandcastle@0.12.0`'s own `dist`:

    var hasUncommittedChanges = (worktreePath) =>
      execGit(["status", "--porcelain"], worktreePath).pipe(
        Effect_exports.map((output) => output.trim().length > 0)
      );

and, at the close path:

    const isDirty = yield* hasUncommittedChanges(worktreeInfo.path).pipe(
      Effect_exports.catchAll(() => Effect_exports.succeed(false))   // ← every failure is "clean"
    );
    if (isDirty) return { preservedWorktreePath: worktreeInfo.path };
    yield* remove(worktreeInfo.path)...                              // ← git worktree remove --force

`remove` is `git worktree remove --force`. So the sequence is: **git cannot answer → the tree is
assumed clean → the tree is deleted, uncommitted work and all.** The one case the preservation exists
for is the one case the `catchAll` cannot distinguish from success.

## How it was found

The first CI run of the container tier on a Linux runner, 2026-08-15.
`SandcastleSandboxSource.test.ts > cannot even be rebuilt while uncommitted work is in the way`
failed with `expected false to be true`: the worktree the test had deliberately dirtied was **gone**
after release, where it survives on macOS.

The runner's log carries no git error, because there is none to carry — it is swallowed by the
`catchAll` above. What differs on Linux is still unknown; `safe.directory` was ruled out (the log
shows checkout adding one, and no `dubious ownership` anywhere).

The test now asserts its own precondition — it runs the same `git status --porcelain` Sandcastle runs
and checks the exit code and the output — so the next run names the cause instead of showing
`expected false to be true`. **That is a diagnosis, not a fix.**

## Why it matters beyond the test

`architecture.md` §4 says the branch is the durable state, and this is the one path that deletes
state. A run that reaches a gate with uncommitted work is the exact shape the preservation exists
for — build-record §6 records `WorktreeUnusable{modified}` arriving that way. If git is unreadable at
that moment on somebody's machine, the work is destroyed silently and the run reports nothing unusual.

Kojo already refuses to guess in the same situation: `Permissions.output` treats a failed
`git diff` as an error precisely because *an empty answer from a failed command reads as "nothing
changed"*. This is that rule, broken, one layer down and in somebody else's code.

## Shapes

1. **Ask before releasing.** Kojo already reads the worktree state on acquisition
   (`SandcastleSandboxSource.worktree` → `worktreeIsUsable`). Reading it again before `close()` and
   refusing to release a tree it cannot read would put the decision on Kojo's side of the boundary,
   where a failed git command is already an error rather than a `false`.
2. **Report it upstream**, and record it here as edge 14 either way. It is a two-line change there:
   the `catchAll` should preserve rather than delete.
3. Accept it and document the blast radius. Last: silent data loss is the one thing this repository's
   permission guard was built to prevent.

**Blocked by:** none.

**Status:** ready-for-agent

- [ ] What actually fails on Linux is measured rather than inferred — the next CI run's named
      precondition is the cheapest way, and it costs one cycle
- [ ] A worktree Kojo cannot read is never deleted by a Kojo release path, proven by a test that
      makes `git status` fail
- [ ] `architecture.md` §8 gains the edge, whichever shape is chosen
- [ ] `SandcastleSandboxSource.test.ts`'s precondition stays, because it is what turned an
      unexplained boolean into a diagnosis

## Comments

*(none yet)*
