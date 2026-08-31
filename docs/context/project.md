# Project

Which repositories Kojo manages, and how their execution ownership and resource safety are
established. A Project identifies the repository where Kojo expects to find a Factory.

## Language

**Project**:
A durable registration that identifies one repository location for the current OS user on one
Host. Its factory can be available, missing, or invalid; the Project is not the factory itself.
_Avoid_: factory, workspace, Moon project

**Project ID**:
The stable identity of a Project inside one Daemon. It does not change when the repository location
changes or becomes unavailable.
_Avoid_: repository path, factory name

**Project Runner**:
The replaceable execution owner for one Project, under the Daemon's authority. A Project and its
Runs keep their identities when their Project Runner stops or is replaced.
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
