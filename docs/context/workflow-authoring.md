# Workflow Authoring

Workflow Authoring describes how a developer makes workflows, workflow schedules, and sandbox image definitions available inside a Kojo Project.

## Language

**Kojo Project**:
A local Git repository initialized for Kojo. It contains version-controlled workflow, workflow schedule, and sandbox image definitions alongside project-local execution data.
_Avoid_: Workspace, registered repository

**Project Identity**:
The stable, machine-local identity of one initialized Git working tree. It survives moving that working tree, while another clone or linked worktree is a different Kojo Project with its own identity.
_Avoid_: Repository ID, remote URL

**Project Index**:
The machine-local catalog that lets the Kojo Host find known Kojo Projects by stable identity and current repository path. It follows a Project when its working tree moves, but treats the same Project Identity appearing at two paths as a conflict. It contains no Workflow Run or Workflow Schedule state and is not shared between developers.
_Avoid_: Project registry, control plane

**Workflow Definition**:
A developer-authored Effect Workflow definition with a stable Workflow Key, an explicit Workflow Definition Revision, and schemas for its input, success, and failure values, including any sensitivity markings. Its handler is an Effect program executed by the durable Workflow Engine, and its recurring triggers are attached Workflow Schedules. Loading the definition does not start an execution.
_Avoid_: Workflow config, workflow script

**Workflow Key**:
A stable, developer-chosen identifier for a Workflow Definition within one Kojo Project. It remains the same when the definition's display name, export name, or file path changes.
_Avoid_: Workflow name, export name

**Workflow Definition Revision**:
A developer-chosen identity for the schemas, handler behavior, and durable operation keys required to recover a Workflow Run safely. A replay-incompatible change requires a different revision; a live Project Runtime may retain an already-loaded revision for existing work, but stored revision metadata cannot recreate unavailable executable source after restart.
_Avoid_: Workflow version, deployment version

**Workflow Schedule**:
A developer-authored recurring trigger attached to exactly one Workflow Definition and identified by a stable Schedule Key. It declares a five-field cron expression in an explicit IANA time zone, a deterministic input rule, and an overlap policy. The input rule derives input only from the Schedule Key and scheduled instant; Workflow Execution owns whether the schedule is enabled and the occurrences it produces.
_Avoid_: Scheduled workflow, cron job

**Schedule Key**:
A stable, developer-chosen identifier for a Workflow Schedule within one Kojo Project. It remains the same when the schedule's display name, export name, or file path changes; changing it declares a different Workflow Schedule.
_Avoid_: Schedule name, cron name

**Workflow Schedule Revision**:
The Kojo-derived identity of the exact Workflow Schedule definition that Kojo successfully applied. It combines the target Workflow Key, cron expression, time zone, overlap policy, and the input rule's explicit revision. Identical declarations keep the same revision across reloads; changing any of those fields changes the revision without creating a different schedule.
_Avoid_: Schedule version, configuration version

**Kojo Configuration**:
The single static TypeScript value created with `defineConfig(...)` and default-exported from `kojo.config.ts`. It explicitly registers only a Kojo Project's complete Workflow Definitions; each definition carries its Workflow Schedules and has no unresolved developer-provided services. Loading it does not start workflow work; an invalid replacement leaves a live Project Runtime's last accepted snapshot available only to existing work and blocks new work until the current configuration loads successfully.
_Avoid_: Workflow registry, automatic discovery

**Sandbox Image Definition**:
Version-controlled source and build files, identified by a stable key and explicit revision, that describe an image a Sandbox Provider may build or use. Kojo records its content identity when a Workflow Activity starts; the definition is not an image stored in a container engine.
_Avoid_: Docker image, image archive

**Agent Provider**:
An immutable built-in or custom authoring value that knows how to invoke one kind of coding agent. A Workflow Definition uses it directly wherever needed; it is not registered in Kojo Configuration, and a custom provider may require developer-provided Effect services.
_Avoid_: Agent service, project agent

**Sandbox Provider**:
An immutable built-in or custom authoring value that knows how to create the provider session behind a Workflow Sandbox. A Workflow Definition uses it directly wherever needed; it is not registered in Kojo Configuration, and its live provider handle is never exposed to workflow code.
_Avoid_: Sandbox, container

**Provider Credential**:
A sensitive authentication value resolved only when an Agent or Sandbox Provider is invoked, from the environment, operating-system credential storage, or a developer-provided Effect service. Provider definitions may contain non-secret identity and lookup settings, but Kojo never persists the credential in Project state, Diagnostic Events, or Execution Events.
_Avoid_: Provider configuration, saved token
