# Workflow Authoring

Workflow Authoring describes how a developer makes workflows and sandbox image definitions available inside a Kojo Project.

## Language

**Kojo Project**:
A local Git repository initialized for Kojo. It contains version-controlled workflow and sandbox image definitions alongside project-local execution data.
_Avoid_: Workspace, registered repository

**Workflow Definition**:
A developer-authored description of a workflow that Kojo can validate and execute.
_Avoid_: Workflow config, workflow script

**Sandbox Image Definition**:
Version-controlled source and build files that describe an image a sandbox provider may build or use. It is not an image stored in a container engine.
_Avoid_: Docker image, image archive
