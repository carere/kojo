# PROTOTYPE — Resume a Workflow Run after losing its Sandbox object

Sandcastle's `createSandbox()` returns a JavaScript object that can be reused for multiple Agent and
Code Steps while Kojo keeps that object in memory. Sandcastle does not expose a public Sandbox ID or
an operation that recreates this object from an ID after Kojo stops.

This throwaway prototype asks:

> Can Kojo resume a Workflow Run from SQLite state and committed Git work after losing its
> Sandcastle Sandbox object?

Run it from the repository root:

```sh
moon run domain:prototype-reusable-sandbox
```

## Proposed rule

- SQLite stores the Workflow Run, its pinned Workflow Revision, completed durable Steps, and the
  next action to take.
- The named branch stores committed work.
- The Sandcastle Sandbox object stays only in the current Kojo process. Agent and Code Steps reuse
  it while that process remains alive.
- After a crash, Kojo loads the Workflow Run from SQLite and creates a fresh Sandbox from the same
  branch before continuing with the saved next action.
- If a Step was in progress when Kojo crashed, SQLite still identifies that Step as next, so Kojo
  reruns it.
- Uncommitted AI-generated changes are allowed to disappear. Only committed Git work is guaranteed
  to survive.
- If a hard crash leaves a Sandbox running, Kojo cannot identify or close it later through the
  current Sandcastle API. Normal `SIGINT`, `SIGTERM`, and process-exit cleanup remains Sandcastle's
  best-effort responsibility.

The prototype simulates SQLite in memory; it does not create a database. Production Kojo would use
the SQLite-backed embedded Effect Workflow journal already selected for local CLI execution.

## Suggested stories

Normal execution:

```text
b m a p c p s
```

Crash after the Agent Step was durably recorded. Kojo resumes at the Code Step:

```text
b m a p k r m c p s
```

Crash while the Agent Step has only uncommitted changes. Kojo discards those changes and reruns the
Agent Step:

```text
b m a k r m a p c p s
```

Crash while Sandcastle is creating the first Sandbox:

```text
b o r m a p c p s
```
