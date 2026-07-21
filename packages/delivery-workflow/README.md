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
- `OpenWork` with the deterministic ready frontier in publication-key order.
- `InvalidDeliveryWorkstream` when routing, identity, relationship, or graph invariants fail.

Each successful outcome carries schema-validated evidence for the normalized input graph, routing,
specifications, source revision, eligible work, exclusions, and frontier decision. Invalid graphs
carry typed diagnostics and retain the decoded graph when one was available. No Sandbox or Agent
is created by this loading and validation stage.

To opt in, statically import `Delivery` from `packages/delivery-workflow/src/index.ts` in the
repository's `kojo.config.ts` and include it in `defineConfig({ workflows: [...] })`. The GitHub
adapter remains repository-controlled and replaceable in tests or production.
