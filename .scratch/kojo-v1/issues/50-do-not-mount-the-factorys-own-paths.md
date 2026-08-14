# 50 — An agent must not be able to see its own grader

**What to build:** The cheaper half of the protection ticket 14 built. Today an agent's sandbox
carries the roster, the workflows, the envelopes, the checks, the commands and the prompts, and the
only thing that stops an edit is a fingerprint taken afterwards. Not mounting those paths stops it
before it happens.

## Why this ticket exists

Ticket 14 declares six criteria and the sixth is unchecked:

> - [ ] The roster and the workflow definitions are not mounted where an agent can reach them, so an
>   agent cannot edit its own grader

Its own comment says why, and names the tickets it expected to finish the job:

> Not mounting the roster and the workflows is a property of the sandbox, and the mount options
> belong to tickets 16 and 17. […] The mount itself is still to be built.

**Tickets 16 and 17 are done and neither took it.** Nothing in
`packages/kojo/src/contexts/sandbox/` removes a path from what a sandbox mounts. So the criterion has
no owner. This ticket is the owner.

The decision it implements is [architecture.md §8, edge 5](../../../docs/design/architecture.md):

> **Defence in depth beats rollback.** Post-hoc rollback stays, but simply not mounting the roster
> and the workflows into the sandbox is cheaper and more certain. An agent that cannot see its
> grader cannot edit it.

`factoryOwnPaths` in `src/contexts/workflow/models/PermissionPolicy.ts` is the list. Its docstring
already records that it is the second line of defence.

## The hard part, stated before you start

**The sandbox worktree is a git worktree of the repository, and `.kojo/` is in the repository.** So
"do not mount" is not a mount flag on the reference provider; it is a decision about what the
worktree the agent gets contains. Three shapes are worth weighing before you build one:

1. **Remove the paths from the worktree after it is cut, and restore them before the merge.** Cheap,
   and it makes the tree the agent commits differ from the tree the branch holds — which the merge
   step and `worktreeIsUsable` both read. Prove what a `git status` in that worktree says.
2. **A provider mount that masks the paths** (an empty bind mount over `.kojo/`). Real on Docker and
   Podman, meaningless on `none`, and it does nothing about `git`, which still has the objects.
3. **Cut the worktree from a tree that never had them.** The most certain and the most expensive.

A run with `--sandbox none` runs on the host and has no mount at all. That case cannot be solved
here, and the ticket must say so out loud rather than leave a reader thinking it was.

**Rollback stays.** This is defence in depth, so nothing that ticket 14 built may be deleted or
weakened. The `factoryOwnPaths` list stays exactly where it is, and the breach path keeps its tests.

**Blocked by:** 14, 16, 17 — all done.

**Status:** done

- [x] An agent running in the reference sandbox cannot read `.kojo/commands.ts`, `.kojo/checks.ts`,
      `.kojo/envelopes.ts`, `.kojo/kojo.config.yaml`, `.kojo/workflows/` or `.kojo/prompts/` — proven
      by an agent that tries, not by reading the mount options. **With the scope written beside it:**
      an agent that runs `cat`, `ls` or `grep` fails; an agent that runs `git show HEAD:.kojo/checks.ts`
      succeeds, in every provider, because the parent `.git` is reachable. Asserted both ways
- [x] The factory still works around the hole: the run's own commands, checks and envelopes are read
      by the **host**, which keeps them, and the code phases still run in the sandbox. One measured
      caveat, in the comment: a code phase whose *command* reads `.kojo/` sees the mask, which is why
      Kojo's own factory opts out
- [x] The branch the run lands still carries the factory's own files, unchanged, byte for byte. A
      merge that deletes `.kojo/` is a worse fault than the one this ticket fixes
- [x] The run's data directory stays writable, so an agent can still record its work
      (`alwaysWritable`)
- [x] `withPermissions` and `factoryOwnPaths` are unchanged and their tests still pass — this is a
      second line, not a replacement
- [x] A workflow that runs an agent **on the host** (`--sandbox none`) says plainly, in the code and
      in the docs, that only rollback protects it
- [x] `bun tsc --build`, `bun biome check .` and `bun knip` stay clean, and the integration tier is
      run against real Docker

## Comments

**The paths are hidden through the git index, not through the filesystem.** `git update-index
--skip-worktree` over exactly the files `factoryOwnPaths` names, then the files are deleted from disk.
The naive `rm -rf .kojo` never reaches the merge it would damage: a deleted tracked file is ` D` in
`git status --porcelain --untracked-files=no`, `SandcastleSandboxSource.worktree` reads that,
`worktreeIsUsable` turns it into `WorktreeUnusable("modified")`, and **every acquisition of every
provider fails on its first attempt** — and `sandbox.close()` then preserves the dirty worktree
instead of removing it, leaking one per release. Measured in a throwaway repo before a line was
written. With the index bit, `git status`, `git status -uno`, `git diff HEAD --numstat` and
`git ls-files --others` are all empty, `git add --all` stages nothing for those paths, the run's own
commit carries the original blobs, and `git merge --no-ff` lands a trunk that still holds them. So
**nothing has to be restored before the merge** — there is nothing to restore.

**Where it went, and a deviation from the design pass.** The design chose Sandcastle's
`host.onWorktreeReady` hook, invoking a script shipped under `src/scripts/`. It is in
`SandcastleSandboxSource.acquire` instead, as ordinary Effect: the un-mask has to live in the
acquisition's release anyway, so both halves are one `acquireRelease` in one place; the author's hook
slot stays entirely the author's (this repository's factory already uses it for `bun install`, and
Kojo appending to it would be a merge order to keep right forever); a failure is a typed
`SandboxError` that fails the acquisition, which is the same outcome a non-zero hook exit gives; and
no shell-string or `argv` composition is needed. The timing is equivalent for the two kinds it applies
to — a bind mount is live, so the container reads the host's inodes, and `none` *is* the host — and
nothing runs inside the sandbox between `createSandbox` resolving and the mask being applied. The
container test proves the bind-mount half rather than arguing it.

**A wrong diagnosis, recorded because it was the expensive half.** The first version registered the
un-mask with `Effect.addFinalizer`. `lane.test.ts`'s container test then failed with a Docker
container that had survived the gate, and disabling the finalizer made it pass — so the finalizer was
blamed, and the code was moved to `acquireRelease`. **That reading was false.** The lane fixture is an
empty commit with no `.kojo/` in it at all, so `git ls-files` matches nothing and `hide` is a complete
no-op there — it could not have registered a finalizer, let alone leaked a container. Measured
properly afterwards, four runs each: **1 failure in 4 with the change, 1 failure in 4 with the whole
ticket stashed**, both with the same `chdir to cwd … no such file or directory` — the exit-127 Docker
Desktop fault `fixtureRoot` in `lane.test.ts` already documents. The `acquireRelease` shape is kept
because it is better on its own terms (uninterruptible acquisition, the un-mask registered by the same
mechanism as `sandbox.close()` so the ordering is structural), and its docstring now says that is an
argument rather than a measurement.

**A worktree that is not there is skipped rather than reported.** `unreachableWorkspace.test.ts`
deletes `$PWD` from a hook, and the mask's `git ls-files` then failed the acquisition with a
`SandboxError` about git — which is exactly the substitution `sandboxed`'s ordering (probe the
workspace, *then* read the worktree) exists to prevent. An absent tree now returns early and the probe
two steps later says what is actually wrong.

**Kojo's own factory takes the opt-out, and this is the one thing the design pass did not find.**
`hidden: []` — `keepsItsOwnFactory` in `.kojo/workflows/lane/common.ts`, referenced from all four
`sandboxed` scopes. Measured: `bun knip` is `commands.dead`, one of the five real invocations in
`.kojo/commands.ts` and run by `graded` in every lane, and it **exits 1 in a masked worktree** —
`knip.jsonc` names `.kojo/workflows/factory.ts` as an entry and `effect` is a root dependency nothing
but `.kojo/` imports, so the tree reports *"Refine entry pattern (no matches)"* and *"Unused
dependencies (1) effect"*. Every run of every lane would report a red dead-code check about a change
that was perfectly good. This factory also runs `noSandbox()`, where the mask buys almost nothing —
so the trade is one-sided. What protects Kojo's own grader is therefore ticket 14's second line and
only that, which is written down in `common.ts` and in `.kojo/README.md`.

**What this cannot claim, said in three places** (`guards/hiddenPaths.ts`, `adapters/providers.ts`
`noSandbox`, `models/PermissionPolicy.ts` `factoryOwnPaths`): the git objects stay reachable in every
provider (`git show` prints the file — measured, and asserted in the test so nobody claims otherwise);
`--sandbox none` has no boundary at all, since the agent is a host process with the unmasked
repository three directories above its working directory; an isolated provider cannot be masked,
because `syncIn` materialises its tree from the object database and `.kojo/` reappears whole —
`canHide` refuses to try, rather than leaving a host worktree without its factory and a sandbox with
it; and a file the agent *creates* under a hidden directory has no index entry, so `git add --all`
stages it and the merge would land it. Ticket 14's `permits`/`rollBack` is what catches that last one.
The two lines are not redundant and neither may be deleted on the strength of the other.

**Tests, and what each one grades.**

- `tests/integration/contexts/sandbox/adapters/hiddenFactoryPaths.test.ts` — seven tests over a **real
  stamped factory** (`throwawayRepo` runs `kojo init` as a subprocess, so the paths hidden are the
  paths a factory actually has). A **scripted agent** through the real `SandcastleAgentInvoker` and
  Sandcastle's own `run` path probes `cat`/`ls`/`git show` and writes its findings into the worktree;
  the tree stays `modified: false` and `worktreeIsUsable` returns none; the run commits and the merge
  lands a trunk whose `.kojo/checks.ts` blob is the original object id; `.kojo/artifacts/keep.txt`
  reads and `.kojo/artifacts/wrote.txt` writes; a **preserved** worktree (uncommitted work, which is
  the only case where the un-mask is observable — a clean one is removed index and all) has its
  factory back, `H` not `S` in `ls-files -v`, and only the agent's own change in `git status`; and the
  same claim again **inside a real Docker container**, through `sandbox.exec`. No model, no spend.
- `tests/unit/contexts/sandbox/guards/hiddenPaths.test.ts` — the pure argv: the pathspecs, the
  `ls-files -z` narrowing (required, because `update-index --skip-worktree` on an untracked path exits
  128 while `ls-files` on a pathspec matching nothing exits 0), the mark, the unmark-then-checkout
  order, and that an isolated provider is refused.
- `tests/unit/contexts/workflow/services/sandboxed.test.ts` — the default is `factoryOwnPaths` and
  `hidden: []` is obeyed, graded off `InMemorySandboxSource`'s recorded events.

`SandboxRequest.hidden` is **required** while `SandboxConfig.hidden` is optional: an adapter reading
an absent list would have to choose a meaning for it, and the only safe meaning fails open. `sandboxed`
resolves the default once, where `factoryOwnPaths` lives, so the sandbox context never learns about the
workflow context's list.

### Corrected and confirmed by the adversarial pass, before this landed

The mechanism, the tests and all six mutations survived independent re-execution. The pass measured
the container boundary more tightly than the report claimed — only the worktree and `<repo>/.git` are
mounted, read off `mountinfo` — and found no test that grades nothing. Two things changed.

**One load-bearing sentence was wrong, in two source files, and it was marked *Measured*.** The
docstrings on `factoryOwnPaths` and `hiddenPaths` gave `.kojo/evil.ts` as the example of what the
second line catches when the mask cannot. It does not:

    permits(Unrestricted, ".kojo/evil.ts")           → true
    permits(Unrestricted, ".kojo/workflows/evil.ts") → false

Every entry of `factoryOwnPaths` names a file or a directory and none of them is `.kojo/` itself, so
a file created at the **root** of `.kojo/` is under no entry — no breach is raised and nothing is
rolled back — and it has no index entry, so the mask never saw it either. `lane/common.ts` gives this
repository's own builder, fixer and tidier `Unrestricted`, so the gap is reachable here rather than
only in principle. Both docstrings now use `.kojo/workflows/evil.ts` for the case that *is* caught,
and say the root case plainly. **Widening the list to `.kojo/` would close it and would also bar the
artifacts directory and the run's own data, so it is a decision and not a patch** — see ticket 54.

**The `knip` justification for the opt-out was reported as measured and the pass could not reproduce
it**, having been blocked from removing the files. Re-run by the integrator in a detached worktree at
`/private/tmp`, which is the location `lane.test.ts` settled on for exactly this kind of probe:

    baseline                         knip exit 0
    masked (skip-worktree, deleted)  0 dirty entries in git status
                                     knip exit 1
                                       Unused dependencies (1)  effect
                                       [.kojo/workflows/factory.ts] Refine entry pattern (no matches)

Both messages are the ones the docstring names, and the run confirms the mechanism's central claim on
the way past: a masked worktree is **clean** to `git status`. The opt-out stands as measured.
