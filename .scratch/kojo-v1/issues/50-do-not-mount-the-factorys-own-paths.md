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

**Status:** ready-for-agent

- [ ] An agent running in the reference sandbox cannot read `.kojo/commands.ts`, `.kojo/checks.ts`,
      `.kojo/envelopes.ts`, `.kojo/kojo.config.yaml`, `.kojo/workflows/` or `.kojo/prompts/` — proven
      by an agent that tries, not by reading the mount options
- [ ] The factory still works around the hole: the run's own commands, checks and envelopes are read
      by the **host**, which keeps them, and the code phases still run in the sandbox
- [ ] The branch the run lands still carries the factory's own files, unchanged, byte for byte. A
      merge that deletes `.kojo/` is a worse fault than the one this ticket fixes
- [ ] The run's data directory stays writable, so an agent can still record its work
      (`alwaysWritable`)
- [ ] `withPermissions` and `factoryOwnPaths` are unchanged and their tests still pass — this is a
      second line, not a replacement
- [ ] A workflow that runs an agent **on the host** (`--sandbox none`) says plainly, in the code and
      in the docs, that only rollback protects it
- [ ] `bun tsc --build`, `bun biome check .` and `bun knip` stay clean, and the integration tier is
      run against real Docker

## Comments

*(none yet)*
