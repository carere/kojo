---
status: accepted
---

# Preserve pre-ADR execution event identities while writing the ADR 0011 catalog

Before ADR 0011 named the final v1 Execution Event catalog, released Hosts had
already written these identities with envelope and kind version one:

- Lifecycle compatibility: `child.started`, `workflow-deferred.completed`,
  `run.engine-recovery-queued`, and `run.engine-late-outcome`.
- Sandbox and Command evidence: `sandbox.acquired`,
  `sandbox.session-recreated`, `command.completed`, `command.failed`, and
  `command.timed-out`.
- Agent evidence: `agent.started`, `agent.completed`, `agent.failed`,
  `agent.session-continued`, and `agent.replayed`.

Rewriting immutable evidence would violate the append-only contract; silently
treating it as unsupported would hide valid history.

## Decision

- New v1 writes use only the exact ADR 0011 catalog.
- Readers recognise the fourteen pre-ADR identities above as a documented
  reader-only compatibility set and return their original persisted identity
  as supported v1 evidence.
- The reader-only set is not accepted as a new-write kind or a v1 filter
  value. A later format change must use a new envelope or kind version.
- Reader-only payloads use their persisted Sensitivity Map. An unavailable,
  invalid, or unsupported map fails closed by masking the entire payload.
  Unknown Event identities and unsupported envelope or kind versions also
  mask the entire payload even if a stale map happens to decode.

## Consequences

Compatibility is explicit and executable rather than a silent redefinition of
ADR 0011's closed catalog. Project stores retain immutable historical rows,
while new data converges on the ADR 0011 names. Historical Sandbox, Command,
and Agent evidence remains inspectable without weakening fail-closed masking.
