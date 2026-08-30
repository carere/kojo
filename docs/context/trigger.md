# Trigger

What requests automatic Runs, and how a user controls those requests independently of manual Runs
and existing Run continuations.

## Language

**Trigger**:
A source of Run requests that supplies the payload and idempotency key for a Project Workflow.
_Avoid_: Workflow, Phase, Run

**Trigger event**:
One delivery from a Trigger that requests a Run with a payload and idempotency key. Repeated
delivery does not by itself identify new work.
_Avoid_: Run ID, Run outcome

**Trigger acknowledgement**:
Confirmation to a Trigger that the Daemon has durably accepted its Run request or identified an
existing duplicate. It does not mean that the Run has started, suspended, or completed.
_Avoid_: Run outcome, Run completion

**Rejected trigger event**:
A Trigger event that Kojo cannot admit as a Run request and records with a rejection reason.
It is not an accepted Run or a failed execution.
_Avoid_: failed Run, Trigger acknowledgement

**Faulted trigger**:
A Trigger that cannot process events because of a fault. Its fault is separate from the user's
automation settings.
_Avoid_: Paused trigger, Invalid Workflow

**Project automation**:
The Project-wide control for starting Runs through individually enabled Workflow triggers. It does
not control manual Runs or existing Run continuations.
_Avoid_: Project availability, enabled Project

**Automation pause**:
A user-imposed hold on new automatic execution for one Project or Project Workflow, including
trigger-created Queued Runs that have not started execution. It does not stop manual Runs, already
executing Runs, or their continuations.
_Avoid_: Run cancellation, Gate suspension, Archived Project
