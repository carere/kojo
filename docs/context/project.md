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
A repository path registered with the Kojo daemon on one host. Its factory can be available,
missing, or invalid; the project is not the factory itself.
_Avoid_: factory, workspace, Moon project
