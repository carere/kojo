---
status: accepted
---

# Preserve pre-ADR execution event identities while writing the ADR 0011 catalog

Before ADR 0011 named the final v1 Execution Event catalog, released Hosts had
already written `child.started`, `workflow-deferred.completed`,
`run.engine-recovery-queued`, and `run.engine-late-outcome` with envelope and
kind version one. Rewriting immutable evidence would violate the append-only
contract; silently treating it as unsupported would hide valid history.

## Decision

- New v1 writes use only the exact ADR 0011 catalog.
- Readers recognise the four pre-ADR identities as a documented reader-only
  compatibility set and return their original persisted identity as supported
  v1 evidence.
- The reader-only set is not accepted as a new-write kind or a v1 filter
  value. A later format change must use a new envelope or kind version.

## Consequences

Compatibility is explicit and executable rather than a silent redefinition of
ADR 0011's closed catalog. Project stores retain immutable historical rows,
while new data converges on the ADR 0011 names.
