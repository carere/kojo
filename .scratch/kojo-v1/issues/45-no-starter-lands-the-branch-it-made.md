# 45 — Nothing merges, because no starter merges

**What to build:** A stamped starter that is approved lands its branch. Today the loop stops one
step short of the thing the whole design is for.

Walked after ticket 30: the `review` starter runs its agent, commits, verifies, suspends at its
gate, is answered from the browser, is applied by a watcher, and **succeeds** — and then
`git branch` shows the work on `kojo/review/add-a-licence-header` with a real commit and **`main`
untouched**. `phase/merge.ts` exists and is unit-tested, but **neither stamped starter imports it**.
The `review` workflow ends at `requireAcceptance`.

Architecture.md D7 says acceptance is the single condition the merge hangs on, and D6 says code
performs the merge an agent proposed. Both are built. Nothing an author gets stamped uses them.

**Blocked by:** 20, 22

**Status:** done

- [x] An approved starter merges its branch to the target, and the merge is a code phase using the
      workspace's git — never an agent, per D6
- [x] A rejected or unaccepted run merges nothing and leaves its branch and worktree intact
- [x] The whole loop is asserted end to end: stamp, run, suspend, answer, apply, **merge** — the
      walk-through this ticket came from, as a test
- [x] The stamped README's description of what happens after approval is true

## Comments

### The branch a starter cut was a branch nothing could find

`merge` and `commit` both act on `runBranch(runId)` and refuse any other branch by name;
`RunFailure.branch` prints the same string as "the branch this failed run leaves behind". Both
starters named their branch `kojo/<workflow>/<slug of the payload>` instead. So the readable name
was not merely cosmetic — it was a branch those three could not find, and a failed stamped run
already reported a branch that did not exist. Both starters now derive the branch from `CurrentRun`
with `runBranch`, which is what `RunBranch.ts` says the name has to be: a function of the run and of
nothing else, so a resumed run in another process derives it again without carrying it.

`stampedRun.test.ts` asserted the old name; it now asserts `kojo/<run id>` read off the run the
command printed.

### The merge, and where it sits

Both starters end with `merge({ into: trunk, acceptance })`, **outside** the `sandboxed` scope. The
scope body now returns what the acceptance is made of rather than checking it itself, so the
explicit `requireAcceptance` is gone from both: `merge` performs it, which is D7 with exactly one
place that can fail it. `trunk` is a constant at the top of the stamped file, `"main"`, with a
comment saying what to change and what a wrong answer looks like (a `MergeRefused` naming both
branches, not a merge somewhere unexpected).

### Two things the merge needed that nothing provided

Both were found by running the thing, not by the suite, and neither is in the ticket text.

1. **`cli/factory.ts` provided no `Workspace`.** Outside a sandbox scope there was no workspace at
   all, so a stamped workflow that merged would die with `Service not found` *after* the agent had
   been paid for and the human had answered. It now provides `BindMountWorkspace` on the process's
   own directory; `sandboxed` shadows it inside the scope, so the boundary of D2 — setup on the
   host, risk inside, merge on the host — is drawn by one layer stack.

2. **`.sandcastle/` made every first merge refuse.** Sandcastle writes its logs and its worktrees
   into `.sandcastle/` in the repository the run was started from, and `merge` refuses a trunk that
   has untracked files in it. So the walk-through reached the merge and stopped with
   `MergeRefused: main holds uncommitted changes` — nothing to do with the user. `SandcastleSandboxSource`
   now writes `.sandcastle/.gitignore` holding `*` before it acquires: the directory ignores itself,
   no edit to the repository's own `.gitignore` is needed, and `git status` is clean again.
   Deleting that write turns `landsOnTrunk.test.ts` red with that exact message — measured.

### What "worktree intact" really is

The criterion says a rejected run leaves its branch and worktree intact. **The branch does; the
worktree does not, and that is Sandcastle's behaviour rather than a choice made here.** Its `close()`
preserves a worktree only when it is *dirty*; a run whose work is committed — which is every run
that reaches a gate, by design — leaves a clean worktree and Sandcastle removes it. The branch is
what survives, which is what architecture.md §4 says the durable state is, and
`git worktree add <path> <branch>` restores the tree from it. The test asserts the branch, its
commit, and the file's content on that branch.

### What grades what

- **`tests/integration/cli/landsOnTrunk.test.ts`** — the whole loop, and it is the only test here
  that grades the thing itself. It stamps a factory into a fresh repository, replaces `commands.ts`
  the way the README tells a person to, runs `kojo run review` with a **shell script named `claude`**
  on the child's `PATH` (a real provider path: `buildPrintCommand`, prompt on stdin, `parseStreamJsonLine`
  reading its two lines — no model, no money), watches it suspend, answers the gate from a second
  process, and then asserts on **`main`**: the agent's commit is on it, the merge commit is on it,
  and `git show main:LICENCE-HEADER.md` is the file the agent wrote. The second test rejects and
  asserts the trunk is the commit it was, the file is not on it, and the branch still holds the work.
- `tests/integration/contexts/scaffold/services/stampedFactory.test.ts` — runs `tsc` over both
  stamped trees against the real engine. It is what proves the new imports and the new shape are a
  program, and it is a **stand-in** for landing: it never runs anything.
- `tests/unit/contexts/workflow/services/phase/merge.test.ts` — pre-existing, unchanged. It grades
  `merge` against a scripted workspace, not a starter.

### The suite is not the evidence

Walked by hand in a throwaway repository, three times, `--sandbox none`, with a scripted `claude`:

    === kojo run review "add a licence header"
    draft   review  agent  ok  417ms
    commit  review  code   ok   53ms
    verify  review  code   ok   12ms
    suspended at gate "approve" — waiting on engineer, 1d 23h left

    === kojo gate answer <token> --choice approve --as kevin
    recorded approve on run 2ad4bd2f7c91845589daa8db86a92b2e, attributed to kevin
    run succeeded
    merge  code  ok  70ms  Land the accepted branch on main

    === git log main
    d0a609a Merge branch 'kojo/2ad4bd2f7c91845589daa8db86a92b2e'
    73639f6 add a licence header
    9ca5570 stamp a factory

And rejected, in a fresh repository:

    recorded reject on run 2ad4bd2f7c91845589daa8db86a92b2e, attributed to kevin
    run failed
    merge  code  FAIL  0ms  Land the accepted branch on main
    run 2ad4bd2f7c91845589daa8db86a92b2e failed — NotAccepted
      reason: kevin: not this week
    === git log main
    69dca3e stamp a factory
    === branches after
    kojo/2ad4bd2f7c91845589daa8db86a92b2e
    main

`0ms`, and before any git command: the refusal happens on the acceptance, which is what makes
"merges nothing" true rather than "merged and then unpicked".

### Checks

`bun tsc --build --force --verbose` (names 3 projects), `bun biome check .`, `bun knip`, and every
moon task except `console:dev`, all green. Unit 526. Browser 85. Integration 225 passed, 3 skipped,
**three consecutive green runs**.

Four earlier integration runs failed on one assertion in
`contexts/workflow/services/lane.test.ts` — `expect(sandcastleContainers()).toEqual(before)` — in
both directions (a container appearing, and a container in `before` disappearing). It is a race with
**other worktrees sharing one Docker daemon**: sibling agents were running their own integration
tier at the same time, which `ps` confirmed. The test's own comment expects a concurrent container to
"cancel out", and that only holds for a container that is *stable* for the length of the test. Not
caused by anything in this ticket: with `ignoreOwnScratch` disabled it still failed, and with
`landsOnTrunk.test.ts` removed it still failed, while three runs on a quiet daemon with everything in
place are green.

### One accident worth recording

`git stash` shares one stack across every worktree of a repository. A `git stash pop` here restored
**another worktree's** work into this one. It was pushed straight back onto the stack, its owner
took it, and nothing was lost — but no agent working in a shared-repository worktree should use
`git stash` at all.
