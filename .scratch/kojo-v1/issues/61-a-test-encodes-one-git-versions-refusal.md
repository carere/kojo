# 61 — A test encodes one git version's refusal, and the other version does not refuse

**What to build:** A rebuild-after-dirty test that grades Kojo's behaviour rather than the exact
refusal of the git binary that happens to be installed.

## What was measured

`SandcastleSandboxSource.test.ts > cannot even be rebuilt while uncommitted work is in the way`, on
the first CI runs of the container tier:

    macOS, git 2.55.0   → the second acquisition FAILS   (test green)
    Linux, git 2.54.0   → the second acquisition SUCCEEDS (test red)

The failing line is the one about git and not the one about Kojo:

    expect(Result.isFailure(rebuilt)).toBe(true);       // line 251

Everything before it passed, including the two preconditions added while chasing a different theory:
the worktree **was** preserved on release and git **could** read it as dirty. So Sandcastle's
preservation works on both platforms, and what differs is whether `git worktree add` refuses a
branch that is already checked out somewhere.

Locally, git 2.55.0 answers `fatal: a branch named 'kojo/x' already exists`. The runner's 2.54.0 does
not refuse in the same shape.

## What the test was for, and what it is now

The comment above the assertion says it plainly: the value is that a second acquisition **does not
quietly continue on a stale tree**. That claim is Kojo's and is worth keeping. The mechanism it
asserts — *git refuses, therefore Sandcastle's create fails* — is a git implementation detail this
repository does not control and did not choose.

It is also the weaker half of its own argument. The same comment says the strong version:

> This is the strongest argument for `requireCommitted` being on by default: the guard turns this
> into a named `WorktreeUnusable` at the moment the dirt appears, instead of an unexplained create
> failure the next time somebody answers a gate.

That guard is Kojo's, it fires on the acquisition rather than on the rebuild, and the test above this
one already grades it (`unusable.fault` is `modified`). So the behaviour that matters is covered; what
is not is the claim that git will save you if the guard is off.

## Shapes

1. **Assert what Kojo does, and stop asserting what git does.** Keep the release-preserves-a-dirty-
   tree half — that one held on both platforms — and drop the rebuild half, or assert only that the
   rebuild does not silently hand back a *clean-looking* stale tree, whichever way git answers.
2. **Grade both answers.** A rebuild that fails is fine and a rebuild that succeeds onto the
   preserved dirty tree is also fine *provided Kojo notices the dirt* — which `worktreeIsUsable`
   does. That is a stronger test than either platform's accident.
3. Pin git in CI to match the developer machine. Last, and wrong: it makes the suite pass by freezing
   an implementation detail of a tool nobody here pins, and the next developer's git breaks it again.

**Blocked by:** none.

**Status:** ready-for-agent

- [ ] The container tier is green on both git 2.54 and 2.55, proven by running it against both
      rather than by reasoning about the change
- [ ] Whatever replaces the assertion grades **Kojo's** answer to a stale dirty tree, not the git
      binary's
- [ ] The comment's strong claim — that `requireCommitted` is what makes this safe — is the one the
      test carries, and it says which test grades it
- [ ] Nothing in the suite depends on a git version again, checked the way ticket 59 checks its own
      assumption: run it with the other version and see

## Comments

*(none yet)*
