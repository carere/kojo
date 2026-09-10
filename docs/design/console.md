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

## Run list and detail

The Console has no dedicated Project catalogue, Workflow catalogue, Gate queue, or Daemon page.
The Run start form reads Project and Workflow context. Management remains available through the CLI.
The Run list keeps search and status filters. It has no bulk selection or column controls. Detail
lists keep search and progressive loading when needed, with no selection counters.

The Waterfall groups Phases by Sandbox acquisition. Overlapping Phases occupy separate visual lanes
inside the same scope. The timeline scrolls within its own card on narrow screens. It does not cover
Invocation detail while the operator scrolls the page. Only an unresolved external action shows the
uncertainty warning and retry controls. A confirmed result does not imply unresolved work.

The Console does not open SQLite and does not execute or resume Runs. It reads Daemon snapshots and
sends explicit client commands.

## Gate answers

The Console records an answer through the Daemon API. The Daemon validates the token and choice,
persists the transition, and applies it through the owning Runner. The response reports the durable
Gate state. The Console can reconnect and read the same state.

## Health

Connection status and Run faults identify the affected Daemon, Runner, or Project. An empty Run
list is an idle state. It is not proof that execution is unavailable.

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

## Agent invocations

Run detail keeps each physical agent call separate. Corrections and parallel calls have distinct
Invocation identities. Each expandable record shows retained prompts, their delivery roles, ordered
public tool activity, visible output, usage, and cost. Snapshots update open details without closing
them. The list uses the last retained activity time when it shows a Run's last update.

The live clock applies only to executing Invocations. An interrupted Invocation without a known end
time shows its last observed duration and states that the end time is unavailable. Provider usage
can be absent. Fresh input, cache reads, cache writes, output, and reported context measurements stay
separate. Reported charges and API estimates have separate totals; incomplete totals are marked
partial. Estimates state their provider basis. The Console never treats cumulative input as current
context use. Older Phase token counters are not shown because they cannot distinguish missing data
from zero.
