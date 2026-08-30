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

**Project**:
A durable registration that identifies one repository location for the current OS user on one
Host. Its factory can be available, missing, or invalid; the Project is not the factory itself.
_Avoid_: factory, workspace, Moon project

**Project ID**:
The stable identity of a Project inside one Daemon. It does not change when the repository location
changes or becomes unavailable.
_Avoid_: repository path, factory name

**Project location**:
The canonical absolute Host path of the exact Git working tree that the user registered for a
Project. The user changes or confirms it explicitly; two linked Git worktrees are two Projects,
even when they share Git objects.
_Avoid_: Project ID, workspace

**Unavailable Project**:
An active Project whose location cannot be used or whose restored location waits for user
confirmation. Its Project ID and history remain available.
_Avoid_: unregistered Project, Archived Project

**Archived Project**:
A Project that the user removed from the active catalogue without deleting its Project ID or
history. It has no active location until the user explicitly restores it.
_Avoid_: deleted Project, Unavailable Project
