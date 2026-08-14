# 54 — A file the agent creates at the root of `.kojo/` is caught by neither line of defence

**What to build:** A decision, and then whatever it implies. Ticket 50 gave the factory two lines of
defence and the adversarial pass found a path that goes between them.

## What was measured

Against this repository's own `permits`, with `protectedPaths: factoryOwnPaths`:

    permits(Unrestricted, ".kojo/evil.ts")           → true
    permits(Unrestricted, ".kojo/workflows/evil.ts") → false
    permits(LimitedTo,    ".kojo/evil.ts")           → false

Every entry of `factoryOwnPaths` names a file or a directory, and **none of them is `.kojo/`
itself**:

    .kojo/kojo.config.yaml   .kojo/workflows/   .kojo/envelopes.ts
    .kojo/checks.ts          .kojo/commands.ts  .kojo/prompts/

So a file an agent **creates** at the root of `.kojo/` is:

- not barred by ticket 14's guard, because it matches no protected pattern under an `Unrestricted`
  write scope — no `PermissionBreach`, nothing rolled back;
- not hidden by ticket 50's mask, because the mask is built from `git ls-files` over those six
  pathspecs and a file that does not exist yet has no index entry.

`git add --all` stages it and the merge lands it.

**It is reachable in this repository, not only in principle.**
`.kojo/workflows/lane/common.ts` gives the builder, the fixer and the tidier
`writes: { _tag: "Unrestricted" }`.

## Why this is a decision and not a patch

Widening `factoryOwnPaths` to `.kojo/` closes it in one line and takes two things with it:

- **`.kojo/artifacts/`**, which `WorkspaceArtifactReader` reads and which an agent is *supposed* to
  write into;
- **the run's own data directory**, which `alwaysWritable` grants on purpose, and whose docstring
  says an agent's ability to record its work must not hang on an ignore entry anybody can delete.

So the shape is probably *bar `.kojo/` except the two directories an agent is meant to write*, which
is a change to how `protectedPaths` and `alwaysWritable` compose rather than a longer list — and
the ordering of those two is exactly the kind of thing that is right by luck until somebody grades
it.

## Where the wrong sentence came from, because it is worth knowing

Ticket 50 shipped `.kojo/evil.ts` as the worked example of what the second line *does* catch, in two
source docstrings, marked **Measured**. It was not measured; it was reasoned from the shape of the
list. The adversarial pass ran `permits` and got `true`. Both docstrings now use
`.kojo/workflows/evil.ts` for the case that holds and name this one as open.

**Blocked by:** 14, 50 — both done.

**Status:** ready-for-agent

- [ ] A test, written first, that creates a file at the root of `.kojo/` under an `Unrestricted`
      scope and fails today — in the unit tier, over `permits`, and end to end over a run
- [ ] `.kojo/artifacts/` and the run's data directory stay writable, graded rather than assumed. A
      fix that bars an agent from recording its work has traded one fault for a worse one
- [ ] The composition of `protectedPaths` and `alwaysWritable` is stated in one place and graded by
      a table, including the case where a path matches both
- [ ] The mask half is reconsidered too: nothing hides a file that does not exist yet, so if the
      answer here is only a guard, say in `hiddenPaths.ts` that it is only a guard
- [ ] The docstrings on `factoryOwnPaths` and `hiddenPaths` lose the paragraph pointing here

## Comments

*(none yet)*
