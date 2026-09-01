# TypeScript and Effect design

## Process model

Kojo has one per-user Daemon. The lifecycle manager installs, starts, stops, and reports that
Daemon. CLI commands use the versioned HTTP API. The Console uses the same API.

The Daemon constructs the SQLite layer once. Repository-local clients never construct storage,
Sharding, or Workflow execution layers.

## Runtime model

Factory source imports deep paths from `@carere/kojo-runtime`. A Workflow bundle provides a
definition and its Effect Layer. The Daemon captures exact source, assets, resolved packages, and
Effect identity as a Workflow Revision before a Run can start.

The private Runner loads only captured Revisions. It executes `effect/unstable/workflow` programs,
records activity, and recovers suspended Runs. Trigger is a runtime port that can supply events to
the Runner. It is not a CLI polling service.

## Client commands

```text
kojo daemon install|start|stop|status|logs
kojo project register|list|status|relocate|archive|restore|configure|repair
kojo workflow list|status|start|stop
kojo run list|status|cancel|resume
kojo gate list|answer
kojo ui
```

`workflow start` accepts a JSON payload. `run` only manages existing Runs. `ui` launches the
Daemon-hosted Console and returns.

## Errors

Expected failures use typed error channels. Process ownership, unavailable Revisions, invalid
payloads, and Gate conflicts have stable API errors. Removed legacy surfaces are parse, resolution,
or export failures. They are not compatibility redirects.

## Package checks

The package graph has no barrels. Type declarations must not leak `Effect<any, any, any>`. Knip
must report no dead compatibility surface.
