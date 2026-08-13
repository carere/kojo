# 17 — The sandboxed scope and run correlation

**What to build:** An author wraps a region of a workflow in a sandbox. Setup happens on the host, the risky work happens inside, the merge happens on the host again. Suspension releases the container and keeps the branch; replay rebuilds it.

**Blocked by:** 16, 10

**Status:** done

- [x] The scope is local, not workflow-lifetime, so suspension releases the container and preserves the worktree
- [x] The scope sits outside every phase, because a resource acquired inside one turns an interrupt into a defect
- [x] Re-entering the scope on replay rebuilds the sandbox from the branch alone
- [x] Sandboxes nest as branches of the graph; two lanes can want different images and hooks
- [x] The run id, phase id, and attempt cross into every sandbox environment and every agent invocation
- [x] Each acquisition writes its own record, so a rebuild after a gate is visible rather than hidden
- [x] Re-entry checks the worktree state itself rather than trusting a refresh that fails silently in four different ways

## Comments

`sandboxed(config, body)` lives in `workflow/services/sandboxed.ts` and is `Effect.provide(body,
layers(config), { local: true })`. `Effect.provide` builds a layer through `effect.scopedWith`, so
the scope is **local** — closed by an ordinary interrupt, which is what a suspension is — and never
`Workflow.scope`, whose `intoResult` closes only on failure or Complete. `{ local: true }` forces a
fresh memo map so a second entry can never reuse the first container.

The `SandboxSource` port is a deviation from typescript-effect.md §7, where `sandboxed` calls
`acquireSandbox` and `BindMountWorkspace.layer` directly. Three members — `acquire`, `worktree`,
`workspace` — because entering a sandbox scope does three things, and only the first is Sandcastle's.
Putting them behind one port keeps `sandboxed` free of a filesystem, a process spawner and a
container runtime, which is what makes the highest-risk claim in the design unit-testable at all.
`SandcastleSandboxSource` is the real adapter, `InMemorySandboxSource` the fake.

Both halves of "the scope goes outside every phase" are now asserted rather than argued. The
correct placement suspends and leaves `acquired, released`; the wrong one — a `sandboxed` inside a
`code` phase — records no result at all, rebuilds its container **eleven** times, and dies with
`Activity "everything" interrupted and retry attempts exhausted`. Both are in
`tests/unit/contexts/workflow/services/sandboxed.test.ts`.

Re-entry reads the worktree with host git and grades it in a pure guard,
`sandbox/guards/worktreeIsUsable.ts`. Three checks, all on by default: HEAD is on the branch, no
tracked file carries uncommitted work, and the branch is not behind `origin`. Untracked files are
deliberately not dirt — `copyToWorktree` puts them there on purpose — and that distinction is
verified against a real repository in
`tests/integration/contexts/sandbox/adapters/SandcastleSandboxSource.test.ts`.

`KOJO_RUN_ID`, `KOJO_PHASE_ID` and `KOJO_ATTEMPT` are built once in
`shared/models/Correlation.ts` and injected by rebuilding the provider —
`CreateSandboxOptions` has no `env`, so that is the only door. In a sandbox environment
`KOJO_PHASE_ID` is the **acquisition's** id and `KOJO_ATTEMPT` is `0`: a sandbox is a scope around
phases, so at the moment its container starts there is no phase, and `Activity.CurrentAttempt`
counts from 1 so zero cannot be mistaken for one. An agent invocation overwrites both with the
phase's own. The integration test reads all three back from inside a real Sandcastle sandbox.

Two things to know downstream:

- The `Tracer` port gained `sandbox(record)` and `RecordedTrace` gained `sandboxes`. The record is
  written in the scope's finalizer, which is the one trace write in Kojo deliberately **outside** an
  activity — re-running on replay is the requirement here, not the bug.
- A `SandboxId` is `runId/name/acquiredAt`. A counter was rejected: the rebuild after a gate happens
  in a different process, where any in-memory counter restarts at one and the two acquisitions
  collide. Two acquisitions of one scope within the same millisecond would still collide; nothing in
  a real run does that, and nothing shorter than a trace read-back would close it.
