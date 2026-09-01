# Console design

The Console is a Daemon-owned operator view. `kojo ui` requests the launch and returns. The
browser reads the Daemon HTTP API.

## Views

- Project and Workflow availability.
- Run activity, status, and captured Revision.
- Gate queue and answer form.
- Daemon health and actionable faults.

The Console does not serve files from a terminal-owned application. It does not open SQLite and
does not execute or resume Runs.

## Gate answers

The Console records an answer through the Daemon API. The Daemon validates the token and choice,
persists the transition, and applies it through the owning Runner. The response reports the durable
Gate state. The Console can reconnect and read the same state.

## Health

Health reports the Daemon, store, Runner, and Project facts separately. An empty Run list is an idle
state. It is not proof that execution is unavailable.

## Security

The Daemon binds to the local endpoint selected by its lifecycle contract. Clients authenticate
with the per-user transport contract. Console assets and API responses are served by the same
Daemon authority.
