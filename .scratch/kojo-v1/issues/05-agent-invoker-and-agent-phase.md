# 05 — The agent invoker port and the agent phase

**What to build:** An agent phase takes a prompt and returns a decoded envelope. Backed by a scripted in-memory invoker, a whole workflow with agent phases runs in a test with no network, no credentials, and no container.

**Blocked by:** 03, 04

**Status:** done

- [x] The invoker port exposes resume as a capability rather than assuming it
- [x] The in-memory adapter returns pre-programmed envelopes keyed by agent name
- [x] An agent phase decodes the tagged output itself rather than delegating to the provider
- [x] A decode failure surfaces as the envelope parse error with its issue tree, not as a generic failure
- [x] The phase record carries the agent, model, session, token counts, and whether the call resumed or started cold
- [x] A test runs a workflow of three agent phases entirely on scripted envelopes

## Comments

### What landed

- `src/contexts/agent/ports/AgentInvoker.ts` — the port. `capabilities: AgentCapabilities`
  (`{ resume, capture }`) sits beside `invoke`, so a caller reads the capability rather than
  discovering it by burning a call. Two independent booleans because the matrix has three rows:
  bind-mount captures and resumes, no-sandbox resumes without capturing, isolated does neither.
  `AgentCall` carries `session: Option<AgentSessionId>` — the seam ticket 06 sits on.
- `src/contexts/agent/models/` — `AgentSessionId` (branded), `AgentAnswer` (a `Schema.Class`,
  `output` is **text**), `AgentInvocationError` (`Schema.TaggedError` with an
  `AgentInvocationFault` literal: `unknown-agent`, `resume-unsupported`, `provider-failed`).
- `src/contexts/agent/adapters/InMemoryAgentInvoker.ts` — scripted, keyed by agent name.
- `src/contexts/workflow/services/phase/agent.ts` — the phase, structured on `code.ts`: the trace
  write sits inside the activity, on exit, on every path.
- `src/contexts/trace/models/AgentCallRecord.ts` plus one new optional field on `PhaseRecord`.

### Deviations

- **The scripted answer is `{ envelope: … }`, not the bare envelope object** that
  typescript-effect.md §10 sketches (`router: { lane: "hotfix" }`). Two of the six acceptance
  criteria need what the bare form cannot express: a *malformed* answer (`{ output: "…" }`, the
  decode-failure case) and per-answer token counts. A discriminating wrapper is the only
  unambiguous way to hold all three, since an envelope may itself have any field name.
- **A script may be a list**, consumed in order and *exhausted* rather than recycled. A repeated
  last answer would let a loop that ran one turn too many read as green — and ticket 06 is a loop.
  A bare answer still repeats, so a phase-order test says it once.
- **`agent.ts` sets `PhaseRecord.errorTag`; `code.ts` (ticket 03) does not.** The field already
  existed and D9 asks for it. Left `code.ts` alone — not my ticket's territory — but the gap is
  real and worth a follow-up.
- Kept `docs/context/agent.md` unwritten. Three other agents are in flight; a new context file was
  not asked for here.

### API findings

- **`Schema.fromJsonString(envelope)` is the whole decode path.** It turns "the agent answered with
  prose" and "the agent answered with the wrong fields" into the same `SchemaError`, through
  ticket 04's one `decodeUnknown` helper, so `{ errors: "all" }` still holds. Verified: prose gives
  one issue at the empty path (`Expected a valid JSON string`); two bad fields give two issues at
  `changedFiles` and `commitMessage`. No hand-rolled `JSON.parse` is needed anywhere.
- **`SchemaAST.resolveIdentifier(schema.ast)` returns a `Schema.Class`'s declared name**, and it
  survives `Schema.fromJsonString`. That is `EnvelopeParseError.expected` with no second name for a
  call site to keep in step.
- **`Result` in v4 names its success field `success`, not `value`** (`Result.ts:161`). `outcome.value`
  compiles as `undefined` on a `Result.Success` and silently passes a `toBe(undefined)` assertion.
- **`Cause.findErrorOption(cause): Option<E>`** is how the terminal error tag comes off an exit;
  there is no `cause.failures`.
- `Schema.Union([EnvelopeParseError, AgentInvocationError])` works both as an `Activity.make`
  error option and as a whole workflow's error channel.

### Environmental blocker (not worked around, reported as found)

`moon` cannot run in this worktree. The worktree lives at `.claude/worktrees/<id>/` — *inside* the
repo root — and both directories carry a `.prototools` with `unstable-lockfile = true`, so proto
refuses:

```
proto::config::lockfile_already_exists
  × Unable to lock the directory ~/Projects/kojo as a lock file already exists in the child
  │ directory ~/Projects/kojo/.claude/worktrees/wf_30c8429a-442-1. Nested lock files are not
  │ supported. Instead, lock the parent directory.
```

It hits every proto shim: `bun install` (through the `lefthook` postinstall), `bun x`, and `moon`
itself — including `~/.proto/tools/moon/2.4.6/moon` invoked directly. `PROTO_UNSTABLE_LOCKFILE=false`
does not clear it. Nothing in the repo was edited to route around it; instead the tools were run
from their real paths (`~/.proto/tools/bun/1.3.14/bun`, `node_modules/.bin/vitest`), and
`bun install --ignore-scripts` plus a manual `effect-tsgo patch --typescript --no-oxlint` stood the
worktree up. So `moon run kojo:test` and `kojo:test-integration` were **not** invoked by name; the
commands behind them were (`vitest run --project unit`, `--project integration`), from
`packages/kojo`.
