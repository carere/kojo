---
status: accepted
---

# Use one on-demand Project Runtime per Kojo Project

Kojo uses one on-demand Project Runtime process as the local execution owner for each Kojo Project. Keeping this owner independent of the CLI and visualizer lets Workflow Runs outlive either client, while project-scoped ownership avoids a permanent global daemon and provides one authority for project-local execution state.

## Considered Options

- Making the visualizer server the owner would prevent CLI-only use and couple execution lifetime to the UI.
- Making each invoking client the owner would endanger active work when its terminal or browser-side session exits and would make cross-client control difficult.
- Using a permanent global daemon would introduce machine-wide registration and lifecycle concerns that the local-first v1 does not need.
- Giving every Workflow Run a separate owner would require cross-process coordination for shared project state and duplicate the control surface.

## Consequences

- The first CLI or visualizer-server request starts the Project Runtime automatically. All history, inspection, and lifecycle controls go through the runtime rather than reading or changing execution data directly.
- The runtime acquires an operating-system lock for the Kojo Project, listens on a random loopback port, and atomically publishes a project-local Runtime Locator containing its endpoint and unique runtime identity. Competing starters wait for the lock holder and use its locator.
- Different Workflow Runs may execute concurrently without a fixed v1 limit. One internal coordinator orders each run's commands, state changes, and Execution Events.
- The runtime durably records run ownership before starting external work and records stop intent before interrupting it. Client disconnection does not stop an active Workflow Run.
- The runtime exits after 30 seconds with no active Workflow Run, in-flight request, or open trace stream. A new request resets the timer.
- After a crash, the next client replaces the stale locator only after acquiring the project lock and starts a runtime with a new identity. Workflow Runs owned by the dead runtime become interrupted and cannot continue; process-local Sandcastle handles are never adopted. Starting again creates a new Workflow Run.
- Later decisions define the exact locator path, RPC methods, durable schema and lifecycle states, and local endpoint security.
