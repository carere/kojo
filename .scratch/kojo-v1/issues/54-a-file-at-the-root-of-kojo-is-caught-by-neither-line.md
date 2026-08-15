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

**Status:** done

- [x] A test, written first, that creates a file at the root of `.kojo/` under an `Unrestricted`
      scope and failed on the tree it was written against — seven unit tests over `permits` and
      `enforce`, and one over a whole `kojo run`
- [x] `.kojo/artifacts/` and the run's data directory stay writable, graded rather than assumed —
      including that what an agent records is still on disk after a run that barred the directory
      around it
- [x] The composition is stated in one place — `permits`' own docstring, five rules in order — and
      graded by a table including the path that matches both lists
- [x] The mask half is reconsidered: `hiddenPaths` now says it is a guard against **reading** and
      cannot cover a file that does not exist yet, and says why its list stays narrow
- [x] The docstrings on `factoryOwnPaths` and `hiddenPaths` lose the paragraph pointing here

## Comments

*(none yet)*

## Comments

### 2026-08-15 — the bar is Kojo's, not the author's

**Where it went, and that is the decision.** Not into `factoryOwnPaths` — into `permits` itself:

    if (under(runOwnPaths)) return true;                          // what a run records
    if (under(policy.alwaysWritable)) return true;                // what the author granted
    if (LimitedTo && under(policy.writes.patterns)) return true;   // what this agent maintains
    if (under([`${factoryDirectory}/`])) return false;             // Kojo's own bar  ← ticket 54
    if (under(policy.protectedPaths)) return false;                // what the author barred
    return policy.writes._tag === "Unrestricted";

Three reasons for that placement, and the second is the one that decided it:

1. **A factory already stamped is covered without editing a workflow.** Every template writes
   `protectedPaths: factoryOwnPaths`, so a fix living in the list would only reach a repository
   somebody re-stamped.
2. **`factoryOwnPaths` stays what it says it is** — the specific files that decide how an agent is
   graded, and the list ticket 50's sandbox mask is built from. Widening *it* would have widened the
   **mask**, taking the artifacts directory and the run's own data out of the tree the agent works
   in. The two lines want different lists, and now they have them.
3. **The unlock still comes first.** A librarian granted `.kojo/workflows/*.ts` keeps it, because the
   `LimitedTo` test is above the bar. That ordering is load-bearing, and its existing test went green
   untouched.

**And the exception is Kojo's too.** `runOwnPaths` — `.kojo/artifacts/` and `.kojo/data/` — is
granted before anything the author wrote. It had to be: every stamped factory ships
`alwaysWritable: []`, so left to the author, barring the directory would have barred an agent from
recording its own work the same day. An agent that cannot record its work is one whose failure nobody
can read.

**Proven, and by which mutation.**

| mutation | what went red |
|---|---|
| drop the factory-directory bar — the state this ticket found | 6 unit tests **and** the run-level test |
| empty `runOwnPaths` | 4 unit tests, each about what an agent is meant to record |

The run-level test is the one worth having: a real `kojo run` against the stamped factory with a
scripted agent that writes `.kojo/evil.ts` on its way past. The run dies `PermissionBreach` naming
the path and the agent, **the file is gone from the worktree**, and the run never reaches its merge.
Detection alone would have left the repository holding the change while reporting a failure.

**Checks.** `bun tsc --build --force`, `bun biome check .`, `bun knip` clean. Unit **682**,
integration **275 passing** with three named skips, browser **96**. No agent call: the agent in that
run is a shell script.
