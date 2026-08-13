# 34 — Reaching isolated providers

**What to build:** The factory runs on providers that give no host filesystem, by routing every file and command operation through the sandbox itself. Resume is correctly reported as unavailable there rather than silently assumed.

**Blocked by:** 16, 13

**Status:** done

- [x] A workspace adapter performs every operation through sandbox execution
- [x] Checks and code phases written against the port work unchanged on it
- [x] The absence of a host path is represented rather than faked
- [x] Session capture and resume are reported as unavailable, and a workflow that requires resume fails clearly instead of degrading quietly
- [x] An integration test runs a lane end to end on an isolated provider

## Comments

### What landed

- `src/contexts/sandbox/adapters/SandboxExecWorkspace.ts` — the third adapter of the `Workspace`
  port. Every method is one `sandbox.exec`: `cat --` reads, `mkdir -p && cat >` with the content on
  **stdin** writes, a portable `test`/`wc` sentence stats, a guarded `rm -rf` unlinks, and `git` goes
  down the same path as `exec` because Sandcastle put a real clone in the sandbox. `root` is
  **discovered** by running `pwd`, not assumed. `hostPath` is `None` when the provider's kind is
  `isolated` and `Some(worktreePath)` otherwise.
- `src/contexts/sandbox/guards/sessions.ts` — `sessionCapabilities` translates the sandbox's
  three-row matrix into the `AgentCapabilities` the agent port asks in, and `requireResume` fails
  with the existing `AgentInvocationError` / `resume-unsupported` fault rather than letting a
  correction turn silently become a cold start.
- `tests/support/localIsolatedProvider.ts` — an isolated provider built on Sandcastle's own
  `createIsolatedSandboxProvider`, backed by a temp directory. It needs no credentials and no
  container runtime, and Sandcastle still takes its real isolated path through it.
- `tests/integration/contexts/sandbox/adapters/SandboxExecWorkspace.test.ts` (7 tests) and
  `tests/unit/contexts/sandbox/guards/sessions.test.ts` (3 tests).

### Deviations

- **No new moon task and no new Vitest project.** Both tiers already exist and both already had a
  matching moon task; the new files are picked up by the existing `include` globs. Verified by
  running each project by name and reading the counts, not by assuming.
- **`git` is not split from `exec` on this adapter.** The port allows an adapter to send them to
  different places. This one does not need to: Sandcastle's isolated sync-in clones the bundle
  *inside* the sandbox, so `git` beside the files is `git` on the run's branch. Proven in the test —
  `rev-parse --abbrev-ref HEAD` answers `kojo/isolated` through the port.
- **The path rule is restated rather than shared.** It is the same rule `InMemoryWorkspace`
  enforces, but extracting it would mean editing a file three parallel tickets could also touch.
  Left as a documented duplicate; worth a shared helper once the wave has merged.
- **The lane test's trace sink is `InMemoryTracer`.** AGENTS.md says an integration test uses real
  adapters; the durable tracer is a later ticket and does not exist yet. The adapter under test —
  the workspace — is real, over a real sandbox.

### API findings

- **`SandboxExecOptions` has no `env`.** `cwd`, `sudo`, `stdin` and `onLine`, and that is all. So
  the port's `env` option is carried as an `env NAME=value …` prefix on the command line. It is
  added only when a caller asks for environment, because `env` runs a binary and would break the
  shell builtins a bare command line can still reach.
- **`stdin` is on all three provider handle kinds** (bind-mount, isolated, no-sandbox), so `write`
  never has to put file content through a shell argument.
- **Sandcastle does not publish the sandbox repo path.** `Sandbox.exec` documents `cwd` as
  defaulting to it, and nothing exposes what it is — `worktreePath` on the handle is the *host*
  staging worktree. Measured on an isolated provider: `worktreePath` was
  `<repo>/.sandcastle/worktrees/kojo/isolated` while `pwd` inside answered
  `/private/var/…/kojo-isolated-*/repo`. That gap is exactly why `hostPath` must be `None` there.
- **`sandbox.exec` does not trim.** `printf 'x\n\n'` came back as `"x\n\n"`, so `read` can return
  file content verbatim.
- **`createIsolatedSandboxProvider` is public** (exported from `@ai-hero/sandcastle`), which is what
  makes an isolated lane testable with no cloud account. Its `create` runs before the worktree
  exists, so a handle's default `exec` cwd must be a directory that survives
  `rm -rf <worktree> && mv <worktree>_clone <worktree>`.
- **`stat -c` and `stat -f` are unusable** across a Debian image, an Alpine one and a developer's
  Mac. The adapter uses `test` plus `wc -c`, which are POSIX; verified on BSD `sh`.

### Not done, and why

- **No test against a remote isolated provider** (Vercel, Daytona). Both need credentials. Nothing
  is skipped to compensate — the local isolated provider makes the suite run everywhere rather than
  report a skip as a pass — but the network and its failure modes are genuinely untested.
- **`moon` could not be run in this worktree**, exactly as ticket 16 reported. See the environmental
  blocker in the report; every task was run by invoking its own command, read out of `moon.yml` and
  `.moon/tasks/all.yml` rather than from memory.
