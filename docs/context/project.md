# Project

How a host knows which repositories Kojo manages. A project identifies the repository where Kojo
expects to find a factory for the current OS user.

## Language

**Daemon**:
The single long-lived Kojo process and state owner for one OS user on one Host.
_Avoid_: server, worker

**Daemon data**:
The durable database and files owned by a Daemon, independent of every registered Project path.
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
or completion before a Daemon lifecycle operation. It is separate from an automation pause.
_Avoid_: automation pause, Run cancellation, Gate suspension

**Managed Daemon release**:
An immutable installation of exact Kojo and Bun versions retained independently of the global CLI
installation. One release is active; other retained releases can support activation or recovery.
_Avoid_: global Kojo, Project execution package, Workflow Revision

**Daemon lifecycle operation**:
A durable request to change the Daemon's service or active managed release. Its identity and
outcome survive the requesting client and the replacement of a Daemon instance.
_Avoid_: Run, client connection, Daemon drain

**Daemon lifecycle controller**:
The exclusive owner of a Daemon lifecycle operation across Daemon instance replacement. Its
authority covers service and installation transitions, not Run execution or Daemon database access.
_Avoid_: Daemon, Project Runner, native service manager

**Project**:
A durable registration that identifies one repository location for the current OS user on one
Host. Its factory can be available, missing, or invalid; the Project is not the factory itself.
_Avoid_: factory, workspace, Moon project

**Project ID**:
The stable identity of a Project inside one Daemon. It does not change when the repository location
changes or becomes unavailable.
_Avoid_: repository path, factory name

**Project Runner**:
The replaceable execution owner for one Project. A Project and its Runs keep their identities when
their Project Runner stops or is replaced.
_Avoid_: Daemon, worker, server

**Project execution package**:
The versioned package that supplies a Project's Factory authoring contract and its Project Runner.
Its version can differ from global Kojo when their execution protocols are compatible.
_Avoid_: global Kojo, Project Runner process

**Project Runner instance ID**:
The opaque identity that the Daemon gives to one Project Runner process lifetime. A replacement
Project Runner gets a new instance ID.
_Avoid_: process ID, Project ID, runner name

**Resource lease**:
A Daemon-owned durable record of the intended acquisition, ownership, and confirmed release of a
resource used for Project execution. It remains relevant after its Project Runner stops.
_Avoid_: Run Claim, Sandbox record, process lifetime

**Project recovery**:
The reconciliation of a Project's execution resources and ownership before a replacement Project
Runner can accept work. An unresolved resource risk can prevent execution without changing the
Project's location or Factory validity.
_Avoid_: Factory Refresh, Project restoration, Run retry

**Project location**:
The canonical absolute Host path of the exact Git working tree that the user registered for a
Project. The user changes or confirms it explicitly; two linked Git worktrees are two Projects,
even when they share Git objects.
_Avoid_: Project ID, workspace

**Available Project**:
An active Project whose confirmed location Kojo can use. Availability of the Project does not imply
that its Factory or Project Workflows are available.
_Avoid_: healthy Project, Available Factory

**Unavailable Project**:
An active Project whose location cannot be used or whose restored location waits for user
confirmation. Its Project ID and history remain available.
_Avoid_: unregistered Project, Archived Project

**Archived Project**:
A Project that the user removed from the active catalogue without deleting its Project ID or
history. It has no active location until the user explicitly restores it.
_Avoid_: deleted Project, Unavailable Project
