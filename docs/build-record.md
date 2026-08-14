# Build record

What was done to build Kojo v1, in the order it happened, and what it cost to find out.

Every claim here is sourced from the repository — a commit hash, a ticket file, or a path. Nothing
comes from a conversation transcript. If a line and its source disagree, the source wins.

The three other places the build wrote itself down, and what each is for:

| where | what it holds |
|---|---|
| the commit log | the findings, one per commit — 21,000 words across 135 commits on `feat/kojo-v1` |
| [`.scratch/kojo-v1/issues/`](../.scratch/kojo-v1/issues) | 49 tickets, 107 comment sections, under *What landed* / *Deviations from the design record* / *API findings* |
| [`typescript-effect.md` §12](design/typescript-effect.md) | where the build stopped: what is proven, what is not |

This file is the index over all three. It adds the one thing none of them has: the order.

---

## 1. Shape

Four stages, in this order. Each one exists because the one before it produced something the next
could grade.

1. **Design** — 12 commits on `main`, 2026-08-07 to 08-09. A grilling session produced
   [`console.md`](design/console.md); [`architecture.md`](design/architecture.md) and
   [`typescript-effect.md`](design/typescript-effect.md) were written and then corrected twice
   against primary sources.
2. **Audit** — nine agents compiled and ran the design record's own snippets against a probe install
   pinned at `effect@4.0.0-beta.106` and `sandcastle@0.12.0`. Recorded in
   [`effect-v4-api-audit.md`](research/effect-v4-api-audit.md), 43K.
3. **Tickets** — the build order became 36 tracer-bullet tickets with explicit `Blocked by` edges
   (`debe2e4`). Thirteen more were opened by the build itself; 49 exist now.
4. **Waves** — 20 merge clusters on `feat/kojo-v1`, 2026-08-09 21:21 to 08-13 12:24. One wave per
   level of the dependency graph: implementers in isolated git worktrees, then a **strictly serial**
   integrator that runs the whole discovered suite after **each** merge.

The one decision that produced the wave model: **`Blocked by` means "needs the code", not "needs the
ticket closed".** So merge cannot be a final step. It is part of the traversal.

---

## 2. Waves

Dates are author dates. Tickets are listed in merge order within each wave. The wave numbers are the
order the waves were launched; the tickets and dates come from the commit log.

| wave | when | tickets | what it found |
|---|---|---|---|
| **0** | 08-10 01:48 | 01, 02, 03 | Run serially, by hand, to establish the shape. Found three checks that were vacuous rather than passing — see §4. |
| **1** | 08-10 02:32 | 04, 13 | The package barrel re-exports `BunRedis` → imports the `bun` builtin → every Vitest worker dies at import. `CLAUDE.md` already forbade barrel imports; this was one. |
| **2** | 08-10 03:07 | 16, 14, 05, 08 | A tool allowlist cannot make "this agent changes nothing" true. Permissions became fingerprint-and-rollback. `PermissionBreach` was made structurally unretryable — a handler for it is a compile error. |
| **3** | 08-10 03:40 | 07, 06, 10, 34 | `proto` refused to run inside a nested worktree, so every agent in three waves built its own bypass — and a conclusion drawn through a bypass is a conclusion about the bypass (`a2a3d92`). One agent's finding, true only of its workaround, took the integration tier red on merge. |
| **4** | 08-10 04:27 | 09, 18, 32 | The design record's own `while(true)` review loop read one stale rejection five times in milliseconds and never suspended. It is kept as a test that still runs the bug. |
| **5** | 08-10 13:56 | 11, 17 | The durability suite found a defect on its first run: both halves of the run record sat outside a phase, so `runStarted` re-ran on every replay and every gated run was recorded as failed for the whole time it waited. |
| **5b** | 08-10 16:10 | 19 | Six properties waves 4 and 5 argued rather than proved (`aa7db70`), closed by one lane on real Docker across three processes. Found what no reading would: a sandbox rebuilt after a gate can come back with a workdir the container cannot resolve → edge 11 and ticket 37. |
| **6** | 08-10 18:53 | 24, 20, 12 | Two tickets each proved their own half on their own database and neither could prove the pair, because they were written in parallel worktrees (`98a45bc`). |
| **7** | 08-11 01:31 | 25, 21, 33, 22 | The integrator stamped a factory and tried to run it — the one check that mattered before spending money. `kojo run` had no loader for `.kojo/workflows` and the built-in `review` demo collided with the stamped `review` by name *and* idempotency key. Ticket 38 opened; ticket 15 blocked on it (`d3d64af`). |
| **8** | 08-11 03:21 | 26, 38, 37 | Verified the loader by stamping two fresh factories and running them. Two more seams opened: a failed run exits 0 with no reason (39), and the CLI wired `InMemoryTracer` so the Console served 503 against a real factory (40). |
| **9** | 08-11 05:34 | 23, 40, 39 | `kojo doctor` landed. I committed a trace database by accident in the previous wave (`77cdf13`) — `git add -A` after running the CLI from the repo root. |
| **10** | 08-11 14:29 | 41, 35, 15 | **The first ticket that spent money.** Five real calls, terms settled before an agent read the ticket (`ce4e144`). They found two defects: the stamped `review` had no commit phase, and `kojo gate answer` still exited 0 on a failed resume. |
| **11** | 08-11 16:25 | 42, 27 | `apps/console` — the first application. Root `tsconfig` pruned it silently, because moon refuses one application depending on another. References are hand-held now. |
| **12** | 08-11 18:23 | 28 | The waterfall. Needed the trace column ticket 24 deferred, so it wrote `0002_in_flight` end to end rather than render a field nothing fills. |
| **13** | 08-11 20:07 | 29 | The design record said a gate is a phase of kind `actor`. Nothing in the engine ever backed it. A gate got its own route and a third panel subject (`8ea9813`). |
| **14** | 08-11 23:41 | 30 | **A disqualifying find.** An *expired* gate was drawn as *"Applied — the run resumed"* — the ADR's failure mode inverted, and worse, because no decision existed behind it (`838fb56`). |
| **15** | 08-12 02:00 | 43, 44, 45 | The integrator walked the loop a person walks and found four breaks 85 green browser specs could not see. See §6. |
| **16** | 08-12 03:34 | 46, 47 | `kojo init` created the condition its own merge refuses: it tells you to install, and the first merge refuses over the `node_modules` it told you to create. |
| **17** | 08-12 23:49 | 36 | Kojo's own factory, in Kojo's own repository. **The first attempt failed** — the implementer stalled six times on `kojo watch`, a daemon that never exits. Then I destroyed the recovered worktree; see §7. |
| **18** | 08-13 12:10 | 48 | The correction loop against a real model. Bought three of four criteria with two of three authorised calls. |
| **19** | 08-13 | 49 | The guard that was mistaken for a flag, built — and, before it, an audit of every checkbox in every closed ticket, which found four criteria nobody owned and opened 50–53 for them. Cost: no agent call. |
| **20** | 08-14 | 53, 50, 51, 52 | The first wave run as one workflow: a design pass on 50, four implementers in isolated worktrees, three adversarial verifiers, then a strictly serial integration. Every verifier refuted something. Two of the four tickets landed; two came back with better findings than the criteria they went for. Cost: two real calls, and two unauthorised `pi` calls that Anthropic refused at zero cost. |

Ticket 31 (span export) is closed **wontfix** (`e5f8e08`): it blocked nothing through seventeen
waves, and the claim it was written under was withdrawn by the wave-3 audit. Tickets 50–53 are open.

---

## 3. What the design record got wrong

The design was corrected three times, and each correction was paid for by a different method.

**By reading the sources (`43eba1a`).** Sandcastle's session capture is bind-mount-only and
provider-dependent, so resume is a capability rather than a given. Structured output exists on
`run()` only. `JSONSchema.make` is `Schema.toJsonSchemaDocument`. The published CLI targets Bun, so
the platform packages change.

**By compiling the record's own snippets (`d4e1edf`).** Every *structural* claim survived. The
*code* did not:

- Every error moved from `Data.TaggedError` to `Schema.TaggedError`. `Workflow.make` types its error
  channel as `Schema.Top` and persists through `Schema.Exit`, so a `Data.TaggedError` cannot survive
  the round trip the design exists for. Invisible until the first suspension.
- The phase row's `onExit` moved **inside** the activity. Around it, the write replays — a run that
  suspends three times leaves four rows for one phase.
- The claim that spans and the phase table are one model was **withdrawn**. Replayed spans re-parent
  under whoever answered the gate, so a run that suspends N times yields N+1 disconnected fragments.
- `Context.Tag` → `Context.Service` (`961deea`), found while building the first port.

**By building it.** Fifteen more corrections, each in the commit that found it. The largest: a gate
is not a phase (`8ea9813`); `Effect.catchTags`' object form does not typecheck when the residual
error channel is generic (`43cba38`); an unhandled route error on beta.106 is not an unsatisfied
requirement at `serve` — the marker is dropped and the request answers 500 with an empty body
(`b09dd25`).

Three findings about Sandcastle's environment merge, each refuting the last:

1. Ticket 17 found `createSandbox` merges env with no allowlist, so an agent could override the
   correlation keys.
2. Wave 5 found the merge runs through `mergeProviderEnv`, which **throws** on overlapping keys, so
   it cannot (`aa7db70`).
3. Ticket 19 found Kojo uses neither path: `createSandbox` hard-codes `agentProviderEnv` as empty,
   so an agent provider's env is dropped **silently**. The only per-invocation door is an env prefix
   at exec time (`cc1425f`).

---

## 4. The false greens

Every entry is a check that passed while doing no work. The commits number them; the count reached
thirteen by wave 12 and did not stop there. This is the single most useful list in the build.

**Tooling that graded nothing**

| what | how it looked | source |
|---|---|---|
| A moon test task with zero tests in it | green | ticket 01 |
| Root `tsconfig` with `references: []` | `bun tsc --build` exits 0, compiles nothing | `0ec7ae2` |
| `moon run root:tsc` **erasing** those references | the fix for the above, undone on every run | `dd774bd` |
| Vitest workers under Node, not Bun | a test **file** that fails to LOAD contributes **zero tests** — five tests looked absent rather than broken | `dcc5486` |
| knip blind to all of `packages/kojo/src` | the `exports` map makes every source file an entry point, and an entry point is reachable by definition. **Three agents across three waves** read the green as proof their code was reachable | `26e2a46` |
| `moon run <p>:tsc --force` | skips moon's cache, then `tsc` reads `tsconfig.tsbuildinfo` and answers *up to date* — a file just edited, declared clean in 91 ms | `e3752b6` |

**Tests that graded the wrong thing**

| what | proof it graded nothing | source |
|---|---|---|
| `PhasePanel.tsx` contained a literal NUL byte | the file read as binary, so `grep` skipped it whole and silently, while tsc, biome and knip all passed | `6a310d1` |
| The fixture layer could not produce a `null` | fixtures omit an absent key, `SqliteTraceReader` passed `undefined` → encoded as `null`. **85 browser specs stayed green over a run view that rendered nothing at all** | `75872e9` |
| `checksOf`'s union | no fixture had a failed check that was not also in `ran`; deleting half the expression left 62 specs green | `6a310d1` |
| The no-factory notice | a server value and a client fallback back each other up, so emptying **either one alone** left all ten specs green | `db6f74c` |
| The Console's health assertion | it built its own engine rather than importing the CLI's, so it could not catch `ui.ts` regaining a runner address | `ff82902` |
| Ticket 38's rename | graded `Runnable.name`; the names that collide are the definition's `_tag` and its idempotency key. Restoring both left the tier green | `517dcd6` |

The shape they share: **a check that succeeds while doing no work.** After `dd774bd` the waves
stopped trusting a green and started asserting the work happened — non-zero counts, no file failed to
load, specs on disk equal to specs run, every skip named.

---

## 5. The verification ladder

Each rung was added after a specific failure, and none was there at the start.

1. **Run every moon task by name, with `--force`.** Discover the list; never hardcode it. Then
   `bun tsc --build --force --verbose` from the root, whose printed project list is the only proof a
   compile happened (`e3752b6`).
2. **Assert the work happened.** Non-zero test counts, no file failed to load, specs on disk equal
   to specs run, every skip named out loud.
3. **Break the proof.** Mutate the implementation and confirm the *named* test reddens. This is what
   caught most of §4's second half, and what every wave from 5 onward was required to do.
4. **Structured provenance.** Each criterion carries the test that grades it, plus a flag for
   whether the test grades *the thing itself* — and an explicit `arguedNotProven` list. Wave 5b
   exists only because wave 5 filled that list honestly.
5. **Adversarial verifiers** for tickets whose deliverable is evidence rather than code — 19, 28,
   29, 30, 36, 48. Every one of them refuted something. See §8.
6. **Check your own harness** against `/usr/bin/false` before trusting it. One integrator read
   `tail`'s exit status as moon's.
7. **The Docker faults are environmental, and wave 20 measured them more sharply than rung 7 did.**
   Three consecutive tier runs on one integrated tree failed on `lane.test.ts` and **failed on
   different tests each time** — once `leaves one sandbox record per rebuild` at 190 s, then
   `suspends inside its sandbox` at 187 s *and* `builds a container…` at 209 s — while the same tree
   had passed 262/0 an hour earlier. Two shapes, both known: `Test timed out in 180000ms`, and
   `exit 127 — OCI runtime exec failed … chdir to cwd ("/home/agent/workspace") … no such file or
   directory` with `containers: 3`. The tier took **503 s against its usual ~130 s**.

   What separates the daemon from the mount: `docker run --rm <image> /bin/true` was measured three
   times at **0.20–0.22 s**. Container *start* is fine; what fails is a bind-mounted worktree
   appearing inside the container. `docker container prune -f` reclaimed 0 B before the worst of the
   three runs, so it is not stale containers either.

   **The engine here is OrbStack, not Docker Desktop** — `docker context ls` shows `orbstack *`,
   `docker info` reports `orbstack | 29.4.0 | OrbStack | overlayfs`, and `orb version` is 2.2.2.
   Docker Desktop is a leftover context that nothing uses. An earlier revision of this entry named
   Docker Desktop and told the reader to restart it; that was wrong, and it is corrected here rather
   than deleted, because *assuming which container engine a Mac is running* is exactly the kind of
   unchecked premise this record exists to catch.

   A plain race was **ruled out by measurement**: twenty rounds of *create a nested directory under
   `/private/tmp`, then immediately bind-mount it and run* gave **0 failures in 20**. So the fault is
   not "the mount is not there yet". What fails is the **rebuild** path with three containers alive
   at once — `WorkspaceUnreachable{containers: 3}` — which is edge 11 and ticket 37, found by ticket
   19 on a real container and never fully closed. Ticket 50's lane measured it at **1 failure in 4
   with its change and 1 in 4 with the whole ticket stashed**, which is the control that keeps it
   out of any one change's account. A green tier is not evidence the fault is gone, and a red one is
   not evidence the tree is broken. Read the failing test's *shape* first: a 180 s timeout and an
   `exit 127 … chdir to cwd` are this, and an assertion mismatch is not.

   **And the load is what settled it.** The three failing runs all happened while eight wave agents
   had just finished hammering the same daemon. Run again on a quiet machine, with nothing else
   started and no restart of anything: **264 passed, 3 skipped, 0 failed, 150 s** — the tier's normal
   duration. So the remedy was neither a restart nor a fix; it was *stop running four container
   suites at once*. Anybody planning a wave on one machine should know that the integration tier is
   the part that does not parallelise, and should keep the container lanes serial.
8. **`docker container prune -f` before the integration tier.** Three stale containers made it 4.5×
   slower; the timeout that followed read as a test failure (`25d6148` settles that flake by
   measurement: four runs, three at 249/249, the failing tier 5m33s against 143s).

---

## 6. What only walking the loop found

Four times, an integrator stopped testing and used the product — stamp a factory, edit the commands,
run it, answer the gate in the browser, watch it merge. Each walk found something no suite did.

**Wave 7** — `kojo run` ran a hard-coded array of Kojo's own demos and listed them identically
inside and outside a stamped repository. The built-in `review` and the stamped `review` shared a name
*and* an idempotency key, and the built-in had no agent and no sandbox. The command the stamped
README teaches succeeded in milliseconds and invoked nothing. Under a five-call budget, that is the
likely outcome and it would have proven nothing (`d3d64af`).

**Wave 14** — four breaks, the worst invisible to 85 green specs (`f961cd6`): the Console rendered
nothing for a real run (`null` vs absent, 20 guards sharing the shape); `init` stamped no manifest
and no `effect` pin, so two copies of `effect` killed a run with a raw framework `TypeError` while
`doctor` called the factory ready; **no stamped starter merged at all**, so the loop stopped one step
short of the thing the whole design is for; and an expired asking waited in the queue for ever.

**Wave 15** — stamp, run `npm install` exactly as `init` instructs, and the first merge refuses:
*main holds uncommitted changes*. The uncommitted change is the `node_modules` that `init` told you
to create (`783033b`). Neither ticket 44 nor 45 could have seen it: 44's tests never merge, and 45's
build their own fixture repositories rather than following the printed instructions. The acceptance
criterion now says the test must follow the printed instructions.

**Wave 17's re-walk** — `kojo doctor` printed a remedy that **damaged the factory it diagnosed**
(`222764f`). Its `credentials` failure said to run `kojo init` again; following that literally writes
eight files, keeps seven, and takes `doctor` from one failed check to two — leaving the reader with a
factory that cannot run.

Also from wave 15's walk, and worth keeping: `.sandcastle/` is untracked in the repository a run
starts from, so the merge refused **every first run** (`40bb677`). Found by hand, not by the suite.

---

## 7. My own errors

Recorded here because three of them cost real work, and one cost the owner's money.

**I destroyed the wave-17 work in progress.** My `wip(kojo):` commit was rejected by cocogitto — the
type is not allowed — and I ran `git worktree remove --force` in the same **chained** command without
checking that the commit had succeeded. 34 files of work went with it. Recovered from a dangling
tree among 371 unreachable objects and rebuilt with `git commit-tree` → `5069bfc`, 2136 insertions,
committed unreviewed and labelled as such. This is exactly the unchecked-exit-status-before-a-
destructive-step mistake I had been flagging in the agents' own harnesses.

**I committed a trace database.** `.kojo/kojo.db` and its WAL sidecars, swept in by `git add -A`
after I ran the CLI from the repo root (`8baeab8`, untracked in `77cdf13`). Every `kojo` command run
from the root then dirtied the working tree, and the next wave's integrator had to decide whether a
diff it did not make mattered.

**I relayed a false assurance about spending, twice.** See §9.

**I proposed blocked tickets twice** — wave 1 (05 and 08, blocked by 04) and wave 5 (33, blocked by
12). After that the frontier was computed by script against the ticket files before every wave.

**I cited a stale smoke command for several waves.** `kojo run hello --who Kevin`. `--who` stopped
existing when ticket 12 made the payload positional, and the demo was later renamed `demo-hello`.
The command was failing on an unknown flag and I was reading the output above it.

---

## 8. Refuted proofs

Roughly one per wave. The pattern is not that the code was wrong — it usually held — but that the
*reason given for it* was not the reason the test graded.

| ticket | the claim | what mutation showed |
|---|---|---|
| 17 | `{ local: true }` on the sandbox memo map is load-bearing | Removing it leaves the whole unit tier green. `MemoMapImpl` keys on layer object identity and `layers(config)` builds a fresh Layer per call. Kept as a guard, no longer called a proof (`f09e72d`) |
| 19 | The sandbox-id sequence prevents a collision | Justified by eleven acquisitions inside one millisecond, which cannot occur: `retryOnInterrupt` advances virtual time between attempts. Kept because it costs one integer (`111775d`) |
| 19 | `fileParallelism: false` fixed the exit-127 rebuild fault | Did not reproduce. What fixed it was anchoring the fixture at `/tmp`: 3 of 4 failures under `TMPDIR`, 1 of 6 under `/Users`, 0 of 16 under `/private/tmp` (`111775d`) |
| 21 | The typed cause is compiler-graded | Swapping the definition method for the module function compiles clean. The explicit return type is what carries the error (`7050d72`) |
| 26 | Assets are mounted last, which keeps the API reachable | Swapping the `mergeAll` arguments leaves every test green. find-my-way ranks by route shape, not insertion order (`ff82902`) |
| 28 | Selection, hover and the tick-step table are graded | Three decisions implemented and ungraded. Each spec was then turned red by hand (`9c6103d`) |
| 29 | The route shape was "explicitly sanctioned by the ticket" | The ticket was silent; the sanction appears only in the branch's own edit to it. The decision stands on its own reasons (`6a310d1`) |
| 36 | Seven runs drove this work | One hand-authored commit did. Corrected in the re-walk |
| 36 | The `lane.test.ts` timeouts are pre-existing flakiness | Argued, not proven — until `25d6148` measured it |
| 48 | The repair re-sent the same sentence byte for byte | It rewrote it and moved the expected literal to the front. It failed by a hair, not by stubbornness — which changed which remedy to buy next (`20ed4ed`) |

The last one matters most as a method note: the audit that caught it read the same transcript that
bought the original claim, so **the correction cost nothing**. An unmeasured design must not replace
a measured one, and a misread measurement is not a measurement.

---

## 9. The real-agent ledger

**Eleven real invocations were spent. Ten were ever authorised.** Nine and eight until wave 20,
which spent two authorised calls on ticket 51.

Counted by walking all 348 `*.jsonl` under `~/.claude/projects/`, keeping the seven whose first
top-level prompt carries a stamped factory phase identity, then counting top-level prompts — user
turns that are not tool results. A correction is a second turn in the same session, so a corrected
run costs two.

| when (UTC) | prompts | model | which |
|---|---|---|---|
| 08-11 11:42 | 1 | `claude-sonnet-5` | ticket 15 |
| 08-11 11:45 | 1 | `claude-sonnet-5` | ticket 15 |
| 08-11 11:50 | **2** | `claude-sonnet-5` | ticket 15 — the correction loop |
| 08-11 11:54 | 1 | `claude-sonnet-5` | ticket 15 — the permission breach |
| **08-11 22:01** | **1** | `claude-sonnet-4-6` | **the wave-15 loop walk — unauthorised** |
| **08-11 22:37** | **1** | `claude-opus-4-8` | **the wave-16 loop walk — unauthorised** |
| 08-13 09:31 | **2** | `claude-sonnet-5` | ticket 48 |
| 08-14 16:06 | 1 | `fable` | ticket 51 — the first answer decoded, so there was no repair |
| 08-14 16:11 | 1 | `fable` | ticket 51 — the same, with the prose rule sharpened |

The two unauthorised calls: both walks intended a scripted stand-in and put a shell script named
`claude` on the child's `PATH`. The agent is a child process Sandcastle spawns, and both times it
resolved the real binary instead. `--model` on each walk's `kojo init` matches its row exactly.

**The mechanism, and why nobody caught it.** `KOJO_REAL_AGENT` gates the real-agent **test**. It
appears nowhere in `packages/kojo/src/`. It has never gated the CLI. So both integrators reported
*"`KOJO_REAL_AGENT` was never set"* and *"no real agent call was made"*, and the first half was true
while the second did not follow. I launched both waves, wrote the briefs that said not to spend,
chose a flag as the guard without reading whether the code honours it, and relayed both assurances
onward as fact (`3d1fe7f`).

Ticket 49 is the guard that was mistaken for a flag: a switch the **invoker** honours, refusing
before a process is spawned, on by default wherever this repo runs unattended. Every other invariant
in this build that mattered was made structural. This one was a convention, and the convention is
what failed.

**It landed on 2026-08-13, and it cost nothing to prove.** `KOJO_AGENT_SPEND` is read by
`SandcastleAgentInvoker` before `sandbox.agent`, and an unattended process — no terminal on stdin —
is refused by default, which is every Vitest worker, Playwright fixture, CI step and agent-driven
shell without anybody configuring it. The third mode is the one that matters:
`stand-in:<absolute path>` means *a process may run, and here is the only file it may be*, and the
invoker resolves the binary name itself rather than trusting a `PATH`. **Both calls in the table
above would have been refused by it** — each put a script named `claude` in front of the operator's
own and each resolved the real one, which is a mismatch a comparison catches and an intention never
could. Three mutations, each reddening its named test: delete the resolution comparison, flip the
unattended default to allow, and move the refusal to after the spawn. The last is graded by an
**empty prompt log**, which is what turns *"before a process was spawned"* into a measurement.

**Two `pi` invocations were also made, by a lane agent, and neither was authorised.** Both were
refused by Anthropic before a token was billed — `400 invalid_request_error: "You're out of extra
usage…"`, zero in, zero out — so they cost nothing, and the mechanism is the finding rather than the
bill. One was a layout probe, run in the belief that no credential existed. The other was a
**correct** mutation — flipping `runnable` to prove the gate still bites — which un-skipped the paid
`describe`. `kojoPiRealSession.test.ts` spawns the binary itself, so `KOJO_AGENT_SPEND` never sees it:
ticket 49's guard lives in `SandcastleAgentInvoker` and only there, and ticket 55 is the other half.
The second lesson is worse than the first: **pi on this machine authenticates from its own store**,
with neither environment variable set, so that suite's gate measures *somebody exported a variable*
rather than *this binary can reach a model*.

Remedy 1 of ticket 48 is built and did not settle the question. `correctionFor` now says a literal
field's whole value must **equal** one of the listed words with nothing before or after it — and the
two calls that were meant to test it never reached a correction at all, because `fable` read the
rendered contract and obeyed it on the first turn, twice. **A contract rendered into the prompt beats
a rule written in prose**, which is a better finding than the criterion it was bought for and leaves
that criterion open. The remaining authorisation is still unspent, and what it should buy now is a
decode failure a *correction* can undo rather than one a *prompt* can cause.

---

## 10. Where the build stopped

**As of 2026-08-14, after wave 20:** 50 tickets landed, 1 closed wontfix, 5 open. Unit **627**,
integration **262 passing** with three named skips, browser **96**. Three projects in the `tsc` build.
`bun biome check .` and `bun knip` clean.

Tickets 50–53 were not new work anybody thought of; they are criteria that closed
tickets left unchecked and no other ticket took — the sandbox mount (from 14), a repaired envelope
that decodes (15 and 48), a real `pi` session resume (18), and the waterfall over concurrent lanes
(35). **A closed ticket with an open box is work with no owner**, and the way to find them was to
read every box in every closed ticket rather than the status line at the top.

Wave 20 built them and opened three more (54–56), each found by doing the work rather than by
planning it: a file created at the **root** of `.kojo/` is caught by neither line of defence, because
no entry of `factoryOwnPaths` is `.kojo/` itself; a test that spawns a provider binary itself is
outside the spend guard, which is how two `pi` calls were made on the day the guard landed; and
`--session-dir` makes pi's layout flat while Kojo reads an encoded directory, so a resumed turn would
silently fall back to a cold start — the fault the whole capture half exists to prevent, arriving
through the flag added to prevent it.

The two agent-facing skills sit at `.agents/skills/`, with `.claude/skills/kojo` a symlink to it.
`skillsDirectory` is unchanged at `.claude/skills/kojo` — that is what `kojo init` stamps into a
repository and what `ownFactory.test.ts` reads — so the link is what lets one copy of each file
answer both conventions.

[§12 of typescript-effect.md](design/typescript-effect.md) carries the authoritative version of what
is and is not proven. The four things most worth knowing before picking this up:

1. **The most load-bearing unproven thing in the build** — now ticket 51: no repaired envelope has
   ever decoded, so no `corrections` counter has been read off a *succeeded* phase. No stand-in can close it — a
   repair resumes the captured provider session, so a scripted repair always dies
   `resumeSession not found`. This is why ticket 48 needed real money at all.
2. **No lane of Kojo's own factory can grade Kojo**, because `.kojo/` sits outside the
   `bun tsc --build` that every lane's typecheck runs (`222764f`).
3. **Two upstream faults are recorded, not fixed** (`architecture.md` §8 edges 12 and 13): a run with
   two gates open at once cannot be resumed one gate at a time, measured on both engines; and the
   cluster's own migrator wraps itself in `Effect.orDie`, so a lock it loses arrives outside every
   error channel — worked around by `SqliteDatabase.firstRun` rather than caught (`a314ed8`).
4. **Mutation was run on the load-bearing mechanisms, not on all of them** (`9ad82b2`). The
   seven-day durable sleep is `TestClock`; what a calendar would test is the branch and the trace row
   surviving process death, and that is what was actually tested.

The build corrected roughly one overstated proof per wave, **including in its own last wave**. Read
that as the working rate, not as a phase that ended.
