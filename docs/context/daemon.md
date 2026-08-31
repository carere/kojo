# Daemon

The per-user Kojo service, its managed releases, and the operations that change its lifecycle.
Lifecycle operations remain identifiable when a Daemon instance stops or is replaced.

## Language

**Daemon**:
The single long-lived Kojo process and state owner for one OS user on one Host.
_Avoid_: server, worker

**Daemon data**:
The durable state and retained content owned by a Daemon, independent of every registered Project
location.
_Avoid_: machine state, Project data

**Daemon instance ID**:
The identity of one Daemon process lifetime. A replacement Daemon gets a new instance ID without
changing the identity of its retained Daemon data.
_Avoid_: process ID, Project Runner instance ID, Daemon data identity

**Daemon data identity**:
The identity of one lifetime of retained Daemon data. It survives Daemon restarts, changes after a
data purge, and scopes client request identities so old requests cannot become new work.
_Avoid_: Daemon instance ID, Project ID

**Daemon drain**:
A planned hold on further Run dispatch across all Projects while executing Runs reach suspension
or completion before a Daemon lifecycle operation. It is separate from stopping a Workflow's Trigger.
_Avoid_: Workflow stop, Run cancellation, Gate suspension

**Managed Daemon release**:
An immutable installation of exact Kojo and runtime versions retained independently of the global
CLI installation. One release is active; other retained releases can support activation or recovery.
_Avoid_: global Kojo, Project execution package, Workflow Revision

**Daemon lifecycle operation**:
A durable request to change the Daemon's service or active managed release. Its identity and
outcome survive the requesting client and the replacement of a Daemon instance.
_Avoid_: Run, client connection, Daemon drain

**Daemon lifecycle controller**:
The exclusive owner of a Daemon lifecycle operation across Daemon instance replacement. Its
authority covers service and installation transitions, not Run execution or Daemon database access.
_Avoid_: Daemon, Project Runner, native service manager
