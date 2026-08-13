# 19 — A lane with a mid-lane gate

**What to build:** The phase-4 payoff: a complete lane that runs agents inside a sandbox, stops mid-lane for a human, tears the container down while it waits, and rebuilds correctly when the answer arrives.

**Blocked by:** 17, 09, 11

**Status:** done

> **Carried forward from wave 5 — what tickets 11 and 17 could NOT prove.** These are the reason
> this ticket exists; treat each as an acceptance criterion in its own right.
>
> - **Rebuild across a process restart.** Every rebuild so far is one process on the in-memory
>   engine. Needs the two-process harness in `tests/support/durableRun.ts`.
> - **A real container.** Only `noSandbox()` runs end to end. Real Docker or bind-mount, and the
>   isolated → `SandboxExecWorkspace` branch, are both untested.
> - **`KOJO_*` override on an agent invocation is harder than ticket 17 assumed.** Sandcastle's
>   `mergeProviderEnv` **throws** on overlapping keys — *"Overlapping env keys between agent
>   provider and sandbox provider"*. So an agent provider cannot override the correlation keys that
>   `sandboxed` already stamped on the sandbox provider. Override must go through `RunOptions.env`,
>   which is spread last. Getting this wrong throws at run start, not at build time.
> - **`behind-origin` against a real `origin`.** Proven only against a fake.
> - **`requireCommitted: true` as the right default.** No real lane has run under it.
> - **`SandboxId` uniqueness.** Built from `runId/name/acquiredAt`, so two acquisitions inside one
>   millisecond collide. Weakly guarded today by an assertion that two ids differ; structurally
>   unclosed until a trace read-back exists.


- [x] The lane suspends inside its sandbox and the container is released
- [x] Resuming rebuilds the sandbox from the branch, and the agent's session resumes with it
- [x] Completed phases do not re-run; the replay reaches the gate in milliseconds
- [x] A rejected verdict revises and asks again, and each asking genuinely suspends
- [x] The rebuild appears as its own sandbox record with its own cost
- [x] The lane is independently runnable, not only reachable through a parent workflow

## Comments

The lane is `tests/support/durableLane.ts` — a real workflow, not a stand-in: a `sandboxed` scope
around a `code` phase that commits to the branch, an `agent` phase that runs a process **inside the
container**, a `reviewed` loop, and a second `code` phase that reads back what the first one
committed. It is driven from a command line (`start`, `answer`) so a test can start a run in one
process, let that process exit, and finish it in two more. Nothing under it is in-memory: the engine
is `SingleNodeEngine` on a SQLite file, the sandbox source is `SandcastleSandboxSource`, the gate is
`TerminalGate`, and the trace is a JSONL file all three processes append to
(`tests/support/JsonlTracer.ts`, written because `SqliteTracer` is ticket 24 and a trace held in
arrays cannot answer a question about three processes).

`tests/integration/contexts/workflow/services/lane.test.ts` is the acceptance test. Eight tests,
three of which run the whole three-process lane. Measured on this machine: `no-sandbox` ≈ 1.7 s per
lane, real Docker ≈ 43 s.

### The six carried-forward properties

1. **Rebuild across a real process restart — proven.** Three `spawnSync`ed Bun processes on one
   database. Process one suspends at the gate; process two rejects, the lane revises and asks again;
   process three approves and the run succeeds. The trace holds one row per phase (`prepare`,
   `scout`, `revise`, `land`) after **four** executions of the body.
2. **A real container — proven.** `tests/support/dockerImage.ts` builds `kojo-test:sandbox` from
   four lines of Dockerfile (Sandcastle refuses to start without a local image). The whole lane runs
   on it, and `docker ps --all --filter name=^sandcastle-` is compared before and after each
   process: **the daemon holds no container while the run waits.** The isolated →
   `SandboxExecWorkspace` branch is closed by a separate test that enters a real `sandboxed` scope on
   an isolated provider and asserts `workspace.hostPath` is `None` — the choice `sandboxed` makes,
   which had never been exercised, as opposed to the adapter, which had.
3. **`KOJO_*` correlation and the `mergeProviderEnv` trap — proven, and the ticket's framing was
   wrong in a third place.** `tests/integration/.../providerEnvironment.test.ts` runs all three
   cases against Sandcastle 0.12.0. (a) On `createWorktree`/`worktree.run` an agent provider that
   sets a key the sandbox provider already set **does** throw at run start, with exactly the sentence
   quoted above. (b) On that path `RunOptions.env` **does** win, read back out of the agent's own
   process. (c) **Kojo uses neither path.** `boundary.ts` calls `createSandbox`, and both
   `createSandbox` and `createSandboxFromWorktree` hard-code `agentProviderEnv: {}` — so an agent
   provider's `env` never reaches the merge: it does not throw and it does not win, it is dropped
   silently. `SandboxRunOptions` has no `env` either. The only per-invocation door that exists is an
   `env NAME=value` prefix on the command line at exec time; `InSandboxAgentInvoker` uses it, and the
   lane test asserts both readings — attempt `0` (the acquisition's) without the stamp and `1` (the
   phase's) with it. The correlation itself is read back **from inside the container** and carried
   home in the envelope the lane decodes.
4. **`behind-origin` against a real `origin` — proven.** A bare repository, the branch pushed to it,
   the run's first acquisition released, a commit landed on `origin/<branch>` while nothing was
   looking, and the rebuild refused with `WorktreeUnusable{fault: "behind-origin"}` and `behind: 1`.
   A clean tree with a real remote reads `tracked: true, behind: 0, ahead: 0` and passes, and
   `{ requireUpToDate: false }` lets a declaring author through.
5. **`requireCommitted: true` — the guard is proven, the path is not driven.** Two tests call
   `worktreeIsUsable` directly and prove the guard, and a real lane runs green under the full default
   policy (`durableLane.ts` passes no `worktree` option, so all three checks are on). What no test
   does is drive the guard **firing inside `sandboxed`** end to end, because Sandcastle cuts a fresh
   worktree per acquisition and a lane can only dirty a tree within one acquisition. The failure the
   guard prevents is proven, and is worse than "state the branch does not carry": Sandcastle
   **preserves a dirty worktree on close**, so the next acquisition hits `git worktree add` refusing a
   branch that is already checked out — the rebuild does not happen at all, and the message is about
   git rather than about the run. The guard turns that into a named fault at the moment the dirt
   appears.
6. **`SandboxId` uniqueness — closed structurally, and prophylactically.** `makeSandboxId` now takes
   a per-process monotonic `sequence` beside the clock: `runId/name/<acquiredAt>-<sequence>`, still
   three slash-separated parts so `KOJO_PHASE_ID` parses one shape. Within a process ids cannot
   collide however fast the acquisitions come; across processes a collision now needs the clock
   **and** the sequence to agree, which is never likelier than the clock alone.

   **Correction.** An earlier version of this section claimed the collision was reachable, on the
   grounds that the `misplaced` unit test acquires one scope eleven times "under a frozen test clock"
   and would have failed under the old scheme. That is wrong, and was checked: `retryOnInterrupt`'s
   schedule advances virtual time between attempts, so the eleven ids are distinct under the
   clock-only scheme too. Reverting `makeSandboxId` fails `SandboxId.test.ts` and nothing else. The
   collision remains reachable-in-principle and unobserved, exactly as ticket 17 said. The change is
   kept because it costs one integer and removes the question, not because a run hit it.

### What is proven versus what is argued

Proven by test: everything above that is labelled proven — 1 through 4, and the guard half of 5 —
plus one sandbox row per **execution of the body** (asserted as an
invariant rather than a count, so a container held across a suspension and a container silently
reused both break it), distinct ids and distinct `KOJO_PHASE_ID` per acquisition, outcomes
`interrupted…interrupted, released`, and the agent session resuming across both the process restart
and the container rebuild — witnessed by the transcript the agent process appends to on the host,
outside the engine's knowledge, which holds exactly two turns.

Not proven, and named: the agent is a shell command rather than a model, because the real
Sandcastle-backed `AgentInvoker` is ticket 15. What that leaves untested is the invoker itself — the
stream parsing, session capture through `AgentSessionStorage`, and cost accounting. What it does
test is the seam ticket 19 owns: an agent invocation happens through `Sandbox.exec` inside the real
container, sees the correlation there, and can override it only through the door that exists.

### Two engine behaviours worth knowing downstream

- **A rejected asking costs two executions, not one.** After the retried gate suspends, the engine
  replays the body once more immediately. On Docker that is a whole extra container build. Nothing
  re-runs a phase, so it is a cost rather than a bug, but a lane with three rejections pays for six
  rebuilds and the sandbox rows will show it.
- **`poll` cannot tell one suspension from the next.** A run that suspends, resumes and suspends
  again reads `suspended` on both sides, and answers `None` (reading as `running`) while the body is
  mid-replay. The harness waits on the trace's execution list instead — one entry per execution of
  the body, appended by `runFinished`. Anything that drives a run from outside will need the same.

### Repository changes

`packages/kojo/vitest.config.ts` sets `fileParallelism: false` on the integration project. These
tests spawn whole processes and share one Docker daemon, so parallel files compete for the resources
they are measuring. It is kept for that reason alone. It does **not** address the exit-127 fault
below; an earlier version of this section said it did, and that measurement did not reproduce.

### The exit-127 rebuild fault — diagnosed, mitigated, still open

The container lane failed about two runs in five, always in the same place: the first `docker exec`
of the `revise` phase, in the process that answers the first gate.

```
AgentInvocationError{ fault: "provider-failed", reason: "the agent exited 127 · stdout:
  OCI runtime exec failed: … chdir to cwd (\"/home/agent/workspace\") … no such file or directory" }
```

**What it is.** The workdir is the bind-mounted host worktree. Sandcastle derives that path from the
repo and the branch — `CreateSandboxOptions` has no override — so every acquisition of one scope
reuses the **same host path**, and a rebuild after a gate therefore deletes that directory and
creates it again. On macOS the Docker Desktop VM does not always follow: `docker run` succeeds and
the first `docker exec` cannot resolve the workdir. `docker events` shows the container reaching
`start` and then never producing an `exec_die` — the process never began. Container lifetimes never
overlap, so the earlier "parallel files compete" theory is refuted.

**Mitigation.** `lane.test.ts` now anchors its fixture at `/tmp` (`fixtureRoot`) instead of
`os.tmpdir()`. Measured, three-process docker lanes through the moon task: **3 of 4 failed** under
`$TMPDIR` (`/var/folders/…`), **1 of 6** under `/Users`, **0 of 16** under `/private/tmp`.

**Still open, and it is a product question rather than a test one.** The `/Users` failure is the
important number: the path Kojo will actually run on is not immune, and the rebuild-after-a-gate that
trips it is the mechanism this ticket exists to prove. A real run whose two-day gate resumes into a
container with an unusable workdir fails with a message about OCI runtime internals. Closing it needs
a decision Kojo has not made: either probe the workspace at acquisition and rebuild the sandbox when
it is unreachable, or ask Sandcastle for a per-acquisition worktree path. Neither belongs in this
ticket. Do not read a green container lane as evidence the fault is gone.
