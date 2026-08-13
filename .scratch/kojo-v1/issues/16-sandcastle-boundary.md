# 16 — The Sandcastle boundary

**What to build:** One module where every promise in the codebase lives. Everything outside it is Effect, and a build check enforces that so the boundary cannot quietly spread.

**Blocked by:** 13

**Status:** done

- [x] Sandbox acquisition and release are a scoped resource; a teardown failure is a defect, not something a workflow author handles
- [x] A build check fails if a bare promise appears in the package's public types
- [x] The provider's capability tag is carried by Kojo, because it is stripped from the published types and cannot be derived from a provider value
- [x] The three-row capability matrix is encoded — bind-mount captures and resumes, no-sandbox resumes without capturing, isolated does neither
- [x] Hook configuration matches the three slots that exist rather than a cross-product that does not
- [x] Per-run environment is threaded by constructing the provider, since sandbox creation takes none

## Comments

### What landed

- `src/contexts/sandbox/adapters/boundary.ts` — `acquireSandbox`, an `Effect.acquireRelease` whose
  release is `orDie`. It hands back a Kojo-side `SandboxHandle` (`branch`, `worktreePath`,
  `capabilities`, `exec`) rather than Sandcastle's `Sandbox`, because that one has `run`, `exec` and
  `close` as promises on its public shape and the build check would reject it.
- `src/contexts/sandbox/models/SandboxProvider.ts` — Kojo's own `SandboxKind`, the three-row
  `SandboxCapabilities` matrix, and `tagged`.
- `src/contexts/sandbox/models/SandboxHooks.ts` — the three slots, passed to Sandcastle structurally
  so a slot that moves upstream is a compile error here.
- `src/contexts/sandbox/models/SandboxError.ts` — `create` / `exec` / `close`, schema-backed.
- `src/contexts/sandbox/adapters/providers.ts` — `docker`, `podman`, `vercel`, `daytona`,
  `noSandbox`, each a factory taking Sandcastle's own option type.
- `src/contexts/sandbox/guards/promiseFreeTypes.ts` + `src/scripts/check-public-types.ts` — the
  guard and its executable.

### Deviations

- **`sandboxed()` is not here.** It is ticket 17, as the brief said, and so is `resolve(config)`.
- **`run()` is not on the handle.** `SandboxRunResult` carries `resume?` and `fork?`, which are
  promise-returning members — putting them on a Kojo type would trip this ticket's own check. The
  agent invocation half belongs to the invoker ticket, and it lands in **this same module**, which
  is the point of having one.
- **The provider factory is `noSandbox`, not `none`.** typescript-effect.md §2 lists `none`;
  Sandcastle's own name is `noSandbox` and AGENTS.md says to match its terminology where the
  concepts line up. The *kind* is `"none"`, which is what `--sandbox none` and the trace record.
- **The guard lives in `contexts/sandbox/guards/`, not in a top-level `scripts/`.** knip discovers
  entry points through `package.json` exports (`"./*": "./src/*.ts"`), so a file outside `src` would
  be reported as unused. The executable is `src/scripts/check-public-types.ts` and holds no logic.
- **New moon task: `kojo:check-public-types`**, depending on the inherited `~:tsc` task and marked
  `cache: false` (its real inputs are in the workspace type cache, outside the project).

### API findings

- **`tag` is present at runtime and absent from the types**, exactly as the audit says. Measured:
  `noSandbox()` → `{"tag":"none","name":"no-sandbox","env":{}}`,
  `docker({imageName,env})` → `{"tag":"bind-mount","name":"docker","env":{...},"sandboxHomedir":"/home/agent"}`,
  `vercel()` and `daytona()` → `{"tag":"isolated",...}`. The integration test reads that field
  through a cast and asserts Kojo's declaration agrees, so a rename upstream fails loudly.
- **`vercel` and `daytona` load their SDKs lazily.** Importing
  `@ai-hero/sandcastle/sandboxes/{vercel,daytona}` with neither optional peer installed succeeds and
  the factories return provider values. So `providers.ts` can name all five without dragging the
  peers in, which the design record did not state either way.
- **A whole sandbox lifecycle runs with no container.** `createSandbox({ sandbox: noSandbox() })` in
  a temp git repo creates the worktree under `<cwd>/.sandcastle/worktrees/<branch>`, `exec` works,
  and `close()` removes the worktree **and leaves the branch**. That makes the boundary genuinely
  integration-testable on a machine with no Docker.
- **`exec` really does surface a non-zero code**: `exec("exit 3")` → `{exitCode:3}`, no rejection.
- **A `createSandbox` rejection arrives as `FiberFailureImpl`**, from Sandcastle's own bundled
  Effect 3.20.0 runtime. It is an `Error`, so `cause.message` reads correctly (git's own
  "fatal: not a git repository"), but nothing else about it should be relied on — it is a foreign
  runtime's value, not one Kojo's `Cause` understands.
- **All three hook slots fire under `noSandbox()`**: `host.onWorktreeReady` and
  `sandbox.onSandboxReady` each wrote their file into the worktree. Verified, not assumed.
- **`@standard-schema/spec` did not need declaring.** typescript-effect.md §7 says Kojo should
  declare it. `dist/index.d.ts` does import it, but `skipLibCheck: true` means `bun tsc --build`
  never resolves it, and nothing at runtime reaches it. Left undeclared; the ticket said to add one
  dependency.

### Not done, and why

- **`moon` could not be run in this worktree.** See the environmental blocker in the report: proto
  refuses to lock the workspace when a `.prototools` exists in both `~/Projects/kojo` and a nested
  worktree under it. Every check was run by invoking the same tool directly, and the new task's
  command was executed by hand — against a clean tree (exit 0), against a deliberate leak (exit 1,
  correct file and line), and against a missing directory (exit 1, with the instruction to build
  first).
