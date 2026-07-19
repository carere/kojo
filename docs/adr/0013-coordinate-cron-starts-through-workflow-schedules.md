# Coordinate cron starts through durable Workflow Schedules

Kojo will represent each repository-authored cron trigger as a named Workflow Schedule while the
Kojo System Process owns installation-local enablement, durable time evaluation, and atomic root
Workflow Run creation. This keeps schedule behavior versioned with Project source while preventing
process downtime, source changes, or crashes from making start decisions invisible or duplicating a
Schedule Occurrence.

A Workflow Schedule references one registered Developer Workflow, accepts fixed schema-validated
input, uses an Effect `Cron.Cron` with minute precision and a named IANA timezone, and chooses
`skip` or `catch-up-once` for missed times. Its Project-scoped stable name preserves local
enablement across Project Source Revisions but cannot later target another Developer Workflow.

Each Schedule has a monotonically advancing Schedule Cursor and append-only Schedule History.
Normal occurrences are uniquely identified by Project ID, Schedule name, and scheduled UTC instant.
`catch-up-once` coalesces missed times into one durable pending catch-up that records the earliest
time, latest time, and count, then uses the current active Schedule definition and Project Source
Revision when it can start.

Scheduled overlap is scoped by Project ID and Developer Workflow stable name across root Workflow
Runs. A Running root run suppresses a scheduled start; other Workflow Run States and Child Workflow
Runs do not. Direct starts and explicit resumes remain operator-controlled and may run
concurrently, though a resulting Running root run suppresses later scheduled attempts.

Before creating a run, Kojo refreshes and validates Project source, rechecks the Schedule against
the newly active revision, verifies Project and Schedule enablement and Project Availability, and
checks overlap. One System Process transaction then claims the occurrence, creates the Workflow
Run and first Execution Attempt, records the first Evidence Event, and links Schedule History to
the Run ID. Failures before that transaction create no run; failures after it belong to the created
run's lifecycle.

Kojo uses Effect Cron for parsing and calendar calculation but enforces the narrower Kojo contract
and a strictly increasing occurrence cursor. Nonexistent daylight-saving times move forward by the
gap, repeated times fire once at the earlier instant, forward clock jumps produce missed times, and
backward jumps never duplicate an occurrence.

## Considered Options

- Delegate scheduling to operating-system cron and recover provenance after invocation.
- Keep enablement only in `kojo.config.ts` or implicitly enable every discovered Schedule.
- Identify overlap by Schedule name, Workflow Revision, or every unfinished Workflow Run State.
- Replay every missed occurrence or discard every missed occurrence unconditionally.
- Store skipped and blocked starts only in process logs or per-run Execution Evidence.
- Let direct starts and resumes participate in the scheduler's exclusion rule.

## Consequences

- Kojo Home needs durable Schedule definitions, enablement, cursors, pending catch-ups, occurrence
  identities, and append-only Schedule History in addition to Workflow Run state.
- Newly discovered Schedules start Disabled. Project Registration State gates scheduling without
  rewriting Schedule Enablement, and absent Schedules retain dormant local history.
- An invalid Schedule rejects the complete candidate Project Source Revision and makes the Project
  Unavailable rather than partially activating a registry.
- Schedule changes apply atomically with source activation. A due occurrence canceled by a changed
  or removed definition creates no missed time.
- Schedule History remains authoritative for outcomes that create no Workflow Run; a started run
  retains an immutable Scheduled trigger linked back to its occurrence.
- Competing eligible starts within one overlap identity are ordered by oldest eligible time, then
  Schedule name, so frequent Schedules do not permanently starve older pending catch-ups.
- Schedule History is retained and backed up without automatic pruning in the first vertical slice.
