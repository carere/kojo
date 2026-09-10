# Console design

The Console is a Daemon-owned operator view. `kojo ui` requests the launch and returns. The
browser reads the Daemon HTTP API.

## Views

The launch URL and home page open the Run list. Its rows show the Project, Workflow, status,
current activity, Gate waiting state, and last recorded update. The operator can start a Workflow
from an expandable form on that page. Stopping Workflow activity does not cancel admitted Runs.

Run detail shows Phase progress, captured Revision details, results, actionable faults, and the
Gate answer form beside the affected Run. The navigation contains the Run list entry.

An executing Run can show several active Phases. Completing one Phase does not remove its siblings.
The Console reads these observations from the authoritative Run snapshot. Reconnect restores them;
a non-executing Run cannot display a growing active span.

## Resource list composition

Projects and Workflows use the local Zaidan Data Grid and Filters composition. Their row models use
TanStack Table. Native controls keep the filters, row selection, links, actions, and pagination in
the keyboard order. The table wrapper owns horizontal overflow on narrow layouts; the document does
not scroll sideways.

Two deliberate custom gaps remain. Runs use a status table because their waiting reason and live
state are already one ordered projection. Gate uses a grouped table because waiting and settled
Askings must remain separate while they share one filter and page. Both gaps use the same Zaidan
table primitives, filter shape, pagination state, keyboard controls, and narrow-layout overflow.

The Console does not serve files from a terminal-owned application. It does not open SQLite and
does not execute or resume Runs.

## Gate answers

The Console records an answer through the Daemon API. The Daemon validates the token and choice,
persists the transition, and applies it through the owning Runner. The response reports the durable
Gate state. The Console can reconnect and read the same state.

## Health

Health reports the Daemon, store, Runner, and Project facts separately. An empty Run list is an idle
state. It is not proof that execution is unavailable.

## Daemon connection

The Daemon sends best-effort invalidation notices when durable state changes. Each notice tells the
Console to read an authoritative snapshot. A slow notification reader is disconnected and does not
delay Run execution. Notification requests have no HTTP idle timeout, so a quiet Phase does not
force a Console reconnect. Ordinary API requests retain their timeout.

Each snapshot request has a five-second limit. The Console retries an unreachable Daemon twice,
after one second and two seconds. Thus, one reconnect attempt ends in less than twenty seconds. If
it cannot connect, the Console keeps the last snapshot, shows an explicit Reconnect action, and
disables all mutations. It sends no more snapshot requests until the operator selects Reconnect.

## Security

The Daemon binds to the local endpoint selected by its lifecycle contract. Clients authenticate
with the per-user transport contract. Console assets and API responses are served by the same
Daemon authority.
