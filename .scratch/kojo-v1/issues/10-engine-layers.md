# 10 — Engine layers and the shared database client

**What to build:** Two ways to run a workflow: an in-memory engine for tests, and a single-node durable engine for real work that lets a suspended run survive the process exiting. Both sit on one database client that the trace will later share.

**Blocked by:** 08

**Status:** done

- [x] The in-memory engine runs a suspending workflow in-process; the durable engine survives a process restart
- [x] The durable engine runs single-node — no broker, no orchestrator, no container
- [x] The runner layer is constructed as a function call and its failure channel is handled rather than ignored
- [x] One database client is built once and provided to both the engine's storage and, later, the trace — never two clients on one file
- [x] The engine's tables and Kojo's tables coexist in one file, with Kojo's migration ledger explicitly named rather than inherited
- [x] A busy timeout is set and lock contention is retried, so two processes starting together is not a coin flip
- [x] Starting a run does not block the caller while the run is suspended

## Comments

### What landed

- `src/contexts/shared/adapters/SqliteDatabase.ts` — the one client. `layer({ path, busyTimeout? })`
  sets `PRAGMA busy_timeout` (default 5 s) as a layer above the driver's client, because the driver
  has no option for it. `retryOnLock` retries only a `LockTimeoutError`. `migrated(migrations)` runs
  Kojo's own migrations under `migrationsTable = "kojo_migrations"`.
- `src/contexts/workflow/adapters/InMemoryEngine.ts` — `WorkflowEngine.layerMemory` under a Kojo
  name, with what it loses written down.
- `src/contexts/workflow/adapters/SingleNodeEngine.ts` — `ClusterWorkflowEngine.layer` over
  `SingleRunner.layer()`, `Layer.orDie`'d, with `BunCrypto` provided and **`SqlClient` deliberately
  left in the requirement channel** so the trace can be handed the same client value.
- `src/contexts/workflow/adapters/InMemoryClusterEngine.ts` — the real cluster engine over
  `TestRunner.layer`: no SQL, no requirements, no error channel, and it exercises message envelopes
  and entity mailboxes that `layerMemory` does not implement.
- `src/contexts/workflow/services/run.ts` — `start` (always `{ discard: true }`) and `status`.

### Deviations

- **No trace tables.** The migrator machinery and the ledger name are here; the tables belong to the
  trace ticket. The coexistence test supplies its own one-line migration, so the assertion is real
  without claiming another ticket's territory.
- **`SingleNodeEngine` provides `Crypto` but not `SqlClient`.** Both are required by
  `SingleRunner.layer()`. Crypto has one right answer on Bun; the client is the shared one, and a
  layer that built its own would be the second `bun:sqlite` handle this ticket exists to prevent.
- **The durable fixture uses no Kojo port.** `tests/support/durableRun.ts` drives a bare
  `Workflow.make` with a `DurableDeferred`, not `workflow()` + `gate()`, so the integration tier
  touches no in-memory adapter. Kojo's `gate()` on the real cluster engine is covered in the unit
  tier instead, where in-memory adapters are correct.

### API findings

- **`it.effect` provides `TestClock`, and that silently deadlocks any test that waits on another
  process.** Three integration tests hung for the full 30 s vitest timeout before this was found: the
  poll loop's `Effect.sleep` was virtual and nothing ever advanced it. Every test here that spawns a
  process is `it.live`. This costs an hour if it is not written down.
- **Vitest workers run under Bun in this repo,** so `process.execPath` is the runner's own Bun binary
  and `bun:sqlite` imports fine in a test. The comment at the top of
  `tests/integration/.../BindMountWorkspace.test.ts` says workers run under Node; that is not what
  this setup does (verified by printing `process.execPath` from a worker).
- **A same-process busy-timeout test measures a deadlock, not a wait.** SQLite's busy handler *sleeps
  the calling thread*, so a second writer inside one process blocks the first from ever committing.
  Contention has to cross a process boundary. `tests/support/holdWriteLock.ts` is that boundary.
- **`DurableDeferred.tokenFromExecutionId(deferred, { workflow, executionId })`** builds a token from
  the run id alone, so an answering process needs nothing carried across the boundary but the id.
  The audit does not mention it and it removes a whole class of plumbing.
- **knip resolves `new URL("./literal.ts", import.meta.url)` but not a template literal.** A fixture
  script referenced through a `script(name)` helper is reported as an unused file; the same script
  referenced by a literal URL is not.
- **`bun add` did not write `packages/kojo/package.json`** because the repo's `prepare` hook fails in
  a worktree (see below). The dependency was added to the manifest by hand and the lockfile synced
  with `bun install --ignore-scripts`.

### Environmental blocker — proto refuses to run in a worktree

Every proto-shimmed tool (`bun`, `moon`, and anything with a `node_modules/.bin` shebang) exits with:

```
proto::config::lockfile_already_exists
  × Unable to lock the directory ~/Projects/kojo as a lock file already exists in the child
  │ directory ~/Projects/kojo/.claude/worktrees/wf_e3a1e321-aa9-3. Nested lock files are not
  │ supported. Instead, lock the parent directory.
```

The cause is `unstable-lockfile = true` in `.prototools` plus worktrees living **inside** the repo:
proto registers a lock for the worktree, then walks up and finds the parent repo is also a proto
workspace. `PROTO_CONFIG_MODE=local` and `PROTO_UNSTABLE_LOCKFILE=false` do not help.

**Nothing was changed to work around it.** Every check was run by invoking the real binary directly
(`~/.proto/tools/bun/1.3.14/bun ./node_modules/.bin/<tool>`), which is what the moon tasks run
anyway. `moon query tasks` and `moon run` could not be executed at all in this worktree — the task
list below was read from `packages/kojo/moon.yml`, `moon.yml` and `.moon/tasks/all.yml` instead.
