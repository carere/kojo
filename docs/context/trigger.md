# Trigger

What requests automatic Runs for an active Project Workflow. Workflow activity controls whether its
Trigger may run; the Trigger has no separate user-controlled enablement.

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
A Trigger that cannot process events because of a fault. Its fault is an observation, separate from
whether the user has started or stopped its Workflow.
_Avoid_: Inactive Workflow, Invalid Workflow
