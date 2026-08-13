# 29 — The detail panel

**What to build:** Clicking a span opens everything known about it beside the waterfall, without losing the position it was clicked from. This is where investigation actually happens, and it has two subjects: a phase, or a sandbox acquisition.

**Blocked by:** 28

**Status:** done

- [x] The panel is a nested route, so a phase is deep-linkable and pasteable while the waterfall stays on screen
- [x] A phase shows its identity, its agent and model and session and tokens, its envelope verdict and checks and corrections, its effect on the repository, and where it ran
- [x] The rendered prompt, the captured session, and the diff are fetched on demand
- [x] A sandbox acquisition shows its provider, image, branch, worktree, hooks, timings, and which phases ran inside it
- [x] Occurrences stream into the panel while a phase is in flight and are listed once it is not
- [x] One missing artifact degrades that pane only — a deleted branch does not fail the whole panel

## Comments

**The route addresses the phase's `name/attempt` suffix, not the whole phase id.** A phase id is
`<run>/<name>/<attempt>`, so `/runs/:runId/phases/:phaseId` needs percent-encoding and produces
`/runs/run-merged/phases/run-merged%2Fhotfix%2F1` — the run named twice, the second time unreadably.
Both shapes were measured against the real server before choosing (a `%2F` deep link is served the
shell, and the API already takes an encoded id in one segment), so this is a choice about the URL and
not a workaround. `/runs/run-merged/phases/hotfix/1` is what a person pastes into a chat, it cannot
name two different runs, and every segment of a Kojo identifier is `[A-Za-z0-9._-]+` by the trace's
own guard, so nothing ever needs escaping. The cost is that the browser now knows the id grammar; it
is written down once, in `contexts/trace/models/ids.ts`, beside the sandbox-id reading the waterfall
already needed. The sandbox route splits on the same rule.

> **Integration correction.** The implementer's report justified this as a deviation "the ticket
> explicitly sanctioned". It did not — the ticket as written was silent on routes, and the sanction
> appears only in this branch's own edit to this file. The decision stands on its three reasons
> above, which are good; the claim of prior authorisation was not. `docs/design/console.md` §3 has
> been updated to the routes actually shipped, so no later ticket builds against a route table that
> the code contradicts.

**The URL is the subject and the Solux store follows it.** A span's click navigates; the route mounts
the panel; the panel dispatches `selected` (or `scoped`) and the waterfall draws the ring. One
direction, so a deep link selects without a click and the two can never disagree. Ticket 28's
selection test still grades the same observable behaviour.

**Two things console.md §6 names are not in the trace, and the panel says so rather than inventing
them.** A `SandboxRecord` carries no image digest and no record of which hooks ran — hooks live on
the *request* a scope makes, and no provider resolves a digest per acquisition. The panel shows the
run record's `imageDigest` under a heading that says it is the run's, and states outright that the
trace records no hook run. §6's *parent phase id* and *owner* are likewise not columns on
`PhaseRecord`; identity shows what the record has.

> **Carried to ticket 30.** *Parent phase id*, *owner*, a per-acquisition *image digest* and a record
> of *which hooks ran* are four things console.md §6 asks a panel to show that no trace record
> carries. The panel is right to say so rather than invent them, and nothing here is a Console bug.
> Closing any of them is a trace-schema change — a field, a migration and a writer — and a later
> ticket that wants one must budget for that rather than expect the panel to grow it.

**A check can fail without ever joining the checks that ran, and now something proves the panel
shows it.** `checksOf` renders `ran ∪ (failed \ ran)`. The verifier found that no fixture exercised
the second half — every fixture wrote a failed check into `ran` as well — and confirmed the union
could be deleted with the whole suite still green. Reproduced at merge (62 passed with the union
gone), then closed: `run-broken/implement/1` now carries a check that threw instead of returning a
verdict, so it is in `failed` and never joined `ran`. With the union deleted that spec, and only
that spec, now fails.

**Fixtures gained their other half:** occurrences for three phases (one in flight), an artifact map
written for its absences, a run whose envelope never decoded, a phase that claimed more than it
changed, an image digest, and `contextTokens` on two agent calls.

**A 404 is now an answer.** `fetchJson` throws a typed `ApiError`; the query client does not retry a
4xx; `useRun`'s poll interval stops on one as well — both halves are needed, and both are graded.
