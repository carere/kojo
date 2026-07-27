# Workflow Authoring

Workflow Authoring describes how a developer makes workflows, workflow schedules, and sandbox image definitions available inside a Kojo Project.

## Language

**Kojo Project**:
A local Git repository initialized for Kojo. It contains version-controlled workflow, workflow schedule, and sandbox image definitions alongside project-local execution data.
_Avoid_: Workspace, registered repository

**Project Index**:
The machine-local catalog that lets the Kojo Host find known Kojo Projects by stable identity and current repository path. It contains no Workflow Run or Workflow Schedule state and is not shared between developers.
_Avoid_: Project registry, control plane

**Workflow Definition**:
A developer-authored Effect Workflow definition with a stable Workflow Key and schemas for its input, success, and failure values. Its handler is an Effect program executed by the durable Workflow Engine; loading the definition does not start an execution.
_Avoid_: Workflow config, workflow script

**Workflow Key**:
A stable, developer-chosen identifier for a Workflow Definition within one Kojo Project. It remains the same when the definition's display name, export name, or file path changes.
_Avoid_: Workflow name, export name

**Workflow Schedule**:
A developer-authored recurring trigger for a Workflow Definition, identified by a stable Schedule Key. It declares a five-field cron expression in an explicit IANA time zone, a deterministic input rule, and an overlap policy. The input rule derives input only from the Schedule Key and scheduled instant; Workflow Execution owns whether the schedule is enabled and the occurrences it produces.
_Avoid_: Scheduled workflow, cron job

**Schedule Key**:
A stable, developer-chosen identifier for a Workflow Schedule within one Kojo Project. It remains the same when the schedule's display name, export name, or file path changes; changing it declares a different Workflow Schedule.
_Avoid_: Schedule name, cron name

**Workflow Schedule Revision**:
The stable identity of the exact Workflow Schedule definition that Kojo successfully applied. Identical declarations keep the same revision across reloads; changing the target Workflow Key, cron expression, time zone, input rule, or overlap policy changes the revision without creating a different schedule.
_Avoid_: Schedule version, configuration version

**Kojo Configuration**:
The single static TypeScript value created with `defineConfig(...)` and default-exported from `kojo.config.ts`. It explicitly registers a Kojo Project's Workflow Definitions, Workflow Schedules, and Sandbox Image Definitions. Loading it does not start workflow work.
_Avoid_: Workflow registry, automatic discovery

**Sandbox Image Definition**:
Version-controlled source and build files that describe an image a sandbox provider may build or use. It is not an image stored in a container engine.
_Avoid_: Docker image, image archive
