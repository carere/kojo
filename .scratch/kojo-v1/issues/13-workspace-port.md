# 13 — The workspace port and its adapters

**What to build:** Phases and checks act on the filesystem the agent actually touched, wherever it physically is. Without this, a check inspects the host while the agent wrote inside a container, and the factory grades a tree nobody changed.

**Blocked by:** 03

**Status:** done

- [x] One interface covers reading, writing, statting, deleting, running commands, and running git
- [x] The bind-mount adapter operates on a worktree on the host
- [x] The in-memory adapter is seeded from a plain object and used by every unit test
- [x] A non-zero exit code from a command is a value the adapter decides about, not an exception that escapes
- [x] The interface exposes whether a host path exists, because isolated environments have none
- [x] A check written against the port passes in memory and on a real worktree without modification

## Comments

**What landed.** `contexts/sandbox/ports/Workspace.ts` (the port), `models/{WorkspaceError,ExecResult,FileStat}.ts`, and
`adapters/{BindMountWorkspace,InMemoryWorkspace}.ts`. `git` is its own method, not
`exec(["git", …])`, because an isolated provider runs commands in the container while the branch
lives with whatever holds the repository — an adapter that must split them can.

**The honesty proof.** One check, `tests/support/treeIsHealthy.ts`, written against the port and
nothing else. The unit test runs it against a seeded object; the integration test runs it against a
real git worktree in a temporary directory, built through the port itself. Neither test touches a
character of the check, and both assert the same `healthy` literal exported beside it.

**Deviation — two tiers instead of one test.** The ticket asks for *a* test asserting the check
passes in memory and on a real worktree. AGENTS.md forbids a real adapter in a unit test and an
in-memory adapter in an integration test, so the assertion is split across the two tiers over one
shared check module rather than written as one test over two layers. This adds the integration
Vitest project and a `kojo:test-integration` moon task — the config comment left in phase 0 says
the integration project is added by the ticket that brings the first integration test.

**Deviation — a path guard the design did not ask for.** Both adapters refuse a path that leaves
the root (`../`, and an absolute path). Without it `read("../../.ssh/id_ed25519")` is a working
method call against a port that promises a bounded tree, and a check could pass in a test by
escaping a root a test does not have. Both adapters refuse the same set, which is what keeps that
true.

**Deviation — an unscripted command is an error in memory.** `InMemoryWorkspace` fails a command no
test scripted rather than returning exit 0. A test that forgot to say what `bun test` does must
find out from the test, not from a green check that never ran anything.

### API facts found by building

- `Context.Service` has **no `.layer` static**. The class is `ServiceClass`, carrying `new`, `key`
  and the `Service` shape only (`effect/src/Context.ts:123`). An adapter is
  `Layer.effect(Workspace, make(options))`.
- `ChildProcessSpawner` has **no combined "run and give me stdout, stderr and exit code"**. Its
  methods are `spawn`, `exitCode`, `string`, `lines`, `streamString`, `streamLines` — each
  collapses the result to one of the three. An `ExecResult` is assembled from `spawner.spawn`:
  drain `handle.stdout` and `handle.stderr` **concurrently**, then read `handle.exitCode`. Draining
  them in sequence deadlocks on any command that fills the pipe nobody is reading.
- `spawner.spawn` adds a `Scope` requirement, so the exec body needs `Effect.scoped`.
- `handle.exitCode` is `Brand.Branded<number, "ExitCode">` and drops into a `Schema.Finite` field
  without a cast.
- `@effect/platform-bun`'s `BunChildProcessSpawner` and `BunFileSystem` are one-line re-exports of
  the `@effect/platform-node-shared` implementations, so the integration tier runs under Vitest
  unchanged. `BunServices.layer` supplies spawner, filesystem, path, crypto, stdio and terminal in
  one layer.
- `FileSystem.stat` on a missing path fails with `PlatformError` whose `reason._tag` is `"NotFound"`
  — the eleven `SystemErrorTag` values are the whole vocabulary. `Effect.catchIf(isNotFound, …)`
  turns that into `Option.none`, which is what makes absence an answer rather than a fault.
- `File.Info.size` is `Brand.Branded<bigint>`, not a number: `Number(info.size)` before a
  `Schema.Finite` field.
- `File.Info.type` has **eight** members (`File`, `Directory`, `SymbolicLink`, `BlockDevice`,
  `CharacterDevice`, `FIFO`, `Socket`, `Unknown`).
- `Schema.Defect()` is the field schema for a carried cause, and it accepts `undefined` for the
  cases that have none.
- Biome's `lint/suspicious/useIterableCallbackReturn` fires on `Effect.map((x) => void mutate(x))`
  — `Effect.map` reads as an iterable callback to it. Use `Effect.flatMap(… Effect.sync(…))`.

### Checks

`bun tsc --build`, `bun biome check .` and `bun knip` are clean. Both Vitest projects pass
(24 tests, 5 files) when run directly.

`moon run kojo:test` could **not** be run in this worktree, and neither could `proto status`: proto
0.59.0 refuses with `proto::config::lockfile_already_exists` — "Unable to lock the directory
~/Projects/kojo as a lock file already exists in the child directory
~/Projects/kojo/.claude/worktrees/wf_05285e53-aa6-2". Two `.prototools` files nested inside one
directory tree (the repo root and the agent worktree beneath it) is the condition; it is not caused
by anything in this ticket, and `bun install` needed `PROTO_UNSTABLE_LOCKFILE=false` for the same
reason. The moon tasks are `vitest run --project unit` and `vitest run --project integration`, and
both were run directly.
