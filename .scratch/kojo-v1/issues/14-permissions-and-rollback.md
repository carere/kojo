# 14 — Permissions and post-hoc rollback

**What to build:** An agent that writes outside its allowed scope has those writes reverted and its phase killed. A tool allowlist cannot make this true — a shell can reach any path — so the tree is fingerprinted before and after and compared against the repo.

**Blocked by:** 04, 13

**Status:** done

> **Inherited from ticket 04.** `PermissionBreach` was deliberately not defined there, because its
> payload needs the rollback outcome type this ticket introduces. Define it here as a
> `Schema.TaggedError`, and keep it out of the correction loop's `catchTags` — the compiler
> refusing that handler is what makes D8 structural.


- [x] The glob matcher is table-driven against the upstream cases, and its wildcard provably does not cross a path separator
- [x] A stock glob library is proven to widen protected paths, with the case recorded as a test
- [x] The tree is fingerprinted before and after each agent call, and unauthorised changes are reverted
- [x] A breach is a distinct error that the correction loop structurally cannot handle — the compiler rejects a handler for it
- [x] The phase record carries the breached paths and the outcome of each rollback
- [ ] The roster and the workflow definitions are not mounted where an agent can reach them, so an agent cannot edit its own grader

## Comments

### What landed

- `src/contexts/workflow/guards/pathPattern.ts` — the matcher, ported from the upstream translation.
  `**` crosses `/`, `*` and `?` do not, a trailing `/` is a directory prefix, and a pattern with no
  wildcard is compared for equality. 22 table rows in the unit test.
- `src/contexts/workflow/guards/Permissions.ts` — `snapshot`, `changedPaths`, `permits`, `enforce`,
  and `withPermissions(policy, call)`, which fingerprints, calls, and enforces.
- `src/contexts/workflow/models/PermissionPolicy.ts` — `WriteScope` (`Unrestricted` | `LimitedTo`),
  `factoryOwnPaths`, and `describeScope`.
- `src/contexts/workflow/models/PermissionBreach.ts` — the `Schema.TaggedError`.
- `src/contexts/shared/models/PathRollback.ts` — `RollbackOutcome` and `PathRollback`. Placed in
  `shared` because the workflow context raises it and the trace context records it; putting it in
  `workflow` would have made `PhaseRecord` import from the context that depends on it.
- `PhaseRecord.breaches` — `Schema.optional(Schema.Array(PathRollback))`, appended so it does not
  disturb the existing constructor call in `code.ts`.
- `tests/support/fingerprintedTree.ts` — a `Workspace` double whose change-set moves, which the
  seeded in-memory adapter cannot do: the guard reads the same `git diff` twice and needs two
  answers.

No new Moon task and no new Vitest project. The unit tests land in the existing `unit` project, the
integration tests in the existing `integration` project.

### The last criterion is only half done, on purpose

Not mounting the roster and the workflows is a property of the sandbox, and the mount options belong
to tickets 16 and 17. What this ticket could honestly deliver is the policy half: `factoryOwnPaths`
names the roster, the workflows, the envelopes, the checks, the commands and the prompts, and an
unrestricted agent is barred from all of them. The comment on that constant records that rollback is
the second line of defence and that the cheaper protection is never mounting the paths at all
(architecture.md §8, edge 5). The mount itself is still to be built.

### API findings, and deviations from the design record

- **`Schema.TaggedUnion` is the right shape for `RollbackOutcome`.** It builds the discriminated
  union from a record of field sets and supplies `cases`, `guards` and `match`. Members are plain
  structs, so a value is an object literal — no constructor call.
- **The language service rejects `yield* Effect.fail(new X(...))`** inside a generator
  (`TS377019 effect(unnecessaryFailYieldableError)`): a `Schema.TaggedError` is yieldable, so it is
  `yield* new X(...)`. Two occurrences, both fixed.
- **The design record's `PermissionBreach` payload is right as written** — `agent`, `scope` as a
  string, and `paths` as path/outcome pairs. The pair struct is a `Schema.Class` here rather than an
  inline `Schema.Struct`, because the phase record carries the same type.
- **`git checkout HEAD -- <path>`, not `git checkout -- <path>`.** Upstream restores from the index,
  so a change the agent staged survives the rollback. A path the agent introduced was identical to
  `HEAD` before the call, so reading `HEAD` is both correct and strictly stronger. An integration
  test covers the staged case, and a second covers the file that is staged-new and therefore absent
  from `HEAD` — that one falls through to `git rm --force`.
- **A failed `git diff HEAD` is a `WorkspaceError`, not an empty answer.** Upstream swallows a
  non-zero git and returns `""`, which makes every path look unchanged — the guard would report all
  clear on exactly the repositories it cannot read.
- **`withPermissions` enforces on the failing path too.** An agent whose call errored may have
  written first. Interruption is the deliberate exception: `Effect.result` does not catch it, and a
  run interrupted at a gate is tearing its sandbox down anyway.
- **`Bun.Glob` is not the stock matcher that widens.** Measured: its `*` does not cross `/` on any of
  six probes. `node:path`'s `matchesGlob` does not cross either — but it matches nothing at all for a
  trailing-slash pattern, so `.kojo/workflows/` protects none of the workflows. That is the recorded
  stock-library case. The separator-crossing case is recorded against the naive `*` → `.*`
  translation, which is what `fnmatch` does and what a hand-rolled JS matcher produces.

### Environmental blocker

`bun`, `moon` and `node` are all proto shims, and every one of them refuses to run from this
worktree:

```
proto::config::lockfile_already_exists
Unable to lock the directory ~/Projects/kojo as a lock file already exists in the child
directory ~/Projects/kojo/.claude/worktrees/wf_30c8429a-442-3. Nested lock files are not
supported. Instead, lock the parent directory.
```

The cause is that the worktree sits **inside** the repository and carries its own tracked copy of
`.prototools`, which has `unstable-lockfile = true`. Proto reads the pair as nested lock-enabled
configs and refuses. `PROTO_CONFIG_MODE=local`, `PROTO_CONFIG_MODE=global` and
`PROTO_UNSTABLE_LOCKFILE=false` all fail the same way. `moon query tasks` cannot run at all.

Nothing was edited to work around it. Every check was run by calling the proto-installed binaries
directly (`~/.proto/tools/{bun,moon,node}/<version>/…`) with a `PATH` that resolves `node` to the
same raw binary, which is what the `#!/usr/bin/env node` shebangs need. `bun install` also needs
`--ignore-scripts`, because lefthook's postinstall calls proto; `effect-tsgo patch` was then run by
hand. This belongs to the integrator, not to this ticket.

### Checks run

Every task in `packages/kojo/moon.yml` plus the three inherited from `.moon/tasks/all.yml`, invoked
by their command rather than through `moon` for the reason above:

| Task | Command | Result |
|---|---|---|
| `tsc` | `bun tsc --build` | clean |
| `check` | `bun biome check .` | 58 files, no findings |
| `fix` | `bun biome check --write .` | no fixes left to apply |
| `test` | `vitest run --project unit` | 10 files, 76 tests passed |
| `test-integration` | `vitest run --project integration` | 2 files, 13 tests passed |
| — | `bun knip` | clean |

### 2026-08-13 — the open criterion has an owner now

The sixth criterion — *the roster and the workflow definitions are not mounted where an agent can
reach them* — was left to tickets 16 and 17 and **neither took it**. It is now ticket
[50](50-do-not-mount-the-factorys-own-paths.md), which also states the hard part: the sandbox
worktree is a git worktree and `.kojo/` is in the repository, so "do not mount" is a decision about
what the worktree contains rather than a mount flag. Nothing built here is weakened by that ticket —
rollback stays as the second line.
