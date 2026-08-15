# Kojo — Architecture

> Kojo gives you **primitives for authoring AI developer workflows**, and nothing more.
> A workflow is an Effect program you write. Kojo supplies the four things such a program is made
> of, the ports it plugs into, and the durability that lets it wait for a human.

This document is the model. [typescript-effect.md](typescript-effect.md) is the project as built.

---

## 1. What Kojo is, and what it refuses to be

Kojo is **not** a workflow runner with a fixed shape. It does not own a phase list, a lane taxonomy,
or a definition of "done". Those belong to whoever is authoring the factory.

What Kojo owns:

- **Four primitives** — the node kinds every AI developer workflow is built from.
- **Ports** — the pluggable seams, each shipping one deliberately boring reference adapter.
- **Durability** — a run that waits days for a human and then continues where it stopped.
- **A trace** — every run observable while it is still running.

Everything else is the author's program. This is the same bet Sandcastle makes with sandbox and
agent providers, extended to the two seams it does not have: how a run starts, and how a human
answers it.

### The two upstreams

Kojo is the control plane of one project driving the execution plane of the other. Each names the
other's contribution as its own explicit gap.

[super-simple-software-factory](https://github.com/disler/super-simple-software-factory), under
*"where it can still fail"*:

> Also missing on purpose: this runs on your current branch. For real work you want a branch per
> run, a sandbox around the agent, and a merge step at the end.

That is a one-line specification for [sandcastle](https://github.com/mattpocock/sandcastle):
branch strategies, sandbox providers, merge-back.

Sandcastle's converse gap is visible in its own templates. `parallel-planner-with-review/main.mts`
is a 227-line hand-written loop: `console.log` for observability, `Promise.allSettled` for error
handling, no typed handoff, no validation, no permission boundary, no trace.

| Concern | From | Shape in Kojo |
|---|---|---|
| Sequencing, retries, acceptance | SSSF | the author's Effect program |
| Typed context across seams | SSSF | **envelopes** |
| Definition of done | SSSF | **checks** |
| What an agent may change | SSSF | **permissions** — post-hoc diff and rollback |
| Observability | SSSF | **trace** — SQLite, polled |
| Agent roster | SSSF | **roster** — one agent, one prompt, one purpose |
| Where an agent runs | Sandcastle | `SandboxProvider` |
| Which agent binary runs | Sandcastle | `AgentProvider` |
| Branch per run, merge back | Sandcastle | branch strategy, `commits[]` |
| Running a command in that same world | Sandcastle | `sandbox.exec()` |
| Session capture, resume, fork | Sandcastle | what makes rebuild cheap — see §4 |
| **How a run starts** | *neither* | `Trigger` port |
| **How a human answers** | *neither* | `Gate` port |
| **Waiting for days, then continuing** | *neither* | durable execution |

The last three are Kojo's own contribution.

---

## 2. The four primitives

Every node in an AI developer workflow is one of four things.

| Primitive | Notation | What it is | Owns |
|---|---|---|---|
| **Actor** | oval, person | a human doing something | the decision |
| **Code** | diamond, `</>` | a known invocation | determinism |
| **Agent** | rectangle, robot | reading and deciding | the judgement call |
| **Sandbox** | enclosing box | an environment | the blast radius |

Three of them are nodes. **The fourth is a scope** — it wraps a region of the workflow rather than
occupying a position in it. Getting that wrong is the single most expensive mistake available here,
because it decides where suspension can happen.

### Actor

Two distinct uses, and they behave very differently.

- **Input** — a person supplies the request that starts a run. Non-blocking; it is the trigger.
- **Gate** — a person decides, mid-run, whether the work continues and along which branch.
  **Blocking, and blocking for an unbounded time.**

A gate is not a checkpoint that prints something and continues. It is a suspension point: the run
stops, releases everything it holds, and resumes when an answer arrives — an hour later, or on
Monday. Everything in §4 follows from this one fact.

### Code

A known invocation. `bun test`, `git commit`, a status transition on a ticket, a CI dispatch, a
merge. If you can write the command down, it is not a judgement call, and paying an agent to
rediscover it each run costs money, time, and consistency.

Code failures travel back to an agent as an envelope, through the same door an agent's own report
would use, so the repair loop is identical.

### Agent

Prompt in, typed envelope out. An agent phase is bounded: one call, one contract, validated after
the fact. It is for the parts that need reading and deciding.

An agent phase is independent of the sandbox scope. An agent that only classifies a ticket needs no
container; an agent that writes code does. This is visible in any realistic factory, where a routing
agent runs before a sandbox exists.

### Sandbox

The isolation boundary and the working copy, in one. A sandbox is created **around a region** of the
workflow: the setup happens on the host, the risky work happens inside, the merge happens on the
host again.

Sandboxes nest as branches of the graph, not as a global wrapper. Two lanes of the same factory can
want different images, different mounts, different install hooks.

---

## 3. The showcase, decomposed

A realistic factory, used here to check the primitive set is complete. **This is example code an
author writes, not a shape Kojo imposes.**

```
Support ─┐
Product ─┼→ </> Kanban Ticket ─→ </> Start Factory ─→ </> In Progress ─→ 🤖 Router ─→ </> Setup Sandbox
Engineer ┘                    ↗
         Engineer Prompt ─────┘
                                                                                          │
        ┌─────────────────────────────────────────────────────────────────────────────────┤
        │                                                                                 │
  ┌─ Hotfix Sandbox ────────────────────────────────────────────────────────────────┐    │
  │  🤖 Scout → 🤖 Hot Fix → 👤 Approve/Reject → 🤖 Build ⇄ 🤖 Test → 👤 Review     │ ←──┤ hotfix
  │                ↑______________reject_____________________________fail___________│    │
  └─────────────────────────────────────────────────────────────────────────────────┘    │
  ┌─ Feature Sandbox ───────────────────────────────────────────────────────────────┐    │
  │  🤖 Planner → 🤖 Build ⇄ 🤖 Test → </> CI/CD → 👤 Review                        │ ←──┤ feature
  │       ↑_________________________________________________fail___________________│    │
  └─────────────────────────────────────────────────────────────────────────────────┘    │
  ┌─ Bug Sandbox ─── 🤖 Plan → 🤖 Build ⇄ 🤖 Test → </> CI/CD → 👤 Review ──────────┐ ←──┤ bug
  └─────────────────────────────────────────────────────────────────────────────────┘    │
  ┌─ Chore Sandbox ─ 🤖 Build ⇄ </> Lint → </> CI/CD → 👤 Review ────────────────────┐ ←──┤ chore
  └─────────────────────────────────────────────────────────────────────────────────┘    │
  ┌─ Any specialized ADW you need ── 🤖 Your ADW ────────────────────────────────────┐ ←──┘ …
  └─────────────────────────────────────────────────────────────────────────────────┘
                                        │
                        all lanes → </> Merge → </> Ship
```

What it demonstrates, in order of how much it constrains the design:

1. **A human gate sits mid-lane.** `Approve / Reject` between the fix and the build; `Review` before
   every merge. Both are drawn *inside* the sandbox. §4 is about what that costs.
2. **Routing is an agent decision.** The Router reads the ticket and emits a lane. The envelope does
   not only carry context forward — its discriminant **selects the next subgraph**.
3. **The host / sandbox boundary is explicit.** Ticket, status, routing, and setup precede the
   sandbox. Merge and ship follow it. An agent (the Router) runs on the host.
4. **Loops target different nodes per lane.** Test failure returns to Build. Review failure returns
   to the *Planner* on the feature lane — a rejected feature is usually a planning miss — but to the
   Hot Fix Agent on the hotfix lane.
5. **Lanes differ on purpose.** Hotfix skips CI/CD and gains a human approval *before* building.
   Chore skips planning entirely. The taxonomy is the author's, which is exactly why Kojo must not
   own it.
6. **The human decides; code executes.** Every path passes `Engineer Review` before anything lands,
   and merging and shipping are then known invocations — deterministic code, not a second human
   step. The gate is where judgement happens; what follows it is consequence. Putting a person on
   the merge as well would ask the same question twice.
7. **`Your ADW` is drawn in.** Extensibility is the promise, not a footnote.

Nothing here needs a node-and-edge DSL. `switch` on the router's envelope, `while` for the test
loop, early return on rejection — plain control flow already expresses all of it.

This diagram is documentation, not a source artifact — and it is a projection of the *workflow*, not
of a run. A run walks one path through it, and a loop becomes repeated phases rather than a cycle.
That is why the Console draws a waterfall and not this picture: the picture is derivable only from
the author's TypeScript, which D1 refuses to own. See
[adr/trace/0001](../adr/trace/0001-run-view-is-a-waterfall-not-the-authored-graph.md).

---

## 4. The branch is the durable state

The decision that everything else hangs from.

A gate suspends a run for an unbounded time. Two options:

| | keep the sandbox warm | tear down and rebuild |
|---|---|---|
| resume latency | instant | image start + install hooks |
| cost while waiting | a container per waiting run | zero |
| survives a laptop reboot | no | yes |
| survives a CI runner ending | no | yes |
| reproducibility | drifts | exact |

**Tear down and rebuild.** A run that is waiting for a human must hold nothing.

Which means the sandbox cannot be the state. The state is:

- **the branch** — every commit the agents made, on `kojo/<run-id>`, on the host
- **the persisted phase results** — what each completed phase returned
- **the captured agent sessions** — each agent's conversation, pulled back to the host

A sandbox is then a **cache of the branch**: derivable at any moment, from the branch alone.

Two properties make this work, and both already exist upstream:

- Sandcastle's `branch` strategy reuses an existing worktree and fast-forwards it when safe, so
  re-creating a sandbox for a branch is idempotent.
- Sandcastle **captures each agent's session file back to the host** after every iteration, with the
  provider's `cwd` fields rewritten. So rebuilding restores not just the tree but the agent's
  *context*. Resuming a correction loop after a two-day gate costs one message, not a cold start.
  This holds on bind-mount providers (Docker, Podman) with the `claudeCode`, `codex`, or `pi`
  agents — isolated providers skip capture and cannot resume, one more reason the reference
  sandbox is Docker.

The mechanism that ties it together is replay. When a suspended run resumes, the workflow re-executes
from the top; completed phases return their persisted results without re-running, so the replay
fast-forwards in milliseconds — and on the way past, the sandbox scope is re-entered and the sandbox
is rebuilt. Continuation lands exactly where it stopped.

Three rules fall out, and they are not negotiable:

1. **Every side effect lives inside a phase.** Replay re-runs anything that is not a recorded phase.
2. **Sandbox creation is idempotent and derives from the branch alone.** No hidden state in the
   container that the branch does not carry.
3. **A gate is cheap; the work around it is not.** Put gates where the work already reached a
   commit, so the rebuild has something to rebuild from.

---

## 5. Ports

The extension surface. Every port ships **one reference adapter, deliberately the simplest thing
that works**, and the port exists so you can replace it.

| Port | Question it answers | Reference adapter | Obvious others |
|---|---|---|---|
| `Trigger` | what starts a run? | manual — the CLI | ticket poller, webhook, cron, file watch |
| `Gate` | how does a human answer? | terminal — print a command, wait | the Console, PR review, Slack, email |
| `SandboxProvider` | where does the work run? | Docker *(Sandcastle)* | Podman, Vercel, Daytona, none |
| `AgentProvider` | which agent binary? | Claude Code *(Sandcastle)* | Pi, Codex, Cursor, OpenCode, Copilot |
| `Workspace` | how do we touch files and run commands? | bind-mount worktree | sandbox exec, in-memory |
| `AgentInvoker` | one agent call | Sandcastle | scripted, recorded |
| `Tracer` | where does the trace go? | SQLite | in-memory, OpenTelemetry |
| `Roster` | who are the agents? | YAML file | object literal |

Two of these are new, and they are the reason the diagram needed more than Sandcastle already has.

### Trigger

Produces the payload a run starts from, and — critically — the value the run is **deduplicated** by.
A ticket that is triggered twice must not open two factories.

The reference adapter is the CLI: a person types a prompt. A ticket poller, a GitHub webhook
receiver, and a cron are each ten lines against the same interface.

### Gate

Two halves, deliberately separated:

- **request** — ask the human. Post a PR review request, print a command, send a Slack block.
  Receives a **token** identifying this exact suspension.
- **answer** — out of band, whenever. Whatever mechanism the adapter chose ultimately hands the
  token and a verdict back to the engine, and the run resumes. **Every gate answers in the same
  `Verdict` schema**, so any adapter can answer any gate holding nothing but the token.

The split is what makes long waits work: the requesting side runs and finishes; the answering side
may happen in a different process, on a different machine, on Tuesday.

The reference adapter prints `kojo gate answer <token> --approve` and stops. A PR-review adapter is
the attractive real one — the branch already exists, and GitHub already means approve/reject — at
the cost of coupling to GitHub, which is precisely why it is an adapter and not the port.

A gate also carries a **deadline**, because a run that waits forever is a leak. On expiry it takes a
declared branch: escalate, auto-reject, or fail.

### Not ports

The issue tracker is **not** a Kojo port. Reading a ticket, flipping it to In Progress, closing it —
those are code phases the author writes against their own tracker's SDK. Adding a port there would
be Kojo deciding what a ticket is, which is exactly the line this project does not cross.

CI/CD is not a port either, for the same reason. It is `sandbox.exec` or an API call in a code phase.

---

## 6. Vocabulary

Fixed here so the code, the trace, and the docs agree. Where Kojo diverges from an upstream term,
the divergence is deliberate and noted.

| Term | Meaning |
|---|---|
| **Factory** | everything Kojo stamps into a repo — roster, prompts, workflows, sandbox definition |
| **Workflow** | an authored Effect program made of phases. Interchangeable with **ADW** |
| **Phase** | one node of a workflow. Kinds: `actor`, `code`, `agent` |
| **Run** | one execution of a workflow, identified by a run id, which names its branch |
| **Envelope** | a phase's typed output — carries context forward and selects branches |
| **Check** | a predicate over an envelope's claims, run after the fact |
| **Gate** | a human decision point that suspends the run |
| **Verdict** | the answer to a gate |
| **Acceptance** | whether a completed run is *good*, which is a different question from whether its phases passed |
| **Roster** | the agent definitions — one agent, one prompt, one purpose |
| **Workspace** | the filesystem and shell a phase acts on, wherever it physically is |
| **Sandbox** | the isolation boundary around a region of a workflow |
| **Host** | the developer's machine, where the real repo and the branch live |
| **Console** | the web surface a human reads a run through, and answers a gate from. Served by `kojo ui` |

Two renames worth flagging:

- **`gate` now means the human decision**, matching the diagram and ordinary usage. SSSF calls its
  envelope validators "gates"; in Kojo those are **checks**. One word, one meaning.
- **`run`** replaces SSSF's *session*, because Sandcastle already uses "session" for an agent's
  conversation record, and that meaning is load-bearing here (§4).

Where the concepts line up, Kojo matches Sandcastle's `CONTEXT.md` exactly: *sandbox*, *host*,
*agent*, *iteration*, *branch strategy*, *agent invoker*, *agent session*.

---

## 7. Decisions

**D1 — Kojo ships primitives, not a pipeline.** No built-in lane taxonomy, no fixed phase order, no
opinion about tickets. If a decision belongs to the author, Kojo does not make it.

**D2 — A sandbox scopes a region, not a run.** `sandboxed(config, body)`. Setup before, merge after,
agents allowed on both sides of the boundary.

**D3 — Tear down on suspend; the branch is the state.** See §4. A waiting run costs nothing.

**D4 — One agent call per agent phase.** Sandcastle's iteration loop plus its completion signal is a
*second* control plane; running two means neither can say why a run stopped. The author's program
owns looping. Corrections re-enter the same agent session, so a retry costs one message rather than
a cold start.

**D5 — The envelope schema is one declaration.** It is the decoder, the TypeScript type, the JSON
example rendered into the agent's prompt, and the wire contract handed to the agent provider. SSSF
keeps these in three files and warns twice about drift; here drift is not expressible.

**D6 — Agents propose, code disposes.** An agent puts a commit message on its envelope; a code phase
performs the commit. An agent reports which files it changed; a check verifies it. An agent never
runs the merge.

**D7 — Acceptance gates the merge.** Phases passing is not the same as the run being good — a test
phase that ran a red suite did its job perfectly. Acceptance is the conjunction of the mechanical
verdict and the human one, and it is the single condition the merge hangs on. A rejected run leaves
its branch and worktree intact for inspection and merges nothing.

**D8 — Permission is verified after the fact, against the repo.** A tool allowlist cannot make "this
agent changes nothing" true: `bash` runs `git checkout`, and a write tool reaches any path. So the
working tree is fingerprinted before and after each agent call, unauthorised changes are rolled back,
and the phase dies. A breach is not a check violation — it cannot be fixed by re-prompting, and the
design must make retrying one impossible rather than merely discouraged.

**D9 — One wide row per unit of work.** A phase writes exactly one trace record, on exit, on every
path, carrying everything known about it — agent, model, session, tokens, envelope verdict, checks,
corrections, files touched, commits, and whether it ran in a sandbox. Not a stream of thin rows
reassembled by a join, which only ever answers the questions someone thought to write a row for.
Runs are stamped with the engine version and commit that produced them; the run id crosses into
every sandbox so the agent's own output joins back. See typescript-effect.md §9.

One consequence, recorded because it looks like an exception and is not: a phase row on exit means a
running phase has no row, so the run row carries the **in-flight phase** and is updated in place.
That is the run's status, not a record of completed work. See
[adr/trace/0002](../adr/trace/0002-in-flight-phase-lives-on-the-run-row.md).

---

## 8. Edges to design around

1. **Replay is the sharpest edge in the system.** Anything outside a recorded phase re-runs on every
   resume. A stray `git push` in workflow body code, not inside a phase, will fire again days later.
   This needs to be loud in the docs and, where possible, unrepresentable.
2. **Sandbox rebuild is not free.** A gate inside a lane with a five-minute install hook makes every
   human answer cost five minutes. Mitigate with mounted package caches and `copyToWorktree`, and
   tell authors to place gates deliberately.
3. **A branch can move under a suspended run.** Someone merges to main while a run waits two days.
   On resume the rebuild must decide: rebase, merge, or fail loudly. Failing loudly is the honest
   default — and Kojo has to *make* it loud, because the upstream refresh is silent. Sandcastle's
   worktree refresh has four skip paths — HEAD not on the branch, fetch failure, divergence from
   origin, dirty worktree — and each reuses the worktree as-is behind a log line. The first is
   exactly the state a suspended run leaves. Since "the branch is the durable state" is the central
   claim of §4, Kojo must check the worktree itself on re-entry rather than trust that the refresh
   happened.
4. **Glob semantics for permissions.** In the upstream implementation `*` deliberately does not cross
   `/`, so `.kojo/workflows/*.ts` cannot match `.kojo/data/sessions/x/y.ts`. A stock glob library
   crosses `/` and silently widens every protected path. Port the matcher, table-driven, with tests.
5. **Defence in depth beats rollback.** Post-hoc rollback stays, but simply not mounting the roster
   and the workflows into the sandbox is cheaper and more certain. An agent that cannot see its
   grader cannot edit it.
6. **Placeholder commands are theatre.** A scaffolded factory cannot guess your test runner, and a
   plausible-but-wrong command that exits 0 is worse than one that says it is fake. Ship obvious
   placeholders, and have `kojo doctor` refuse to call a factory ready while any survive.
7. **The toolchain must exist in the image.** Code phases run in the sandbox, so `bun test` needs bun
   *there*. Init should wire the detected package manager into the Dockerfile and the first command
   block together.
8. **Gate deadlines and orphaned runs.** Every gate needs an expiry and a declared branch on expiry.
   Runs suspended past their deadline need to be visible — `kojo runs` should surface them, not bury
   them.
9. **Concurrency on one branch.** Two runs against the same run id contend for the same worktree.
   Joining a run deliberately rejoins its branch; running two processes against one run id must be
   refused, not raced.
10. **Cost accounting.** Sandcastle reports token counts but not price. Either carry a model price
    table or show tokens only — a wrong cost column is worse than no cost column.
11. **A rebuilt sandbox can come back with an unusable workspace.** Found by ticket 19, running a
    real lane on Docker. Sandcastle derives the worktree path from the repo and the branch, and
    `CreateSandboxOptions` cannot override it, so every acquisition of one scope reuses the **same
    host path** — and a rebuild after a gate deletes that directory and recreates it. On macOS the
    Docker VM does not always follow: `docker run` succeeds, then the first `exec` dies with
    `chdir to cwd … no such file or directory`, surfacing as exit 127 and a message about OCI
    runtime internals. Measured failure rates for a three-process lane: 3 in 4 under `$TMPDIR`,
    **1 in 6 under `/Users`**, 0 in 16 under `/private/tmp`. The middle number is the one that
    matters — the path a real factory runs on is not immune, and the rebuild-after-a-gate that
    trips it is the exact mechanism §4 depends on.

    **Decided (ticket 37): probe and rebuild.** Entering a sandbox scope now runs one `pwd` inside
    the sandbox before any phase does, reads a non-zero exit and a command that never ran as the
    same fact, and **builds another container** when the workspace does not answer — up to three,
    each in a forked scope so the discarded one is released at once and still leaves its own trace
    row. Nothing about the run is wrong when this happens, so nothing about the run stops. Only when
    three in a row say the same thing does the run fail, with `WorkspaceUnreachable`, whose sentence
    leads with the workspace and the branch and carries the raw text after them. The rejected
    alternative — a per-acquisition worktree path from upstream — and the reasons are in
    [adr/sandbox/0001](../adr/sandbox/0001-probe-the-workspace-rather-than-ask-for-a-worktree-path.md).

    What is **proven** is the recovery and the message: `tests/integration/.../unreachableWorkspace.test.ts`
    takes the workspace away underneath a live sandbox through a host `onSandboxReady` hook, which
    is deterministic (8 of 8 on `no-sandbox`, where the operating system answers rather than a VM
    cache) and fails without the rebuild. What is **argued** is that a rebuild clears the macOS
    Docker VM's stale view in the wild: the same deletion under Docker reproduces at 18 of 18 only
    once the container has already run a command, and 1 of 8 when it has not, so no Docker test
    grades the fix. The exit-127 wording is pinned as a string instead.
12. **Two lanes that both stop for a human leave a run nobody can resume.** Found by ticket 35, and
    it is upstream rather than Kojo's. `Workflow.suspend` marks the *instance* suspended, and
    `Workflow.intoResult` records `Suspended` only when the body's cause is interrupts-only **and**
    that flag is set. With two gates open at the same time, answering one of them resumes an
    execution whose fiber then ends interrupts-only with the flag clear, so `intoResult` fails the
    fiber and `Workflow.poll` **dies** — an empty cause, which is the worst sentence a human can be
    shown. Measured on `WorkflowEngine.layerMemory` and on `ClusterWorkflowEngine` over
    `TestRunner`, with and without a sandbox scope, so it is neither the memory engine's nor the
    sandbox's; and it depends on *which* of the two gates is answered, which makes it a trap rather
    than a rule.

    Two gates are only open at once when one lane is inside an activity while the other asks — which
    is precisely the sibling constraint below, and precisely the shape a busy factory reaches. A run
    with a gate in **one** lane and work in the other resumes correctly, and that case is covered.
    Pinned as it stands in `tests/unit/.../lanes.test.ts`; nothing in Kojo works around it, and
    `run.ts`'s `status` still lets the defect through to the CLI.
13. **Suspension waits for sibling activities, and the waiting lane pays for it.** A suspending fiber
    parks until every concurrently running activity of that run finishes or itself suspends
    (`Workflow.wrapActivityResult` → `waitForZero`). So a gate in lane A holds **both** containers
    open for as long as lane B's phase runs: lane A's sandbox row carries the whole wait in its
    `lifetimeMillis`, and the human has not even read the question yet. Not a fault and not fixable
    from here — the cost is recorded rather than hidden, and an author who puts a gate beside a long
    phase should expect to pay for the container that is doing nothing.
14. **A repository git cannot read is one Sandcastle deletes.** Its release decides whether to keep
    the worktree by running `git status --porcelain` in it, wrapped in a `catchAll` that turns *any*
    failure into "clean", and then removes a clean one with `git worktree remove --force`. Measured
    rather than read off the source, because the distinction decides whether it matters: break the
    worktree's *registration* and both commands fail, so nothing is lost — but break only what
    `git status` needs, and an unreadable index is enough, and **the worktree and the uncommitted
    work in it are gone with no error anywhere.** §4 says the branch is the durable state, and this
    is the one path that deletes it. Kojo asks the same question one step earlier and reads a failure
    the opposite way: `preserveIfUnreadable` in `adapters/boundary.ts` declines to call `close()` at
    all, leaving a worktree and a container behind and saying so. That trade is deliberate — a leaked
    container is recoverable and deleted work is not — and it is the same rule
    `Permissions.output` already applies to a failed `git diff`, because an empty answer from a
    failed command reads as *nothing changed*. Ticket 60.
