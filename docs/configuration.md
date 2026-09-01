# Operator configuration

Only the private local CLI can read or change Daemon and Project configuration. Configuration has
no setting for secrets, SQL, a data root, an API route, or a remote endpoint.

Use one JSON patch file with this shape:

```json
{
  "set": {
    "limits": {
      "executingRuns": 2
    },
    "runner": {
      "heartbeatMs": 10000
    }
  },
  "reset": ["limits.newStartQueue"]
}
```

Omitted fields do not change. Each path in `reset` returns to its default. A path cannot occur in
both `set` and `reset`. Kojo validates the complete patch before it changes configuration. It
rejects unknown fields, non-positive integers, and empty or excessive restart delay lists.

Use these commands:

```text
kojo daemon configure --file FILE [--check]
kojo daemon configure --confirm PLAN_TOKEN
kojo daemon status --details
kojo project configure PROJECT --file FILE [--check]
kojo project status PROJECT --details
```

Use `-` as `FILE` to read JSON from standard input. `--check` does not apply the patch. It returns
the proposed status and, when shorter retention can delete data, a data-bound plan. Confirm only
that exact plan token before its 10-minute expiry. Kojo revalidates configuration and retained data
under the Daemon's exclusive SQLite ownership before collection.

Daemon setting paths are:

- `limits.executingRuns`, `limits.newStartQueue`
- `runner.idleMs`, `runner.handshakeMs`, `runner.heartbeatMs`, `runner.unhealthyMs`,
  `runner.cleanupMs`, `runner.recoveryCheckMs`, `runner.restartDelaysMs`,
  `runner.healthyResetMs`
- `daemon.readinessMs`, `daemon.cleanupMs`, `daemon.restartDelaysMs`,
  `daemon.healthyResetMs`
- `retention.runHistoryMs`, `retention.traceMs`, `retention.artifactMs`

Project setting paths are `limits.executingRuns` and `limits.newStartQueue`.

Limits and durations are positive integer milliseconds. Restart delays are a nonempty list of at
most 16 positive integer milliseconds. Each retention value is a positive integer duration or
`"indefinite"`.

Limit changes are immediate. Lower limits hold later admission or dispatch. They do not interrupt
or cancel admitted Runs. Duplicate admission and continuation queues keep their existing
exceptions. Runner supervision values apply to future Runner attempts. Daemon supervision values
remain pending until an explicit Daemon lifecycle restart completes. An automatic process
replacement does not activate pending values.

Run correctness, Trace records, Artifacts, and Workflow Revisions have separate collection rules.
The three configurable retention paths default to `"indefinite"`. Kojo does not collect a
nonterminal Run or evidence that is required for recovery, an unresolved action, an unreleased
resource, or unconfirmed cleanup.
