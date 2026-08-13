# A rebuilt sandbox is probed and rebuilt, not given a fresh worktree path

A run that suspends at a gate releases its container and rebuilds it days later. Sandcastle derives
the worktree path from the repo and the branch — `.sandcastle/worktrees/<branch with / as ->` — and
`CreateSandboxOptions` carries no override, so every acquisition of one scope reuses the **same host
path**. A rebuild therefore deletes that directory and creates it again. On macOS the Docker VM does
not always follow: `docker run` succeeds, and the first `docker exec` dies with
`chdir to cwd ("/home/agent/workspace") … no such file or directory`, exit 127.

Kojo **probes the workspace from inside the sandbox at acquisition, and builds another container when
the probe fails** — up to three, then fails with `WorkspaceUnreachable` naming the workspace and the
branch. It does **not** ask Sandcastle for a per-acquisition worktree path.

## Considered Options

- **A per-acquisition worktree path from upstream.** Rejected, and the reason is not effort.
  1. *It is not Kojo's to give.* `CreateSandboxOptions` has no such field. Closing this way means an
     upstream change, a release, and a version floor — for a fault that a factory hits on a Tuesday
     and needs an answer to today.
  2. *It treats the symptom as the cause.* A unique path per acquisition avoids one way of arriving
     at an unusable workspace. It does not avoid the others: a stale mount, a provider that starts a
     container against a volume that has gone, an isolated provider whose copy never landed. The
     probe catches the **state**, whatever produced it, and the state is what a phase trips over.
  3. *It costs the reuse that makes a rebuild cheap.* Sandcastle reuses a clean worktree and
     fast-forwards it. A path per acquisition is a fresh `git worktree add` every time, and the
     mounted caches edge 2 recommends stop being reachable at a stable location.
- **Surface it as a phase failure with a better message.** Rejected. Nothing about the run is wrong.
  The branch carries the work, the recorded phases stay recorded, and the human's answer is still in
  the gate store. A failure here would ask a person to re-approve something they already approved.
- **Probe, and rebuild.** Chosen.

## Consequences

- **The probe is one `pwd` through `Sandbox.exec`, and it is not on the `SandboxSource` port.** Every
  provider already exposes `exec`, and *that command runs at all* is the fact in question — so the
  check is uniform and no adapter has to opt in. `pwd` is a shell builtin, so no image can be missing
  it; the test image deliberately carries no git for the same class of reason.
- **The probe runs before the worktree is read, not after.** The probe finds the recoverable fault
  and the worktree read finds the terminal ones. Reading the tree first is also wrong on its own
  terms: when the workspace is genuinely gone, host git in that directory fails too, so the run would
  die naming `git rev-parse` — the same unhelpful message in a different accent. Graded: reversing
  the two makes `unreachableWorkspace.test.ts` fail with `SandboxError` instead.
- **A discarded container is released at once and recorded `failed`.** Each attempt runs in a scope
  forked from the scope's own, closed with a failure exit the moment the container is thrown away, so
  a scope that builds three never holds two and each of the three leaves a trace row with its own
  cost. `failed` rather than a new outcome: it is the same word an acquisition gets when the worktree
  check rejects it, and it is the same fact — the container was built and was not usable.
- **Three containers is an argument, not a measurement.** Ticket 19 measured the fault at 1 in 6
  acquisitions under `/Users` and 3 in 4 under `$TMPDIR`, never at 1 in 1, so independent draws are
  what the bound is worth. What no test shows is that a rebuild clears the *Docker VM's* stale view
  in the wild — only that a rebuild is what a run should do about an unusable workspace.
- **`WorkspaceUnreachable` joins the error union every `sandboxed` author declares.** It is a
  `Schema.TaggedError` because the engine persists what it records, and the scaffold templates carry
  it so a stamped factory compiles.
