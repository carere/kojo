# Effect cron and durable Workflow scheduling

## Question

Does Effect's cron support make a developer-authored scheduled Workflow equivalent to a durable, managed Workflow Schedule, and what should Kojo v1 expose if schedules can be enabled and disabled?

## Source snapshot

This note inspects the official Effect repository at commit [`9b16adb8f9f607d1a5b74c2ac125d437e2c23c98`](https://github.com/Effect-TS/effect/tree/9b16adb8f9f607d1a5b74c2ac125d437e2c23c98), whose package version is `effect@4.0.0-beta.102`. All findings below refer to that unstable API snapshot.

## Findings

### `Cron` is a calendar calculation value

`Cron.Cron` stores constraints for seconds, minutes, hours, days of month, months and weekdays, plus an optional time zone. `Cron.parse` accepts five fields (implicitly adding second `0`) or six fields, accepts a `DateTime.TimeZone` or string, and rejects invalid time-zone strings with `CronParseError` ([source](https://github.com/Effect-TS/effect/blob/9b16adb8f9f607d1a5b74c2ac125d437e2c23c98/packages/effect/src/Cron.ts#L551-L589)).

The public calendar operations are:

- `Cron.match(cron, date)`, which interprets the date's calendar fields in the cron's time zone; when the cron has no time zone, it uses the host system's time zone ([source](https://github.com/Effect-TS/effect/blob/9b16adb8f9f607d1a5b74c2ac125d437e2c23c98/packages/effect/src/Cron.ts#L619-L699)).
- `Cron.next(cron, now?)` and `Cron.prev(cron, now?)`, which return a strictly later or earlier matching `Date`; omission of `now` means current time ([source](https://github.com/Effect-TS/effect/blob/9b16adb8f9f607d1a5b74c2ac125d437e2c23c98/packages/effect/src/Cron.ts#L704-L769)).
- `Cron.sequence(cron, now?)`, an infinite, lazy iterator built by repeatedly calling `next` ([source](https://github.com/Effect-TS/effect/blob/9b16adb8f9f607d1a5b74c2ac125d437e2c23c98/packages/effect/src/Cron.ts#L955-L989)).

The implementation adjusts named-zone calculations around daylight-saving transitions ([source](https://github.com/Effect-TS/effect/blob/9b16adb8f9f607d1a5b74c2ac125d437e2c23c98/packages/effect/src/Cron.ts#L771-L798)). The tests establish that spring-forward skips nonexistent local times and fall-back emits only the first occurrence of an ambiguous local time ([source](https://github.com/Effect-TS/effect/blob/9b16adb8f9f607d1a5b74c2ac125d437e2c23c98/packages/effect/test/Cron.test.ts#L657-L704)). Therefore a Kojo schedule should require an explicit time zone rather than inherit the Project Runtime host's zone.

`Cron` itself neither starts work nor stores operational state.

### `Schedule.cron` is in-process repetition, not a managed scheduler

`Schedule.cron` parses a `Cron` and, at every schedule step, computes `Cron.next(cron, now)` and returns the duration until that occurrence ([source](https://github.com/Effect-TS/effect/blob/9b16adb8f9f607d1a5b74c2ac125d437e2c23c98/packages/effect/src/Schedule.ts#L969-L984)). `Effect.repeat` runs the source Effect once immediately, then repeats successful executions according to the schedule and stops on failure ([source](https://github.com/Effect-TS/effect/blob/9b16adb8f9f607d1a5b74c2ac125d437e2c23c98/packages/effect/src/Effect.ts#L7660-L7677)). Consequently, `Effect.repeat(action, Schedule.cron(...))` runs `action` immediately before waiting for the first cron occurrence. `Effect.schedule` differs by stepping the schedule before its first execution, but it still implements a repeated Effect in the same fiber ([source](https://github.com/Effect-TS/effect/blob/9b16adb8f9f607d1a5b74c2ac125d437e2c23c98/packages/effect/src/Effect.ts#L7876-L7934)).

The schedule driver reads `Clock`, keeps attempt metadata in local mutable state, and waits with ordinary `Effect.sleep` ([source](https://github.com/Effect-TS/effect/blob/9b16adb8f9f607d1a5b74c2ac125d437e2c23c98/packages/effect/src/Schedule.ts#L381-L429), [source](https://github.com/Effect-TS/effect/blob/9b16adb8f9f607d1a5b74c2ac125d437e2c23c98/packages/effect/src/internal/schedule.ts#L181-L218)). There is no persistence boundary in `Schedule` or its repetition driver. Its state and wait do not independently survive process restart.

Putting that code inside a durable Workflow does not automatically change those ordinary sleeps into durable timers. A Workflow replay reconstructs the handler and its local schedule driver. Durable Activities that have already completed may replay their stored results, but a repeated Activity also needs a distinct stable name (and attempt) per logical occurrence because the cluster engine's Activity primary key is `name/attempt` within a Workflow execution ([source](https://github.com/Effect-TS/effect/blob/9b16adb8f9f607d1a5b74c2ac125d437e2c23c98/packages/effect/src/unstable/cluster/ClusterWorkflowEngine.ts#L644-L659)).

### `DurableClock` is a durable one-shot Workflow wait

`DurableClock.sleep({ name, duration })` is purpose-built for a wait *inside one Workflow execution*. Zero duration returns immediately. Durations at or below `inMemoryThreshold` (60 seconds by default) run an Activity wrapping ordinary `Effect.sleep`; longer durations ask `WorkflowEngine.scheduleClock` to schedule a wake-up and then await a named `DurableDeferred` ([source](https://github.com/Effect-TS/effect/blob/9b16adb8f9f607d1a5b74c2ac125d437e2c23c98/packages/effect/src/unstable/workflow/DurableClock.ts#L63-L117)). Awaiting an incomplete `DurableDeferred` marks the Workflow suspended; recording its result later resumes the Workflow ([source](https://github.com/Effect-TS/effect/blob/9b16adb8f9f607d1a5b74c2ac125d437e2c23c98/packages/effect/src/unstable/workflow/DurableDeferred.ts#L132-L165)).

The cluster Workflow engine implements a long clock as a persisted, uninterruptible delayed RPC. Its payload is keyed by clock name, carries an absolute UTC wake-up, and completes the corresponding durable deferred on delivery ([source](https://github.com/Effect-TS/effect/blob/9b16adb8f9f607d1a5b74c2ac125d437e2c23c98/packages/effect/src/unstable/cluster/ClusterWorkflowEngine.ts#L604-L623), [source](https://github.com/Effect-TS/effect/blob/9b16adb8f9f607d1a5b74c2ac125d437e2c23c98/packages/effect/src/unstable/cluster/ClusterWorkflowEngine.ts#L722-L758)). This implementation requires cluster `Sharding` and `MessageStorage` ([source](https://github.com/Effect-TS/effect/blob/9b16adb8f9f607d1a5b74c2ac125d437e2c23c98/packages/effect/src/unstable/cluster/ClusterWorkflowEngine.ts#L762-L780)).

This is durable timer machinery, but it is not a recurring schedule registry. It has no schedule identity, enable/disable status, cron update, missed-run policy, or run history of its own.

### `ClusterCron` is a durable recurring cluster job, with important limits

`ClusterCron.make` creates a Layer for one named cron job. It registers a singleton that submits the initial occurrence, plus a cluster Entity whose persisted, uninterruptible `run` message is delivered at the scheduled time ([source](https://github.com/Effect-TS/effect/blob/9b16adb8f9f607d1a5b74c2ac125d437e2c23c98/packages/effect/src/unstable/cluster/ClusterCron.ts#L31-L98), [source](https://github.com/Effect-TS/effect/blob/9b16adb8f9f607d1a5b74c2ac125d437e2c23c98/packages/effect/src/unstable/cluster/ClusterCron.ts#L155-L164)). Persisted messages require `MessageStorage`; that storage saves delayed delivery times and detects duplicate request primary keys ([source](https://github.com/Effect-TS/effect/blob/9b16adb8f9f607d1a5b74c2ac125d437e2c23c98/packages/effect/src/unstable/cluster/MessageStorage.ts#L279-L300), [source](https://github.com/Effect-TS/effect/blob/9b16adb8f9f607d1a5b74c2ac125d437e2c23c98/packages/effect/src/unstable/cluster/Sharding.ts#L840-L855)).

Its observable policies are:

- **One chain and no overlap per job:** the handler schedules the next message only in `onExit`, after the current execution exits. Failure is logged and the next occurrence is still scheduled ([source](https://github.com/Effect-TS/effect/blob/9b16adb8f9f607d1a5b74c2ac125d437e2c23c98/packages/effect/src/unstable/cluster/ClusterCron.ts#L105-L145)). This serializes a named job; it does not create overlapping occurrences.
- **Missed/stale runs:** a run older than `skipIfOlderThan` is skipped; the default is one day. By default, the next occurrence is calculated from current time, so missed occurrences are collapsed. With `calculateNextRunFromPrevious: true`, the chain advances from each previous scheduled time and can walk through missed occurrences sequentially; stale ones are still skipped according to the threshold ([source](https://github.com/Effect-TS/effect/blob/9b16adb8f9f607d1a5b74c2ac125d437e2c23c98/packages/effect/src/unstable/cluster/ClusterCron.ts#L53-L76), [source](https://github.com/Effect-TS/effect/blob/9b16adb8f9f607d1a5b74c2ac125d437e2c23c98/packages/effect/src/unstable/cluster/ClusterCron.ts#L100-L134)).
- **Uniqueness:** the name becomes both the singleton name and Entity type. Registering the same singleton name in the same shard group more than once is a defect ([source](https://github.com/Effect-TS/effect/blob/9b16adb8f9f607d1a5b74c2ac125d437e2c23c98/packages/effect/src/unstable/cluster/ClusterCron.ts#L78-L98), [source](https://github.com/Effect-TS/effect/blob/9b16adb8f9f607d1a5b74c2ac125d437e2c23c98/packages/effect/src/unstable/cluster/Singleton.ts#L25-L39)). Each scheduled message uses an occurrence-specific Entity id, while its payload primary key is the empty string, letting message storage deduplicate the same occurrence address and RPC ([source](https://github.com/Effect-TS/effect/blob/9b16adb8f9f607d1a5b74c2ac125d437e2c23c98/packages/effect/src/unstable/cluster/ClusterCron.ts#L88-L96), [source](https://github.com/Effect-TS/effect/blob/9b16adb8f9f607d1a5b74c2ac125d437e2c23c98/packages/effect/src/unstable/cluster/ClusterCron.ts#L123-L163)).
- **Dependencies:** the returned Layer requires `Sharding` and the execution Effect's services. Because the RPC is persisted, a real `MessageStorage` implementation is also required at runtime; the no-op storage is invalid for persisted messages ([source](https://github.com/Effect-TS/effect/blob/9b16adb8f9f607d1a5b74c2ac125d437e2c23c98/packages/effect/src/unstable/cluster/ClusterCron.ts#L43-L77), [source](https://github.com/Effect-TS/effect/blob/9b16adb8f9f607d1a5b74c2ac125d437e2c23c98/packages/effect/src/unstable/cluster/Sharding.ts#L843-L849)).
- **No management API:** `ClusterCron` exports only `make`. It has no `enable`, `disable`, `stop`, `update`, `status`, or `list` operation ([source](https://github.com/Effect-TS/effect/blob/9b16adb8f9f607d1a5b74c2ac125d437e2c23c98/packages/effect/src/unstable/cluster/ClusterCron.ts#L31-L164)). Closing its Layer unregisters the singleton and Entity handlers, but the scheduled request is already persisted; the Layer API does not delete or invalidate that request. Changing code under the same name changes the handler used when a persisted message is eventually delivered, but there is no explicit, atomic schedule-update contract.

`ClusterCron` is therefore useful implementation evidence and perhaps substrate, but it is not by itself Kojo's required product contract.

### A scheduled Effect inside a Workflow is not a managed Workflow Schedule

The two designs have different identities and lifecycles:

| Developer-authored `Effect.schedule` / `Effect.repeat` inside a Workflow | Managed Workflow Schedule |
| --- | --- |
| One long-lived Workflow Run repeats internally | Each occurrence starts a distinct durable Workflow Run |
| Cron state and ordinary sleeps belong to the current fiber | Schedule definition, status and next occurrence are durable resources |
| Stop interrupts that one Workflow Run | Disable prevents future Workflow Runs; active runs can be stopped separately |
| No independent list/status/update API | Discoverable, inspectable, enableable, disableable and reconcilable |
| Workflow replay reconstructs local repetition state | Trigger delivery and occurrence identity are persisted and idempotent |

Effect's compositional freedom remains valuable *inside each occurrence*. It does not remove the need for a managed outer trigger if Kojo must clearly distinguish scheduled Workflows and control future starts.

## Recommendation for Kojo v1

Add Workflow scheduling to v1, but model it as a first-class **Workflow Schedule**, separate from both a Workflow Definition and a Workflow Run.

The v1 contract should decide and record at least:

1. A developer declares a stable Schedule key, target Workflow Definition, input construction, cron expression and explicit time zone in `kojo.config.ts`.
2. The Project Runtime persists operational Schedule state: configured version, enabled/disabled state, next occurrence, and enough occurrence identity to make Workflow Run creation idempotent.
3. Every occurrence creates a normal, independent durable Workflow Run. The Workflow's author may still use any Effect concurrency, retry, Activity, suspension and recovery primitives inside that run.
4. Disabling a Schedule prevents future Workflow Runs but does not interrupt already-created runs. Stopping active Workflow Runs remains a separate operation. Enabling computes a new next occurrence according to an explicit missed-run policy.
5. v1 explicitly chooses missed-run behavior, overlap/concurrency policy, behavior when the Project Runtime is down, configuration reconciliation when cron/time zone/input changes, and removal/rename semantics.
6. Kojo may reuse Effect `Cron` for parsing and occurrence calculations and the cluster delayed-message machinery for durability, but should place its own stable API and persisted management model in front of the unstable Effect APIs. `ClusterCron.make` alone cannot implement enable/disable or atomic updates.

The simplest coherent v1 defaults would be: explicit time zone; no catch-up (compute the next future occurrence on enable/recovery); one Workflow Run per occurrence; allow overlapping runs unless a separate concurrency policy says otherwise; disable affects future occurrences only. These are recommendations for follow-up design decisions, not facts imposed by Effect.
