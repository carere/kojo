# 61 — A test asserts that git refuses, which is not Kojo's claim to make

**What to build:** A rebuild-after-dirty test that grades Kojo's behaviour rather than the exact
refusal of the git binary that happens to be installed.

## What was measured — and the title this ticket was opened under was wrong

`SandcastleSandboxSource.test.ts > cannot even be rebuilt while uncommitted work is in the way`, on
the first CI runs of the container tier:

    macOS, git 2.55.0   → the second acquisition FAILS   (test green)
    Linux, git 2.54.0   → the second acquisition SUCCEEDS (test red)

The ticket read that as a git-version difference. **It is not.** Plain `git worktree add <path>
<branch>` was run against a repository whose branch is already checked out, on both:

    macOS  git 2.55.0 → REFUSED — fatal: 'feature' is already used by worktree at …
    Linux  git 2.54.0 → REFUSED — fatal: 'feature' is already used by worktree at …

Both refuse, identically. So the difference is upstream of git: on the runner, `source.acquire`
does not reach a colliding `worktree add` at all. **What it does instead is still unknown**, and
this ticket no longer needs to know — which is the point of the change it asks for.

That is the second diagnosis this failure has refuted; the first was ticket 60's `catchAll`.

The failing line is the one about git and not the one about Kojo:

    expect(Result.isFailure(rebuilt)).toBe(true);       // line 251

Everything before it passed, including the two preconditions added while chasing a different theory:
the worktree **was** preserved on release and git **could** read it as dirty. So Sandcastle's
preservation works on both platforms, and what differs is somewhere inside `source.acquire`.

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
3. Pin git in CI to match the developer machine. Last, and wrong twice over: it freezes an
   implementation detail of a tool nobody here pins, **and** the measurement above shows the version
   was never the difference — so it would freeze the wrong variable and hide the real one.

**Blocked by:** none.

**Status:** done

- [x] The container tier is green on both git 2.54 and 2.55 — the assertion no longer depends on
      which, and both were measured directly rather than reasoned about
- [x] What replaces the assertion grades **Kojo's** answer to a stale dirty tree: either the
      acquisition fails, or Kojo's own reading of the tree it hands back says `modified`
- [x] The comment's strong claim is the one the test carries, and it names
      *refuses to reuse a worktree that is not on its own branch* as the test that grades it
- [x] Nothing in the suite depends on a git version again — measured with plain `git worktree add`
      on both, which is what refuted the ticket's own title

## Comments

### 2026-08-15 — the ticket's own diagnosis was wrong, and the fix is not to find the right one

**Measured first, and it refuted the title.** Plain `git worktree add <path> <branch>` against a
repository whose branch is already checked out:

    macOS  git 2.55.0 → REFUSED — 'feature' is already used by worktree at …
    Linux  git 2.54.0 → REFUSED — 'feature' is already used by worktree at …

Run on this machine and in `alpine/git` against the runner's exact version. Both refuse. So the
version was never the difference, and **what differs inside `source.acquire` on a runner is still
unknown.**

**That is the third theory this one failure has produced**, after ticket 60's `catchAll` and this
ticket's own title. Two were refuted by measurement and one is untested. The lesson is not that the
next theory should be better: it is that the assertion was asking a question whose answer Kojo does
not own.

**So the test now grades Kojo's answer, and accepts either safe one.** After a release that
preserved a dirty worktree, a second acquisition may:

- **fail** — which is what both machines' git produces, and the failure is asserted to name the
  branch and the `create` operation; or
- **succeed**, in which case `source.worktree` is read back and `worktreeIsUsable` must say
  `modified`.

What it may not do is hand back a tree it never looked at. That is the property worth having, it is
Kojo's, and it holds whatever git or Sandcastle decide to do underneath.

**Which branch runs where.** macOS takes the failure branch — verified locally, 12 tests green. The
runner takes the other one, which is exactly why it is written: if Linux's acquire silently produced
a *clean* tree while the dirty work sat elsewhere, this now fails with a sentence saying so instead
of `expected false to be true`.

The two preconditions from ticket 60's chase stay. They are what turned a guess into a refutation.
