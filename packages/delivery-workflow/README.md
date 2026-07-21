# Delivery Developer Workflow

This private workspace package is Kojo's optional, repository-local `delivery` Developer Workflow
example. It is deliberately separate from `@kojo/workflow`: delivery policy belongs to workflow
authors, not Kojo core.

The workflow accepts `{ workstream: "https://github.com/OWNER/REPOSITORY/issues/NUMBER" }`. Provide
the `GitHubDelivery` Effect service with an adapter that loads the root's complete native child and
blocker graph and proves that the declared source revision is reachable from the target branch.
The workflow validates and pins that graph before returning one of these typed outcomes:

- `NothingToDo` when the root has no children.
- `AlreadyComplete` when every child is closed.
- `OpenWorkNoReadyTicket` when open work exists but every open ticket is blocked.
- `OpenWork` with up to two ready tickets selected in publication-key order and their final ticket
  outcomes.
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

To opt in, statically import `Delivery` from `packages/delivery-workflow/src/index.ts` in the
repository's `kojo.config.ts` and include it in `defineConfig({ workflows: [...] })`. The GitHub
adapter remains repository-controlled and replaceable in tests or production.
