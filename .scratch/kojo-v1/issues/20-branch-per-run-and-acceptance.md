# 20 — Branch per run and the acceptance-gated merge

**What to build:** Every run works on its own branch, and nothing lands unless the run is accepted — mechanically and by a human. A rejected run merges nothing and leaves everything intact for inspection.

**Blocked by:** 17, 09

**Status:** done

- [x] Each run names and owns a branch, and every commit an agent produces lands on it
- [x] Acceptance is the conjunction of the mechanical verdict and the human one, and it is the single condition the merge hangs on
- [x] Phases passing is not sufficient — a test phase that ran a red suite passed and the run is still not accepted
- [x] A rejected run merges nothing and leaves its branch and worktree intact
- [x] Agents propose and code disposes: an agent puts a commit message on its envelope, a phase performs the commit, and no agent runs the merge
- [x] Two processes against one run id are refused rather than raced

## Comments

### What was built

| Piece | Where |
|---|---|
| The branch a run owns | `src/contexts/shared/models/RunBranch.ts` — `runBranch(runId)` → `kojo/<run-id>` |
| The conjunction | `src/contexts/workflow/models/Acceptance.ts` — `Judgement`, `Acceptance.accepted`, `Acceptance.refusal` |
| Reading a verdict, and requiring acceptance | `src/contexts/workflow/services/acceptance.ts` |
| The commit phase (D6's disposing half) | `src/contexts/workflow/services/phase/commit.ts` → `Commit` / `CommitRefused` |
| The acceptance-gated merge | `src/contexts/workflow/services/phase/merge.ts` → `Landing` / `MergeRefused` |
| One runner per run id | `src/contexts/workflow/{ports/RunLock.ts, adapters/{InMemoryRunLock,FileRunLock}.ts, services/oneRunner.ts}`, `models/{RunClaim,RunLocked}.ts` |

Neither `commit` nor `merge` takes a branch. Both derive it from `CurrentRun`, so "a run owns one
branch" is a property of the engine rather than of the author remembering: `commit` reads HEAD and
refuses when the workspace is anywhere else, and `merge` lands that branch and no other.

`merge` takes an `Acceptance` and calls `requireAcceptance` **before the first git command**, which
is what makes "merged nothing" observable rather than argued — see below.

### Proved by test

Unit (`moon run kojo:test`, 253 tests, 38 files — 31 new):

- the truth table of the conjunction, including the row that matters: suite red + human approve is
  **not** accepted;
- `fromVerdict` accepts only the one word the reviewed loop calls approval (`approved`, `APPROVE`
  and `""` are all refusals);
- the commit phase's exact git command lines, its refusal off-branch **having run only one
  command**, its refusal of an empty commit, and a workspace failure staying a `WorkspaceError`;
- the merge phase running **no git at all** when either half refused, refusing a wrong or dirty
  target, and issuing `git merge --abort` before reporting a conflict;
- `oneRunner` refusing the second claim, refusing it *without waiting* (under `TestClock`, where a
  queue would still be pending), and releasing the claim on success, failure and interrupt alike.

The "no git at all" and "aborted the conflict" claims need evidence a result cannot carry, so
`tests/support/observedWorkspace.ts` (new) wraps `InMemoryWorkspace` and records every command line.

Integration (`moon run kojo:test-integration`, 97 passed + 1 pre-existing skip — 5 new), all on a
real repository with real worktrees, the durable engine on SQLite, and a real second process
(`tests/support/durableFactory.ts`, new — a whole factory driven from a command line):

- an accepted run: the agent's work is on `kojo/<run-id>` under the message it proposed, the trunk
  has not moved while the run is suspended, and after `approve` the trunk carries a `--no-ff` merge
  whose second parent **is** the run's branch, with the branch still there afterwards;
- the phase list is `build/agent, commit/code, test/code, merge/code` — exactly one agent phase, and
  it is the one that proposed;
- the commit is attributed to Kojo through `-c` on a repository configured as somebody else;
- **red suite + human approve**: every phase succeeded (`test` included — it ran the suite and
  reported it) and the run still failed `NotAccepted{the suite: 1 failing}`, with the trunk byte for
  byte where it was and the branch and its work intact;
- **green suite + human reject**: same, failing with the reviewer's own words;
- **contention**: a `hold` process takes the claim, and a second process asking for the same run id
  reports `refused` naming the holder, having started nothing — no branch, no trace row.

The two refusal tests were checked by mutation: replacing `requireAcceptance` with `Effect.void`
inside `merge` turns both red (`expected 'succeeded' to be 'failed'`), and nothing else in the suite
noticed. The tests grade the behaviour, not themselves.

### Argued, not proved

- **A `RunLock` is a new port, and the design record does not list it.** Edge 9 asks for a
  mechanism and does not say where it lives; a port with a file adapter and an in-memory one matches
  how every other seam in Kojo is built, and keeps the refusal testable in both tiers. It is not in
  architecture.md §5's table or typescript-effect.md §4 — deliberately not edited here, since those
  files are shared and this is a design addition somebody should approve rather than discover.
- **`FileRunLock` does not take over a stale claim.** A runner that was killed leaves its file, and
  every later process is refused by name until a human removes it. Automatic takeover needs a
  liveness test that only means something on the machine that wrote the claim, and getting it wrong
  puts back the race the port exists to remove. This is a decision, not an oversight — but nothing
  measures how annoying it is in practice yet.
- The `wx` flag's atomicity is the mechanism, and it is exercised **sequentially** (the holder has
  the claim before the second process starts). Two processes racing for one claim in the same
  millisecond is not tested; `O_CREAT | O_EXCL` is the kernel's guarantee rather than Kojo's.

### Measured, and worth knowing

- **A rejected run's worktree is removed, and its branch is not.** Asserted in the suite:
  Sandcastle's release calls `cleanupWorktree`, which removes a worktree it finds **clean** and
  preserves one that holds uncommitted changes (`chunk-VOG34SRF.js`, "Release: remove or preserve
  the worktree based on dirty state"); `CreateSandboxOptions` has no override. Since every commit of
  a run is on its branch, a clean worktree is exactly the case where the directory holds nothing the
  branch does not. So the inspection surface a rejected run leaves is **the branch** — which is what
  §4 calls the durable state — plus a preserved worktree in the one case where there would be
  something else to look at. The criterion is ticked on that reading; the literal directory is
  upstream's to keep, and Kojo cannot ask it to.
- A code phase writes no `errorTag`, so a `CommitRefused` or `MergeRefused` reaches the run's
  recorded exit and not the phase row. `commit.test.ts` pins that as it is today, with a comment, so
  it fails loudly when ticket 24 widens the row. **Nothing in `PhaseRecord` was touched.**
- The commit sha and the merge sha travel in the phases' success values (`Commit`, `Landing`), which
  the engine persists. D9 wants "commits produced" on the phase row; that is the trace schema's, and
  ticket 24 owns it.

### Not built, on purpose

`kojo run` was not touched: ticket 12 is editing `src/cli/` in parallel, and wiring `oneRunner` into
the CLI is one line at whichever entry point survives that ticket. The harness shows the shape —
`oneRunner(runId, start(definition, payload))`, with the run id from
`definition.executionId(payload)` so the claim is taken **before** anything is started.
