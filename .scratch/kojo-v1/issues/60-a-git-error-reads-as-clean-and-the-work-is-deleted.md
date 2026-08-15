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

## How it was found — and the diagnosis that came with it was wrong

Found while chasing a CI failure this does **not** explain, and the correction is worth more than the
original claim.

`SandcastleSandboxSource.test.ts > cannot even be rebuilt while uncommitted work is in the way`
failed on a Linux runner with `expected false to be true`, and the `catchAll` above was read as the
cause: git fails → the tree reads clean → the tree is deleted. A precondition was added to that test
— running the same `git status --porcelain` Sandcastle runs, asserting its exit code and its output —
so that the next run would name it.

**It named the opposite.** Both preconditions passed: git could read the worktree, and the worktree
was dirty and still there. The failure is on a later line and belongs to ticket 61. Nothing here
caused it.

So this ticket is a **latent** fault rather than an observed one. The code above is quoted from
`@ai-hero/sandcastle@0.12.0`'s `dist` and says what it says: any failure of `git status` is turned
into *clean*, and the next statement force-removes the worktree. It has never been seen to fire. It
is kept open because the consequence is silent data loss, not because anything has lost data.

The precondition stays in that test regardless: it is what turned a guess into a refutation, and it
is the reason the real cause was found on the next run rather than the fifth.

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

**Status:** done — and it was not latent after all

- [x] A worktree Kojo cannot read is never deleted by a Kojo release path, proven by a test that
      makes `git status` fail — and the fault **was** reproduced first, so this is measured rather
      than latent
- [x] `architecture.md` §8 gains it as **edge 14**, with the trade stated
- [x] `SandcastleSandboxSource.test.ts`'s precondition stays

## Comments

*(none yet)*

## Comments

### 2026-08-15 — it fires, and the first attempt to make it fire is why the ticket nearly closed

**Reproduced, on this machine, through Kojo's own release path.** Two corruptions, and only the
second loses anything:

| what was broken | `git status` | after release |
|---|---|---|
| the worktree's `.git` registration | `fatal: not a git repository` (128) | worktree **and** work still there |
| only the index, `chmod 000` | `fatal: … index file open failed: Permission denied` (128) | **both gone** |

The first is why this ticket spent a day marked latent: breaking the registration breaks
`git worktree remove --force` too, so Sandcastle's swallowed failure is followed by a swallowed
deletion and nothing happens. It reads like the fault cannot fire. **It can — it just needs the
parent repository to stay able to remove the tree while the tree itself cannot answer.** An
unreadable index is enough, and that is an ordinary thing: a permission change, a full disk, a
half-written index from a killed process.

So the wording that stood here — *"it has never been seen to fire"* — was true only of the one
experiment that had been tried.

**The fix asks the same question one step earlier and reads the answer the opposite way.**
`preserveIfUnreadable` in `adapters/boundary.ts` runs the very command Sandcastle's decision rests
on. A worktree that answers is released exactly as before; one that cannot is **not closed at all**,
and the release logs where it is and how to remove it by hand.

The trade is deliberate and is now edge 14: a leaked worktree and a container that outlives its
scope, against deleted work. This repository has made that trade before — `Permissions.output`
treats a failed `git diff` as an error rather than as an empty change-set, because *an empty answer
from a failed command reads as nothing changed*. This is the same sentence one layer down.

**Proven, and by the mutation.** Making `preserveIfUnreadable` always answer `false` — the state the
ticket found — reddens exactly one test, with the message it was given: `the worktree was deleted`.
The second test in the pair is what keeps the ordinary path honest: a readable worktree is still
removed on release, so the guard cannot be passing by never releasing anything.

**Not reported upstream.** Shape 2 of this ticket suggested it; the fix here does not need it, and a
two-line change in somebody else's `dist` is not something this repository can land. The edge records
what Sandcastle does so the next reader does not have to rediscover it.
