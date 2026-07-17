# Reusable behavior from Delimoov's delivery workflow

> Decision research for [Extract the reusable behavior of Delimoov's delivery
> workflow](https://github.com/carere/kojo/issues/8).
>
> Primary implementation inspected at Delimoov commit
> `23d1a0980f6ae63a936fb067b7fdcaf7e78e0a68` and Sandcastle
> `@ai-hero/sandcastle@0.12.0`. Last updated: 2026-07-17.

## Decision

Kojo's reference delivery workflow should preserve Delimoov's **proof discipline, scheduling shape,
and recovery invariants**, but express them as an Effect-native Developer Workflow whose named,
durable activities and loops are observable and resumable.

The reusable shape is:

```text
validate and pin input
  → reload current state
  → recover already-integrated work
  → derive the ready frontier
  → select a bounded, independent batch
  → implement tickets concurrently in isolated Reusable Sandboxes
      → review cumulative change
      → if P1/P2: implementer repairs → review again
      → if no P1/P2: emit immutable reviewed-commit evidence
      → if limit exhausted: preserve the Sandbox and fail with typed evidence
  → integrate reviewed commits serially from an expected target HEAD
  → verify the exact integrated commit in an independent Sandbox
  → publish, then complete external bookkeeping
  → repeat until the workstream has complete integration evidence
```

Delimoov repeatedly applies one crucial rule: **an agent's success claim is a routing signal, not
proof of success**. The orchestrator checks commits, ancestry, cleanliness, deterministic commands,
merge topology, immutable inputs, remote publication, and external bookkeeping before advancing
([implementation checks](https://github.com/delimoov/delimoov/blob/23d1a0980f6ae63a936fb067b7fdcaf7e78e0a68/.sandcastle/src/workflows/delivery/agents/implementation.ts#L66-L162),
[integration checks](https://github.com/delimoov/delimoov/blob/23d1a0980f6ae63a936fb067b7fdcaf7e78e0a68/.sandcastle/src/workflows/delivery/integration.ts#L24-L120)).
That rule should become a general Kojo design principle.

## Preserve

### 1. Validate the complete work graph before executing it

Delimoov rejects incomplete or truncated child and blocker graphs, cycles, blockers outside the
workstream, invalid or duplicate publication identities, assigned executable tickets, and
ambiguous state labels. It sorts validated tickets into a stable order
([workstream validation](https://github.com/delimoov/delimoov/blob/23d1a0980f6ae63a936fb067b7fdcaf7e78e0a68/.sandcastle/src/workflows/delivery/workstream.ts#L18-L171)).
It also requires a full source commit object ID and distinct target and destination branches
([delivery metadata](https://github.com/delimoov/delimoov/blob/23d1a0980f6ae63a936fb067b7fdcaf7e78e0a68/.sandcastle/src/workflows/delivery/metadata.ts#L31-L53)).

The reusable invariant is broader than GitHub Issues: before work starts, a workflow must decode
and validate its full input contract, pin immutable identities and revisions, reject incomplete
relationships, and establish a deterministic order. Kojo should make typed input schemas and
Workflow Revision pinning the normal way to satisfy this invariant.

### 2. Re-read mutable control-plane state at commitment boundaries

The delivery loop reloads the workstream before every iteration, verifies that routing metadata has
not changed, and rechecks the root, ticket specification, and ready-frontier membership immediately
before closing a ticket
([main loop](https://github.com/delimoov/delimoov/blob/23d1a0980f6ae63a936fb067b7fdcaf7e78e0a68/.sandcastle/src/workflows/delivery/index.ts#L42-L89),
[completion guard](https://github.com/delimoov/delimoov/blob/23d1a0980f6ae63a936fb067b7fdcaf7e78e0a68/.sandcastle/src/workflows/delivery/integration.ts#L151-L218)).

Kojo should preserve the distinction between:

- a snapshot used by an Agent Step;
- current external state used to authorize an effect; and
- immutable evidence explaining which snapshot was accepted.

Resuming a durable activity result must not silently authorize a later side effect against changed
input.

### 3. Schedule only the ready frontier, with two levels of bounded concurrency

The frontier contains open tickets whose native blockers are all closed
([frontier selection](https://github.com/delimoov/delimoov/blob/23d1a0980f6ae63a936fb067b7fdcaf7e78e0a68/.sandcastle/src/workflows/delivery/workstream.ts#L173-L178)).
A read-only planner may choose a non-empty, unique subset no larger than the concurrency budget and
cannot select outside that frontier
([planner contract](https://github.com/delimoov/delimoov/blob/23d1a0980f6ae63a936fb067b7fdcaf7e78e0a68/.sandcastle/src/workflows/delivery/agents/planner.ts#L16-L49)).
Independent workstreams start concurrently, while one semaphore caps aggregate agent capacity
across planning, implementation, verification, and repair. Selected tickets run concurrently, but
their reviewed results integrate serially against an exact expected target HEAD
([batch scheduling](https://github.com/delimoov/delimoov/blob/23d1a0980f6ae63a936fb067b7fdcaf7e78e0a68/.sandcastle/src/workflows/delivery/index.ts#L90-L146),
[global capacity](https://github.com/delimoov/delimoov/blob/23d1a0980f6ae63a936fb067b7fdcaf7e78e0a68/.sandcastle/src/workflows/delivery/index.ts#L176-L200)).

Kojo should preserve both controls:

1. workflow policy chooses safe logical parallelism; and
2. runtime resource policy limits aggregate Agent Step capacity.

An agent may advise scheduling, but code must validate its structured selection.

### 4. Isolate mutable work, then share it deliberately

For each ticket, Delimoov creates one named branch from the iteration's immutable base and one
Sandcastle `createSandbox()` handle. The implementer and reviewer run sequentially in that same
Sandbox, sharing the branch, filesystem, dependencies, and accumulated commits
([worker lifecycle](https://github.com/delimoov/delimoov/blob/23d1a0980f6ae63a936fb067b7fdcaf7e78e0a68/.sandcastle/src/workflows/delivery/agents/implementation.ts#L19-L174)).
Sandcastle defines this handle as a worktree-backed Sandbox reusable across multiple `run()` calls;
it also supports deterministic `exec()`, agent-session resume/fork, explicit close, and dirty
worktree preservation
([Sandcastle public contract](https://github.com/mattpocock/sandcastle/blob/main/src/createSandbox.ts)).

Kojo should wrap this provider-independent Reusable Sandbox rather than infer containers. A
workflow author chooses Sandbox boundaries. Agent Steps and Code Steps can share a Sandbox when
they intentionally collaborate through one evolving codebase.

The handle itself is process-local and must not be durable state. The durable identity is at least
the repository, base revision, named branch, accepted commits, provider-independent recovery
metadata, and captured Agent Step evidence. On resume, Kojo must either reattach to or recreate a
Sandbox around that identity.

### 5. Separate agent judgment from deterministic evidence

Delimoov requires explicit completion signals and schema-decodes planner and reviewer output, but
then independently checks the resulting repository. For implementation it requires a commit beyond
the base. After review it requires a non-empty cumulative change, base and implementation ancestry,
passing tests/checks/typecheck, a clean worktree, and captures the exact final reviewed commit
([implementation evidence](https://github.com/delimoov/delimoov/blob/23d1a0980f6ae63a936fb067b7fdcaf7e78e0a68/.sandcastle/src/workflows/delivery/agents/implementation.ts#L66-L162)).
The planner is likewise rejected if it changes the target branch
([planner read-only proof](https://github.com/delimoov/delimoov/blob/23d1a0980f6ae63a936fb067b7fdcaf7e78e0a68/.sandcastle/src/workflows/delivery/agents/planner.ts#L51-L98)).

Kojo's `Evidence` primitive should therefore distinguish:

- an agent assertion or structured decision;
- observed repository state;
- deterministic Code Step results;
- an accepted immutable artifact such as a commit; and
- the authorization decision that allowed the next effect.

Evidence should be typed, named, timestamped, attributed to its Workflow Run and attempt, and
available to the visualizer.

### 6. Bind accepted code to the specification it satisfied

Delimoov hashes normalized delivery metadata, repository identity, root and ticket titles, bodies,
comments, parents, children, and blockers. It records this specification fingerprint with the exact
reviewed commit in the integration merge message
([fingerprint and merge evidence](https://github.com/delimoov/delimoov/blob/23d1a0980f6ae63a936fb067b7fdcaf7e78e0a68/.sandcastle/src/workflows/delivery/evidence.ts#L92-L144)).
Recovery recomputes the fingerprint and refuses to complete bookkeeping if the specification or
routing metadata changed
([evidence validation](https://github.com/delimoov/delimoov/blob/23d1a0980f6ae63a936fb067b7fdcaf7e78e0a68/.sandcastle/src/workflows/delivery/evidence.ts#L215-L306)).

Kojo should generalize this as provenance: an accepted result points to the exact Workflow Revision,
normalized input snapshot, Sandbox identity, Agent Step attempts, Code Step results, and output
artifact. The particular hash fields belong to the Developer Workflow, while Kojo provides stable
encoding, attachment, and lookup primitives.

### 7. Integrate immutable commits serially and prove the exact transition

Delimoov integrates the captured reviewed commit, not whichever commit a diagnostic branch later
points to. It requires the target still to equal the expected batch HEAD and proves an exact
two-parent merge whose first parent is that expected HEAD and second parent is the reviewed commit
([integration transition](https://github.com/delimoov/delimoov/blob/23d1a0980f6ae63a936fb067b7fdcaf7e78e0a68/.sandcastle/src/workflows/delivery/integration.ts#L61-L120),
[merge execution](https://github.com/delimoov/delimoov/blob/23d1a0980f6ae63a936fb067b7fdcaf7e78e0a68/.sandcastle/src/workflows/delivery/integration.ts#L220-L279)).
After integration it verifies the exact target commit in a fresh, uniquely named Sandbox, confirms
that Sandbox opened the requested commit, runs deterministic checks, and confirms cleanliness
([verification Sandbox](https://github.com/delimoov/delimoov/blob/23d1a0980f6ae63a936fb067b7fdcaf7e78e0a68/.sandcastle/src/workflows/delivery/agents/verification.ts#L19-L69)).

This is a reusable compare-and-swap rule: state-changing activities accept an expected prior state
and fail if it moved. Successful transitions emit immutable before/after evidence. Verification
must name the artifact it checked, and publication must reject drift between verification and
effect.

### 8. Design every externally visible effect for partial failure

Delimoov records a target checkpoint containing safe, published, and active-integration state using
atomic file replacement. Before integrating, it records intent; only a successful push advances the
published checkpoint
([checkpoint persistence](https://github.com/delimoov/delimoov/blob/23d1a0980f6ae63a936fb067b7fdcaf7e78e0a68/.sandcastle/src/workflows/delivery/target.ts#L24-L115),
[integration and publication checkpoints](https://github.com/delimoov/delimoov/blob/23d1a0980f6ae63a936fb067b7fdcaf7e78e0a68/.sandcastle/src/workflows/delivery/target.ts#L407-L464)).
On restart it reconciles local HEAD, remote HEAD, active merge state, cleanliness, and the checkpoint.
It snapshots Sandcastle-owned failed work to recovery refs before resetting, but refuses to delete
unowned dirty edits or state it cannot preserve safely
([target recovery](https://github.com/delimoov/delimoov/blob/23d1a0980f6ae63a936fb067b7fdcaf7e78e0a68/.sandcastle/src/workflows/delivery/target.ts#L166-L228),
[reconciliation](https://github.com/delimoov/delimoov/blob/23d1a0980f6ae63a936fb067b7fdcaf7e78e0a68/.sandcastle/src/workflows/delivery/target.ts#L330-L405)).

Effect Workflow can durably replay completed activities, but it cannot make a Git push, tracker
mutation, or Sandbox creation transactional. Kojo activities still need idempotency keys,
read-before-write reconciliation, expected-state guards, and durable receipts. Recovery may undo
only state demonstrably owned by the Workflow Run; ambiguous state must be preserved and escalated.

### 9. Close resources without destroying diagnostic state

Delimoov scopes target locks and Sandboxes with acquire/use/release. Sandcastle close reports a dirty
preserved worktree, which Delimoov surfaces instead of silently deleting it
([worker release](https://github.com/delimoov/delimoov/blob/23d1a0980f6ae63a936fb067b7fdcaf7e78e0a68/.sandcastle/src/workflows/delivery/agents/implementation.ts#L164-L173)).
Deterministic Sandbox commands are made uninterruptible because Sandcastle 0.12 cannot cancel
`exec()` safely
([command wrapper](https://github.com/delimoov/delimoov/blob/23d1a0980f6ae63a936fb067b7fdcaf7e78e0a68/.sandcastle/src/workflows/delivery/agents/runtime.ts#L32-L50)).

Kojo should make Sandbox lifetime scoped, observable, and failure-aware. Cleanup outcomes are
evidence. A failed cleanup must not overwrite the primary failure, and discard must explicitly
define whether retained branches, worktrees, provider resources, logs, and recovery refs are
deleted or preserved.

## Deliberately change for Kojo

### Replace review-and-repair with a read-only P1/P2/P3 Review Loop

Delimoov's reviewer is asked to fix blocking findings itself and may add commits
([current reviewer prompt](https://github.com/delimoov/delimoov/blob/23d1a0980f6ae63a936fb067b7fdcaf7e78e0a68/.sandcastle/src/prompts/review.md#L29-L41)).
Kojo's reference workflow should instead implement this explicit contract:

1. The implementer produces an initial committed change in a Reusable Sandbox.
2. Each review attempt examines the complete cumulative diff from the ticket's immutable base and
   receives prior findings as context.
3. The reviewer emits structured findings with severity `P1`, `P2`, or `P3`, location, summary,
   rationale, and stable finding identity. It never modifies code.
4. Code verifies read-only behavior by comparing HEAD and worktree status before and after the
   Reviewer Step. A prompt instruction alone is not a safety boundary.
5. No P1 or P2 finding means success. P3 findings remain advisory evidence.
6. Any P1 or P2 finding routes the structured findings to the implementer, which alone modifies and
   commits the code in the same Reusable Sandbox.
7. The next reviewer sees the full cumulative diff and previous finding dispositions, not merely
   the latest repair patch.
8. The initial implementation happens before the loop; every reviewer attempt consumes one
   configured Review Loop iteration.
9. Exhaustion returns a typed `ReviewLimitReached` outcome with remaining findings, latest commit,
   iteration history, and retained logical Sandbox reference. The ticket is not integrated. The
   Workflow Run remains resumable or may be explicitly discarded.

The loop should be a named Kojo `Loop`/`ReviewLoop` built from ordinary Effect composition. It must
not be conflated with Sandcastle's `maxIterations`, which is an internal multi-turn budget for one
agent run and exposes only agent-run iteration results
([Sandcastle run options and results](https://github.com/mattpocock/sandcastle#runoptions)).
Review attempts, exit decisions, repairs, and exhaustion are domain events that belong in durable
Workflow Run state and the visualizer.

### Make success and failure typed rather than encoded in prose

Delimoov's reviewer emits tagged JSON with `readyToMerge`, a summary, and string findings
([review parser](https://github.com/delimoov/delimoov/blob/23d1a0980f6ae63a936fb067b7fdcaf7e78e0a68/.sandcastle/src/workflows/delivery/agents/review-decision.ts#L6-L20)).
Kojo should use Sandcastle structured output plus Effect schemas for typed agent decisions, while
retaining deterministic postconditions. Failures such as invalid agent output, Sandbox
provisioning, command failure, incompatible Workflow Revision, review exhaustion, integration
conflict, publication uncertainty, and cleanup failure should remain distinguishable in the typed
error channel.

### Let Effect Workflow own durable orchestration

Delimoov reconstructs progress from Git history, GitHub state, branches, comments, and local
checkpoint files because it is an ordinary Effect program. Those proofs remain valuable external
receipts, but Kojo should also persist named Workflow Run, activity, route, loop, Sandbox, and
evidence events in its Workflow Engine. Resume should replay completed activities and reconcile
uncertain external effects instead of rerunning successful side effects.

The reference workflow should still prove restart behavior. A process-local Sandcastle handle,
AbortSignal, or agent session object cannot be stored as durable workflow state; only serializable
identities and evidence can cross a suspension boundary.

### Keep deterministic repair policy in the workflow

Delimoov attempts integration repair for a merge conflict and exactly one repair/reverification
cycle for deterministic check failure
([repair route](https://github.com/delimoov/delimoov/blob/23d1a0980f6ae63a936fb067b7fdcaf7e78e0a68/.sandcastle/src/workflows/delivery/integration.ts#L249-L302)).
That is a reasonable reference policy, not a Kojo runtime rule. The workflow author chooses which
failures are repairable, which actor repairs them, the bounded loop, and the escalation outcome.
Kojo supplies the durable, observable primitives.

## Leave behind

The following are Delimoov application policy, not Kojo orchestration primitives:

- GitHub Issues as the only input source, the `ready-for-agent` label, native sub-issue graph,
  publication-key syntax, automatic issue discovery, and numeric issue ordering. The reference
  delivery workflow may retain them as one concrete input adapter
  ([GitHub discovery](https://github.com/delimoov/delimoov/blob/23d1a0980f6ae63a936fb067b7fdcaf7e78e0a68/.sandcastle/src/workflows/delivery/issues.ts#L17-L201)).
- Default-branch-only `Closes` semantics, managed draft pull-request policy, automatic issue
  closure, and authenticated GitHub actor checks. These are delivery-governance steps authored by a
  workflow, not Kojo core.
- Hard-coded Codex models and effort levels, Moon commands, prompt files, branch names, iteration
  budgets, and the Docker-oriented provider configuration. Kojo exposes agent, command, prompt,
  Sandbox provider, and policy parameters.
- A reviewer that repairs code. Kojo's reference Reviewer Step is mechanically read-only; the
  implementer owns every repair.
- Sandcastle `maxIterations` as the Developer Workflow's control structure. It remains available
  inside an Agent Step, but Kojo's routes and loops are Effect code with durable names and evidence.
- Delimoov's target-checkpoint file format and merge-message trailer names as universal schemas.
  Preserve their ownership, compare-and-swap, provenance, and recovery semantics through Kojo
  activities and workflow-authored evidence.
- The assumption that one delivery workflow is the factory. In Kojo, this delivery flow is one
  Developer Workflow and may itself invoke Child Workflows or be selected by a higher-level
  Software Factory.

## Required contracts for the reference workflow

The implementation specification should require at least these observable contracts:

| Contract | Required evidence |
| --- | --- |
| Input accepted | decoded input, Workflow Revision, normalized input fingerprint, pinned source revision |
| Frontier derived | current control-plane snapshot, eligible and excluded work with reasons |
| Batch selected | planner output plus deterministic validation and concurrency budget |
| Sandbox opened | logical Sandbox identity, provider kind, repository, base, branch, lifecycle attempt |
| Implementation accepted | completion signal, commits, exact implementation HEAD, clean status |
| Review attempt | fixed base, cumulative reviewed HEAD, structured P1/P2/P3 findings, read-only proof |
| Repair attempt | input finding identities, implementer output, new commit, finding dispositions |
| Review Loop exit | iteration count, exit reason, remaining advisory or blocking findings |
| Integration accepted | expected prior target, reviewed commit, exact resulting target, provenance |
| Verification accepted | isolated Sandbox identity, exact target commit, commands and outputs |
| Publication accepted | idempotency key, expected remote state, observed published state |
| External completion | refreshed input state, authorization checks, mutation receipt |
| Resume/discard | recovered identities, reconciled uncertain effects, retained or deleted resources |

These contracts give Kojo's visualizer an actual execution trace without attempting to statically
reverse-engineer arbitrary TypeScript into a graph.

## Consequence for the Wayfinder map

The Delimoov workflow is suitable as the first vertical slice because it exercises typed input,
dynamic frontier scheduling, bounded parallelism, Reusable Sandboxes, multiple agents sharing a
Sandbox, deterministic Code Steps, a named Review Loop, immutable evidence, serial integration,
partial external failure, and recovery.

The implementation route still needs explicit decisions for:

- the embedded durable Effect Workflow Engine;
- the serializable logical Sandbox identity and reattachment/recreation protocol;
- activity idempotency and uncertain-effect reconciliation;
- the exact typed `Evidence` envelope and event model; and
- resume versus discard resource semantics.

## Primary sources

- Delimoov `.sandcastle` delivery implementation and tests at commit
  [`23d1a0980f6ae63a936fb067b7fdcaf7e78e0a68`](https://github.com/delimoov/delimoov/tree/23d1a0980f6ae63a936fb067b7fdcaf7e78e0a68/.sandcastle).
- Sandcastle package
  [`@ai-hero/sandcastle@0.12.0`](https://github.com/mattpocock/sandcastle), especially the
  `createSandbox()` reusable Sandbox API, branch strategies, agent-run results, cancellation, and
  cleanup contracts.
- Delimoov integration tests for
  [review proof](https://github.com/delimoov/delimoov/blob/23d1a0980f6ae63a936fb067b7fdcaf7e78e0a68/.sandcastle/tests/integration/delivery-review-proof.test.ts),
  [durable evidence](https://github.com/delimoov/delimoov/blob/23d1a0980f6ae63a936fb067b7fdcaf7e78e0a68/.sandcastle/tests/integration/delivery-durable-evidence.test.ts),
  [completion safety](https://github.com/delimoov/delimoov/blob/23d1a0980f6ae63a936fb067b7fdcaf7e78e0a68/.sandcastle/tests/integration/delivery-completion-safety.test.ts),
  [scheduling resilience](https://github.com/delimoov/delimoov/blob/23d1a0980f6ae63a936fb067b7fdcaf7e78e0a68/.sandcastle/tests/integration/delivery-scheduling-resilience.test.ts),
  and
  [target recovery](https://github.com/delimoov/delimoov/blob/23d1a0980f6ae63a936fb067b7fdcaf7e78e0a68/.sandcastle/tests/integration/target-recovery.test.ts).
