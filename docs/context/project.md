# Project

How a host knows which repositories Kojo manages. A project identifies the repository where Kojo
expects to find a factory for the current OS user.

## Language

**Project**:
A repository path registered with the Kojo daemon on one host. Its factory can be available,
missing, or invalid; the project is not the factory itself.
_Avoid_: factory, workspace, Moon project
