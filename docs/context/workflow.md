# Workflow

How a Factory declares the programs that Kojo can run. The context owns Workflow identity,
availability, revisions, phases, and the contracts that move results between phases.

## Language

### Authored programs

**Factory**:
The authored Kojo files in one Project. A Factory can be available, missing, or invalid without
changing the Project's identity.
_Avoid_: Project, repository, Daemon data

**Workflow**:
An authored Effect program made of phases.
_Avoid_: ADW, pipeline, job

**Project Workflow**:
A Workflow declared by one top-level source file in a Project's Factory. A demonstration installed
in the Factory is a Project Workflow like any other Workflow. Project ID plus Workflow name
identifies one Project Workflow.
_Avoid_: built-in Workflow, demo Workflow

**Workflow name**:
The stable name of a Project Workflow inside its Project. It is the source file name without the
extension and must agree with the name declared by the Workflow.
_Avoid_: export name, file path, Workflow ID

**Workflow Revision**:
An immutable version of a Project Workflow, its Factory-owned source dependencies, and its package
identities. A Run uses one Workflow Revision from the time its request is accepted until completion,
even if the author changes or removes the current source. The revision remains in Daemon data while
any retained Run refers to it.
_Avoid_: current Workflow, cached Workflow

**Candidate Revision**:
A new Workflow Revision that Kojo has discovered but has not yet accepted for new Runs.
_Avoid_: pending Workflow, draft Workflow

**Factory Refresh**:
The inspection that compares current Factory inputs with the last recorded state, validates
Candidate Revisions, and updates which Project Workflows can accept new Runs. It does not change the
Workflow Revision of an existing Run, run a Workflow, or test external services.
_Avoid_: reload, rescan, hot reload

**Pending Refresh**:
A Factory Refresh that Kojo must perform because it has detected new Factory inputs but has not yet
completed their validation.
_Avoid_: stale Factory, pending Workflow

**Failed Refresh**:
A Factory Refresh that could not complete because of an operational fault. It blocks new Runs for
that Project until a later refresh succeeds, but it does not make the authored Factory invalid.
_Avoid_: Invalid Factory, Invalid Workflow

### Availability

**Available Factory**:
A Factory whose shared contract Kojo can use. It can contain an Invalid Workflow without making its
other Project Workflows unavailable.
_Avoid_: ready Project, healthy Project

**Missing Factory**:
A Project has no authored Factory at its location.
_Avoid_: Unavailable Project, unregistered Project

**Invalid Factory**:
A Factory has a shared fault that prevents Kojo from using all its Project Workflows.
_Avoid_: Unavailable Project, invalid Workflow

**Available Workflow**:
A Project Workflow whose executable contract Kojo has validated and can use to start a Run.
Availability does not promise that external services or credentials are ready.
_Avoid_: discovered Workflow, enabled Workflow

**Invalid Workflow**:
A Project Workflow whose source does not satisfy the Workflow contract. Its fault does not make a
valid sibling Workflow unavailable. It accepts no new Runs, but existing Runs keep their Workflow
Revision.
_Avoid_: Invalid Factory, failed Run

**Removed Workflow**:
A Project Workflow whose current source is no longer in the Factory. It accepts no new Runs, but
its earlier Workflow Revisions remain available to existing Runs and history.
_Avoid_: deleted Workflow, Invalid Workflow

### Execution

**Phase**:
One named unit of a Workflow. Its kinds are actor, code, and agent.
_Avoid_: step, node, task

**Phase path**:
The stable identity of a Phase inside one Project Workflow. It combines the stable sandbox scope
name, when present, with the authored Phase name.
_Avoid_: Phase ID, sandbox acquisition ID

**Phase ID**:
The identity of one Phase record: Run ID, Phase path, and attempt. It is unique inside one Daemon.
_Avoid_: Phase name, Phase path

**Run**:
One execution of one Workflow Revision.
_Avoid_: session, job

**Run admission**:
The Daemon's durable acceptance of a new Run request, with its Run identity and Workflow Revision
fixed before execution. It is separate from whether the completed Run is good.
_Avoid_: Acceptance, Run execution, Trigger acknowledgement

**Queued Run**:
A Run accepted by the Daemon whose initial execution or continuation is waiting to be scheduled.
Its wait reason, such as lack of capacity or an automation pause, is distinct from a Gate suspension.
_Avoid_: suspended Run, waiting for a human

**Run continuation**:
Further execution of a Run that has already started. It keeps that Run's identity and Workflow
Revision rather than creating a new Run.
_Avoid_: new Run, new trigger event

**Run ID**:
The opaque identity of a Run, unique inside one Daemon. It does not expose the Project Workflow or
its idempotency key and survives Project Runner replacement.
_Avoid_: Project ID, branch name, idempotency key

**Idempotency key**:
The authored identity of one unit of work inside one Project Workflow. Project ID, Workflow name,
and this key deduplicate Runs across Workflow Revisions.
_Avoid_: Run ID, trigger ID

**Run Claim**:
One Project Runner instance's fenced authority to drive a Run. The Run ID identifies the claim; the
holder is a Project Runner instance ID, not a process ID or Project location.
_Avoid_: lock file, Envelope claim, issue assignment

**Envelope**:
A phase's typed output that carries context forward and selects branches.
_Avoid_: response, payload, result

**Check**:
A predicate over an Envelope's claims, evaluated after the phase produces the Envelope.
_Avoid_: gate, validator

**Acceptance**:
Whether a completed Run is good. This is separate from whether its phases completed successfully.
_Avoid_: success, completion
