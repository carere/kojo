# 37 — A rebuilt sandbox must not come back with an unusable workspace

**What to build:** A run that suspends at a gate and resumes days later gets a sandbox it can
actually work in — or fails with a message that names the real problem. Today it can come back with
a workdir the container cannot resolve, and the run dies reporting OCI runtime internals.

Found by ticket 19 running a real lane on Docker, not by inspection. Sandcastle derives the worktree
path from the repo and the branch and `CreateSandboxOptions` cannot override it, so every
acquisition of one scope reuses the same host path. A rebuild after a gate therefore deletes that
directory and creates it again, and the Docker VM does not always follow — `docker run` succeeds,
the first `exec` dies with `chdir to cwd … no such file or directory`, exit 127.

Measured on a three-process lane: **3 of 4** failures under `$TMPDIR`, **1 of 6** under `/Users`,
**0 of 16** under `/private/tmp`. Ticket 19 anchored its own fixture at `/tmp` as a mitigation and
said plainly that this is not a cure. **The `/Users` number is the reason this ticket exists** — the
path a real factory runs on is not immune, and the rebuild-after-a-gate that trips it is the exact
mechanism architecture.md §4 is built on.

**Blocked by:** 19

**Status:** done

- [x] Acquiring a sandbox verifies the workspace is reachable from inside the container before any
      phase runs, rather than discovering it at the first `exec`
- [x] An unreachable workspace is recovered from — rebuild the sandbox — rather than surfaced as a
      phase failure, since nothing about the run is wrong
- [x] If recovery is impossible, the run fails with a message naming the workspace and the branch,
      never a raw OCI runtime error
- [x] The choice between probing-and-rebuilding and requesting a per-acquisition worktree path from
      upstream is recorded, with the reason
- [x] A test reproduces the fault deterministically rather than relying on a rate, so the fix is
      graded by something that fails without it
- [x] Ticket 19's `/tmp` fixture anchoring is revisited: kept with a reason, or removed as redundant
- [x] `architecture.md` §8 edge 11 is updated to record what was decided

## Comments

### What was built

`sandboxed` now runs one command — `pwd` — **inside the sandbox** before any phase does, and builds
another container when that command does not answer. Three containers, then it fails with
`WorkspaceUnreachable`.

- `src/contexts/sandbox/guards/workspaceIsReachable.ts` — `workspaceProbe` (the command) and the pure
  reading. A non-zero exit and a command that never ran are one fact; `Effect.result` hands both
  shapes to it.
- `src/contexts/sandbox/models/WorkspaceReach.ts` — the observation, in the same sense as
  `WorktreeState`. The difference between the two is which machine answers: host git for the tree,
  the sandbox itself for the workspace.
- `src/contexts/sandbox/models/WorkspaceUnreachable.ts` — the `Schema.TaggedError`. Its `summary`
  leads with the workspace and the branch, and carries the raw probe text after them.
- `src/contexts/workflow/services/sandboxed.ts` — `acquireOnce` probes, `acquire` rebuilds. Each
  attempt runs in a scope **forked** from the scope's own and is closed with a failure exit the
  moment it is discarded, so three containers are never two at once and each leaves its own trace row
  with its own cost.
- `docs/adr/sandbox/0001-probe-the-workspace-rather-than-ask-for-a-worktree-path.md` — the decision
  and the rejected alternative. `docs/design/architecture.md` §8 edge 11 records the outcome.

**No port change.** `AcquiredSandbox.exec` is already the one door every provider has, so the probe
is uniform and no adapter opts in. `pwd` is a shell builtin, so no image can be missing it.

**The probe runs before the worktree is read, and the order is load-bearing.** The probe finds the
recoverable fault; the worktree read finds the terminal ones. Reading the tree first is also wrong on
its own terms — when the workspace is gone, host git in that same directory fails too, so the run
dies naming `git rev-parse`.

### The deterministic reproduction

`hooks.host.onSandboxReady` is a host command Sandcastle runs **after** the sandbox is up and before
Kojo touches it — the exact window. `tests/integration/contexts/workflow/services/unreachableWorkspace.test.ts`
puts `rm -rf "$PWD"` there, optionally behind a sentinel file so it fires once (transient, recovered)
or every time (terminal, named). Real Sandcastle, a real worktree, a real branch, real git, the real
`SqliteTracer` on a real file. It is `no-sandbox`, where the operating system answers instead of a
VM's page cache.

**Why not Docker.** Measured on this machine, deleting the worktree under a live container and then
running one command:

| how | rate |
|---|---|
| `no-sandbox`, delete then exec | **8 of 8** fail |
| Docker, one exec first, then delete, then exec | 18 of 18 fail |
| Docker, delete before any exec | 1 of 8 fail |
| Docker, delete **and recreate**, then exec | 0 of 5 fail |

The window a Sandcastle hook gives is the third row. So a Docker version of this test would be
flaky about the very thing it pins. The Docker *wording* is pinned instead, as a string, in
`tests/unit/contexts/sandbox/guards/workspaceIsReachable.test.ts` — exit 127 and the OCI sentence,
copied from a real failure rather than written from memory.

Note the fourth row: delete-and-recreate, which is literally what a rebuild does, did **not**
reproduce here. Ticket 19's 1-in-6 under `/Users` was measured on a whole three-process lane, not on
this one operation, so the two numbers are not in contradiction — but it is one more reason the
reproduction is anchored on the state rather than on the cause.

### Proven, and by which test

- **A container whose workspace does not answer is thrown away and another is built, and the region
  then runs.** `unreachableWorkspace.test.ts` › "throws that container away and builds another one".
  Mutation: returning the first attempt unconditionally in `acquire` makes it fail with a
  `WorkspaceError` about `src/health.ts` — measured.
- **The same, under the engine, across a gate.** `tests/unit/.../sandboxed.test.ts` › "builds
  another container rather than failing the run" — two acquisitions in one execution, the run still
  suspends and then completes, and the phase inside ran once.
- **The discarded container leaves its own row, recorded `failed`.** `sandboxed.test.ts` › "leaves
  the discarded container its own row" and `unreachableWorkspace.test.ts` (read back out of the
  SQLite `sandboxes` table: `["failed", "released"]`).
- **Both acquisitions used the same host path.** `unreachableWorkspace.test.ts` asserts one distinct
  `worktree_path` across the two rows — edge 11's mechanism, asserted rather than described.
- **Recovery is bounded at three, and the failure names the workspace and the branch before it
  names anything else.** `sandboxed.test.ts` › "gives up after three" (including that the path
  appears in `summary` *before* the probe's raw text) and `unreachableWorkspace.test.ts` › "gives up
  after three containers".
- **The order of probe and worktree read.** Swapping the two makes `unreachableWorkspace.test.ts`
  fail with `SandboxError` instead of `WorkspaceUnreachable` — measured, both tests.
- **The two real failure strings are read as unreachable.** `workspaceIsReachable.test.ts`, five
  cases, no container.

### Argued, not proven

- **That a rebuild clears the macOS Docker VM's stale view in the wild.** No test grades it, for the
  reason in the table above. The argument is that ticket 19 measured the fault at 1 in 6 under
  `/Users` and never at 1 in 1, so three independent draws is worth something — and that a rebuild
  is what a run *should* do about an unusable workspace regardless of the odds.
- **`containerLimit = 3`.** A judgement about cost against odds, not a measurement.
- **One sighting, unconfirmed.** During a full integration run the Docker lane produced **5 sandbox
  rows for 4 executions** — an extra acquisition inside one execution of a run that then succeeded,
  which no path other than the probe's discard produces. The row's own `outcome` was not captured,
  so this is an inference from the count. Nine further Docker lane runs produced 4 for 4. The
  sighting is what changed `lane.test.ts`'s invariant (below); it is not offered as proof the fix
  fires under Docker.

### Repository changes worth knowing

- **`WorkspaceUnreachable` joins the error union of every workflow that opens a `sandboxed` scope.**
  Both scaffold templates carry it, so a stamped factory still compiles; so do the three durable
  harnesses and three unit suites.
- **`lane.test.ts`'s sandbox-count invariant is restated.** Ticket 19 wrote
  `sandboxes.length === executions.length`; a rebuild is an extra row *by design*, so the count is
  now asserted on the containers that carried an execution (`outcome !== "failed"`), with the run's
  own success as the reason a `failed` row there can only be a discarded container.
- **`InMemorySandboxSource` gained `Programmed.reachable`** and answers `workspaceProbe` by default —
  otherwise every existing unit test would have had to script `pwd` before it could open a sandbox.
- **Ticket 19's `/tmp` fixture anchoring: kept, for a different reason.** It is no longer a
  mitigation, because the fault is now recovered from. What it still buys is time: each occurrence
  costs a whole extra container build (~40 s), against a 180 s test timeout. Recorded at `fixtureRoot`.

No Moon task and no Vitest project were added. No shared root file was touched.

### Environmental note

Two agents ran integration tiers against **one Docker daemon** during this ticket. `lane.test.ts`
compares `docker ps --filter name=^sandcastle-` before and after, which cannot tolerate a second
agent's containers: three of my runs failed on a foreign container name, one at 218 s instead of 44 s.
The green run reported below was taken in a verified quiet window with the daemon cleaned first.
