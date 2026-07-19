# Pin runs to exact Workflow Revisions

Every Workflow Run will be pinned to the stable name, declared version, and source fingerprint of
the Developer Workflow that started it. Kojo will refuse to resume a run with incompatible workflow
code; the engineer must restore the matching revision, provide an explicit migration, or discard
the run and start again.

For repository-local workflows, `Workflow.make` declares a repository-local TypeScript entry point.
Kojo computes the source fingerprint as SHA-256 over a canonical manifest of that entry point's
complete statically reachable closure: normalized logical paths, file-content digests, reachable
package versions and lockfile entries, loader and toolchain versions, and Kojo's Workflow ABI. The
complete lockfile digest is retained as provenance but does not affect compatibility when only
unrelated dependencies changed. Kojo rejects unresolved dynamic imports, native add-ons, and other
closure elements it cannot reproduce safely.

Durable activities make resumption possible, but changing control flow around persisted activity
results can silently change the meaning of a run. Explicit revision compatibility makes that risk
visible instead of replaying old evidence through new code.

## Considered Options

- Resume using whichever workflow code is currently discovered.
- Pin only to a human-maintained version string.

## Consequences

- Kojo must capture a reproducible source fingerprint when starting a run.
- Workflow discovery must distinguish stable workflow identity from its revision.
- Unrelated workflows and dependencies do not affect a workflow's revision.
- Migration is an explicit operation rather than an accidental effect of redeploying workflow code.
- The CLI and visualizer can explain why a run is resumable, incompatible, or restart-only.
