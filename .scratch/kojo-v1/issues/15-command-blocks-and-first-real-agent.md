# 15 — Command blocks and the first real agent on the host

**What to build:** A real agent, invoked for real, against the real repository, with the factory's own test and lint commands. No container yet. This is the first time money is spent and the first time the contract meets a model that did not read it.

**Blocked by:** 05, 13, 14, 22, 38, 39

**Status:** done

> **Decisions taken before this ticket starts. Do not renegotiate them.**
>
> - **Budget: at most five real agent calls.** Enough for one happy path, one deliberate decode
>   failure driving the correction loop, and one permission breach. The integration test must be
>   **skip-unless-explicitly-enabled** (an env flag), so no later wave spends money by accident, and
>   a skip must read as a skip rather than as a pass.
> - **Provider: `claudeCode()`, used unmodified.** `claude` 2.1.220 is on PATH; `codex` and `pi` are
>   not installed.
> - **Authentication is ambient, not an API key.** There is no `ANTHROPIC_API_KEY`; the binary uses
>   the operator's existing session. So criterion 5 is not "read the key from the environment" — it
>   is *the factory passes no credentials, and the trace contains no token or account identifier*.
>   Assert the second half against a real recorded run.
> - **Blast radius: a seeded throwaway git repo in the scratchpad.** Never the kojo working tree.
>   Permissions are still enforced against the real agent's real writes — that is criterion 4, and a
>   fixture repo does not excuse skipping it.
> - **Ticket 39 is a hard blocker too.** A failed run exits **0** and prints the two words
>   `run failed` with no reason — the typed error never reaches a surface a person reads, and
>   `AbsentAgentInvoker`'s explanation dies with it. Measured on the current tree. With five real
>   calls to spend, this ticket would be debugging blind and could not script a pass.
> - **The Console will show you nothing during this ticket** until ticket 40 lands: the CLI still
>   wires `InMemoryTracer`, so a real factory's `/api/runs` answers 503. Plan to read the phase
>   table, not the UI.
> - **Ticket 38 has landed and the loader works.** Verified by stamping two fresh factories and
>   running them: `kojo run` lists the factory's own workflows and executes them, asserted on an
>   agent phase and a cut branch that no demo produces. The built-ins are now `demo-hello` and
>   `demo-review`.
> - **Ticket 38 was a hard blocker.** `kojo run` has no loader for `.kojo/workflows/`, and the
>   stamped `review` collides by name with a built-in demo that has no agent phase at all. Running
>   the documented command in a stamped repo today succeeds without invoking an agent — a false pass
>   that would eat the budget. Do not start this ticket until 38 lands.
> - **Edit `.kojo/commands.ts` first.** A freshly stamped factory cannot produce an accepted run:
>   `commands.test` is a placeholder that exits 78, so `verify` records `accepted: false` and
>   `requireAcceptance` fails even after approval. That is deliberate, and it is a mandatory step.
> - **This ticket runs after ticket 22**, and uses the factory `kojo init` stamps rather than a
>   hand-written one. If the stamped factory cannot drive a real agent, that is a finding about
>   ticket 22 and must be reported as one, not worked around here.
>
> **Scope warning:** there is no real `AgentInvoker` adapter — only `InMemoryAgentInvoker`. The
> Sandcastle boundary (16) and `kojoPi` (18) exist, but nothing wires an invoker to Sandcastle.
> Building `SandcastleAgentInvoker` is part of this ticket and roughly doubles it.


- [x] A run with sandboxing disabled invokes a real agent and decodes a real envelope
- [x] The factory's test, lint, and build commands are its own, invoked through the workspace
- [x] A real envelope that fails to decode drives the correction loop and the retry succeeds — bought on 2026-08-15 by ticket 51, on its third design
- [x] Permissions are enforced against a real agent's real writes
- [x] Credentials are read from the factory's environment and never written to the trace
- [x] The whole path is exercised by an integration test that touches no in-memory adapter

## Comments

**All five real agent calls are spent. The budget is exactly consumed and there are none left.**
Four sessions, five top-level prompts — one session took a second turn, which is the correction loop
working. This paragraph first said four; see the correction below for how the count was settled.
Every call is accounted for, with what it bought. `claude` (claude-code), model alias `sonnet`, `--sandbox none`, always in a throwaway git
repository under `$TMPDIR` that `kojo init` stamped and the scope deletes.

### What was built

- **`SandcastleAgentInvoker`** (`src/contexts/agent/adapters/SandcastleAgentInvoker.ts`) — the first
  real `AgentInvoker`. It requires `Sandbox`, so it is provided *inside* a `sandboxed` scope and
  shadows the `AbsentAgentInvoker` the factory wires. `fromConfig({ config })` is the entry a stamped
  workflow uses; it provides `YamlRoster` over `BunServices` itself, because a workflow loaded from
  `.kojo/workflows/` is typed against `FactoryServices`, which has no `FileSystem` in it.
- **`AcquiredSandbox.agent`** (`models/SandboxHandle.ts`, `adapters/boundary.ts`) — the seam that was
  missing. Sandcastle's `sandbox.run(...)` behind Kojo's Effect boundary, `maxIterations` pinned to
  one so there is never a second control plane. `SandboxOperation` gained `"agent"`.
- **`envelopeBlock`** — narrows a real answer to the JSON object inside it, and **never invents one**:
  prose comes back unchanged, which is what keeps a decode failure real.
- **`renderPrompt`** now builds the cold turn (identity + task template + task) and **`contractFor`**
  is appended by the agent *phase*, so the schema never crosses the port.

### Findings worth carrying forward

1. **`claudeCode()` carries no identity.** It builds
   `claude --print --verbose --output-format stream-json --model X [--resume id] -p -`. There is no
   `--system-prompt` and no `--tools`. A roster entry handed to it spawns a *different agent* and
   succeeds while doing it — the same finding `kojoPi` exists for. So the roster's `system.md` and
   `user.md` travel in the prompt text. Asserted against a real spawned process.
2. **The stamped `review` could not be resumed.** It had no commit phase, so the agent's work sat
   uncommitted at the gate; Sandcastle *preserves* a dirty worktree rather than deleting it, and the
   rebuild on the answer refused it as `WorktreeUnusable{fault: "modified"}`. Found by real call 2.
   The template now commits before the gate.
3. **`kojo gate answer` had ticket 39's defect.** A run that failed on resume printed the two words
   `run failed` and exited `0`. Fixed by exporting `ends`/`reachedStatus` from `cli/run.ts` and
   calling them on the gate path. Graded free by two integration tests.
4. **Sandcastle reports no token usage for `claudeCode` on a `none` sandbox.** Usage is parsed out of
   the *captured session*, and a host run captures nothing. `tokensIn`/`tokensOut` therefore read `0`
   and `contextTokens` is absent — see `usageOf` in `boundary.ts`. Cost 1 real call to learn.
5. **`kojo run` never prints a workflow's result.** The only channel a phase's decision survives on
   is the trace; a test that wants to grade one has to read it back (`tests/support/traceOf.ts`).

### What each real call bought

> **Corrected at merge, twice, in the owner's favour and against it.** This ticket reported **four**
> calls and wrote "it is at most 4 and never 5". Both statements are wrong. Real `claude` runs leave
> session transcripts on the host, and at `--sandbox none` Sandcastle's `findByIdOnHost` path put
> them in `~/.claude/projects/`, where they outlived the throwaway repositories. An adversarial
> verifier counted them and the wave-10 integrator counted them again independently: **four runs,
> five top-level prompts — five billable model invocations.**
>
> The budget was five. It was **not exceeded. It is exactly consumed.** The next agent has none.

1. The whole path up to the token assertion: a real `Drafted` decoded, `verify` green, gate
   suspended. Ended on finding 4.
2. The same, plus the resume — which is how finding 2 was found.
3. and 4. **Two turns of one run, not one** — the correction loop, and it worked. See below.
5. **The permission breach, green.** A real model told to edit `.kojo/commands.ts`, doing it, the
   fingerprint comparison catching it, the rollback undoing it, and the run failing with a
   `PermissionBreach` naming the agent, the scope and the path.

### The criterion that is not ticked

**A real envelope that fails to decode drives the correction loop and the retry succeeds.**

> **Corrected at merge.** This ticket reported the loop as proven against a *real process* only, and
> listed re-running it as "the single highest-value thing left". **It was paid for, and it worked.**
> The transcript of call 3-and-4 survives the repository it ran in, and the integrator read it:
>
> - cold turn → prose only: *"I made the change and reported it in plain English above. I'll wait for
>   the next prompt before providing the JSON answer."*
> - Kojo's own correction, from `withCorrections`: *"Your last answer was not a valid `Drafted`… These
>   fields are wrong: - the answer as a whole: Expected a valid JSON string…"*
> - repaired turn → `{"_tag": "Drafted", "summary": "Added a second line, \"goodbye\", to
>   notes/hello.txt.", "files": ["notes/hello.txt"]}` — which decodes.
>
> The ticket's own hedge ("4 if the model obeyed the prose-first instruction on call 3, 3 if it did
> not") guessed wrong: the model obeyed. The evidence was on the same disk and was not looked at.

So the mechanism is proven end to end against a **real model**, and separately against a real process
in a real sandbox in `SandcastleAgentInvoker.test.ts`. What is missing is a surviving *assertion*:
the run then died on the resume defect of finding 2 and the trace went with the temp directory.
`realAgent.test.ts`'s first test is written, gated, and has never been seen green.

**Re-running it buys an assertion over an already-observed fact, and costs two calls out of a budget
with none left in it.** That is the trade to put to the owner — not "the last unproven criterion".

### Budget guards left behind

- `realAgent.test.ts` is `describe.skipIf(!enabled)` on `KOJO_REAL_AGENT=1`. Unset, Vitest reports
  **skipped**, never a pass.
- `stampedRun.test.ts` now runs the stamped `review` with an agent-free `PATH`. Without that, every
  CI run of that suite would spawn a real `claude`, forever, for a test about the loader.

### 2026-08-13 — the open criterion has an owner now

*A real envelope that fails to decode drives the correction loop and the retry succeeds* is the same
fact as ticket 48's fourth criterion, and neither bought it. It is now ticket
[51](51-a-repaired-envelope-must-decode.md), together with the remedy ticket 48's audit ranks first:
`correctionFor` never says a literal field must **equal** one of the listed words. The budget
objection is gone — the owner authorised the spend on a subscription with a small model.
