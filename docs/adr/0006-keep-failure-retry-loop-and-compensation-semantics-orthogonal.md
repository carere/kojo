# Keep failure, retry, Loop, and compensation semantics orthogonal

Kojo will preserve Effect's separation between observed results, Typed Failures, Defects, and
interruption while adding durable identity, evidence, and explicit recovery policy. Workflow
authors opt into Activity Retry and Resumable Failures; every `Loop.run(name, options)` uses the
shared `Loop.MaximumLimitReached` Typed Failure; and compensation remains Effect Workflow behavior
rather than a competing Kojo primitive.

## Considered Options

- Automatically retry broad classes of operational failures or reset retry budgets when a Workflow
  Run resumes.
- Model unsuccessful command results, Typed Failures, Defects, suspension, and interruption through
  one generic failure abstraction.
- Provide a specialized Review Loop primitive and `ReviewLimitReached` failure.
- Add a Kojo compensation API with semantics separate from Effect Workflow.

## Consequences

- Unsuccessful observed results remain data. Unhandled Typed Failures and Defects move a Workflow
  Run to Failed, while suspension and unexpected execution-owner loss remain distinct lifecycle
  events.
- `Agent.run` and `Command.run` may accept explicit Activity Retry policy; custom durable operations
  use Effect's `Activity.retry`. Attempt budgets include the initial attempt, persist across
  Execution Attempts, and use explicit durable backoff.
- An Uncertain Activity Outcome blocks retry until reconciliation confirms non-occurrence. A
  Resumable Failure uses a tag-keyed Recovery Handler, and Defects are never resumable.
- `Loop.run(name, options)` uses an explicit stable name, a positive maximum, and one-based
  iterations. A Review Loop is ordinary named Loop usage, not another API or failure type.
- Compensation is idempotent and evidenced, runs in reverse registration order after terminal
  failure, and completes before the Workflow Run becomes Failed. It is not triggered by suspension,
  interruption, or discard.
- Retry exhaustion preserves the final Typed Failure; the journal records exhaustion and every
  attempt instead of replacing the actionable cause with a generic error.
