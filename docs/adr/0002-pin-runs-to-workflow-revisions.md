# Pin runs to exact Workflow Revisions

Every Workflow Run will be pinned to the stable name, declared version, and source fingerprint of
the Developer Workflow that started it. Kojo will refuse to resume a run with incompatible workflow
code; the engineer must restore the matching revision, provide an explicit migration, or discard
the run and start again.

Durable activities make resumption possible, but changing control flow around persisted activity
results can silently change the meaning of a run. Explicit revision compatibility makes that risk
visible instead of replaying old evidence through new code.

## Considered Options

- Resume using whichever workflow code is currently discovered.
- Pin only to a human-maintained version string.

## Consequences

- Kojo must capture a reproducible source fingerprint when starting a run.
- Workflow discovery must distinguish stable workflow identity from its revision.
- Migration is an explicit operation rather than an accidental effect of redeploying workflow code.
- The CLI and visualizer can explain why a run is resumable, incompatible, or restart-only.
