# Delivery Developer Workflow

This private workspace package is Kojo's optional, repository-local `delivery` Developer Workflow
example. It is deliberately separate from `@kojo/workflow`: delivery policy belongs to workflow
authors, not Kojo core.

The workflow accepts `{ workstream: "https://github.com/OWNER/REPOSITORY/issues/NUMBER" }`. Provide
the `GitHubDelivery` Effect service with an adapter that loads the root's complete native child and
blocker graph, proves that the declared source revision is reachable, reads publication state, and
performs exact guarded pushes and idempotent ticket closure.
It also reconciles final local/remote target state, owned recovery state, ticket mutations, Sandbox
cleanup, and managed pull requests before it creates or updates the final draft pull request.
The workflow validates and pins that graph before returning one of these typed outcomes:

- `NothingToDo` when the root has no children.
- `AlreadyComplete` when every child is closed.
- `OpenWorkNoReadyTicket` when open work exists but every open ticket is blocked.
- `OpenWork` with up to two ready tickets selected in publication-key order and their published
  outcomes.
- `TicketsFailed` after all already-started tickets settle when any selected ticket cannot be
  reviewed, integrated, verified, or published.
- `CompletedWorkstream` after the last handled ticket, a fresh exact-target verification, final
  publication, and one validated draft pull request all converge.
- `AlreadyComplete` when that exact final publication and draft pull request were already applied.
- `InvalidDeliveryWorkstream` when routing, identity, relationship, or graph invariants fail.

Each successful outcome carries schema-validated evidence for the normalized input graph, routing,
specifications, source revision, eligible work, exclusions, and frontier decision. Invalid graphs
carry typed diagnostics and retain the decoded graph when one was available. No Sandbox or Agent
is created before loading and validation succeeds.

Selected tickets run concurrently as keyed Child Workflows. Each uses one Reusable Sandbox created
from the exact target commit. An implementer must leave a non-empty committed change with proven
ancestry and a clean worktree before deterministic `moon run :check`, `moon run :tsc`, and
`moon run :test` Code Steps run. A mechanically read-only reviewer receives the cumulative diff
and complete finding history. P1, P2, and P3 findings return to the implementer with an `Addressed`
disposition, and the checks repeat before the next review.

Zero findings produces `Implemented`. Three Reviewer Steps with remaining findings produces the
ticket outcome `ReviewLimitReached`, retaining the shared `Loop.MaximumLimitReached` failure and
the full finding/disposition history. Other ticket failures become `TicketFailed`, allowing
an already-started sibling ticket to settle and retain its own outcome and evidence.

Reviewed tickets integrate serially from the captured target HEAD. Every successful integration is
an exact two-parent `--no-ff` merge of that expected HEAD and the reviewed commit. Conflicts route
through a bounded, mechanically read-only integration Review Loop and repeat the configured
commands without changing either accepted parent. The resulting commit is opened and verified in a
fresh Reusable Sandbox before publication.

Publication reloads and validates the workstream and ticket, then reads mutable target and ticket
state before each write. Push and close operations carry stable idempotency keys and expected-state
guards, and the workflow reads their results back before recording `Published`. A moved target or
drifted specification fails only that ticket; reviewed issue branches and open tickets remain
intact while other already-started successes are still published.

After every ticket is handled, the workflow reconciles interruption state and preserves any
ambiguous or unowned dirty state for a person. It verifies the exact final target in a fresh
Reusable Sandbox, pushes only that verified commit, and asks an Agent to author a schema-validated
conventional-commit-style title and evidence-bearing description. Mechanical checks require the
exact route and commit, configured verification receipts, ticket commits, review counts,
publication receipts, and exactly `Closes #<root>`. The workflow then safely creates or updates one
owned draft pull request from target to destination; only human merge closes the still-open root.

To opt in, statically import `Delivery` from `packages/delivery-workflow/src/index.ts` in the
repository's `kojo.config.ts` and include it in `defineConfig({ workflows: [...] })`. The GitHub
adapter remains repository-controlled and replaceable in tests or production.
