# Breaking-release test relevance audit

This audit compares the tests removed from `origin/main` with the breaking Daemon runtime. It keeps
tests when their production concept still exists in `packages/kojo-runtime`. It does not restore a
test only because its old file can compile.

## Console fixed-point audit

The seven removed browser suites contain 113 test declarations. The audit keeps 104 current
behaviors and classifies nine repository-local Trace artifact/activity declarations as obsolete.
The Daemon now owns immutable Run-level Captured Artifacts; it has no Phase-local prompt, session,
diff, or occurrence API. No current Waterfall, detail, Gate, polling, degraded-state, or Run-list
behavior is removed.

| Removed suite | Declarations | Current/adapted | Obsolete | Current evidence |
| --- | ---: | ---: | ---: | --- |
| `degraded.spec.ts` | 3 | 3 | 0 | `projectCatalogue.spec.ts`, `workflowCatalogue.spec.ts`, `reconnect.spec.ts` |
| `detailPanel.spec.ts` | 35 | 26 | 9 | `runConsole.spec.ts`, `daemonComponents.spec.ts`, `waterfall.spec.ts` |
| `gate.spec.ts` | 23 | 23 | 0 | `gateVerdict.spec.ts`, `runConsole.spec.ts`, `daemonComponents.spec.ts` |
| `polling.spec.ts` | 2 | 2 | 0 | Restored as authenticated Daemon browser evidence in `polling.spec.ts` |
| `realRun.spec.ts` | 5 | 5 | 0 | `runConsole.spec.ts`, `gateVerdict.spec.ts`, shipped-Daemon release evidence |
| `runList.spec.ts` | 5 | 5 | 0 | `runConsole.spec.ts` |
| `waterfall.spec.ts` | 40 | 40 | 0 | Restored in `waterfall.spec.ts`; that file now has 41 Waterfall and 18 detail leaves |
| **Total** | **113** | **104** | **9** | |

The 59 declarations in the current `waterfall.spec.ts` are not all Waterfall cases: 41 test the
Waterfall and 18 test the current detail panels. The Waterfall adaptation retains every fixed-point
assertion category: Host and acquisition rows,
scope placement, rebuild rows, collapsed Gate and idle breaks, all-row walls, wall-clock mode,
concurrency geometry, in-flight Phase growth and settlement, failure/breach/interruption/kind and
correction marks, read-only behavior, scale selection, zoom, selection, hover, table parity, empty
state, catalogue navigation, hit testing, tick uniqueness at 40 and 400 days, resize stability, pan,
modifier-wheel zoom, the canonical 41-hour break, and long-duration labels. The extra current leaf
checks a distinct in-flight table record. Additional detail-panel leaves keep the old assertions
that still describe the breaking Console contract.

The detail-panel audit is leaf-based. Leaves 1–13 map to the Phase deep-link, close/view retention,
summary, Agent identity/model/session/resume/token/context/correction, Host/Sandbox, invalid answer,
failed-check, repository-disagreement, breach, and invalid-Phase assertions in `waterfall.spec.ts`.
Leaves 23–35 map to the Sandbox acquisition/cross-panel/held state, missing Run, layout, Run failure,
and provenance assertions in `waterfall.spec.ts`, `runConsole.spec.ts`, and
`daemonComponents.spec.ts`. The fixture carries real public Agent and repository fields through the
authenticated Daemon Run contract; the tests do not inject internal `RunDoc` data.

Old leaves 14–18 and 19–22 are obsolete as written. They require Phase-local prompt/session/diff
artifact panes and an occurrence polling endpoint. #64 makes Captured Artifacts immutable Run-level
resources and removes repository-local Trace readers and activity-event APIs. Current Artifact
authorization, lazy content, download, hash, and reload behavior remains in `artifact.spec.ts`.

The exact `detailPanel.spec.ts` declaration mapping is:

| Old leaf | Classification | Current exact evidence |
| ---: | --- | --- |
| 1 | adapted | `clicking a Phase span writes its exact Phase URL` |
| 2 | adapted | same leaf includes direct URL and reload selection |
| 3 | adapted | `closing and toggling a Phase panel preserve the selected Run view` |
| 4 | adapted | `closing and toggling a Phase panel preserve the selected Run view` and `the table toggle renders every Waterfall Phase and persists in the URL` |
| 5 | adapted | `a Phase panel shows Agent session, token, correction, and repository facts` plus Phase Summary/Where fields |
| 6 | adapted | `code and Host Phases do not invent Agent or Sandbox facts` |
| 7 | adapted | same code-Phase leaf requires no Agent pane |
| 8 | adapted | `an invalid Agent answer is an error and does not invent verification fields` |
| 9 | adapted | `Phase errors keep failed checks and permission outcomes distinct` |
| 10 | adapted | `failed checks include a failure that never completed its Run check` |
| 11 | adapted | Agent/repository-facts leaf requires claimed/changed disagreement |
| 12 | adapted | `Phase errors keep failed checks and permission outcomes distinct` |
| 13 | adapted | invalid-Phase deep-link leaf keeps the Waterfall and closes normally |
| 14 | obsolete | removed Phase-local prompt/session/diff fetch API |
| 15 | obsolete | removed Phase-local session artifact; correction count remains in leaf 5 |
| 16 | obsolete | removed Phase-local diff pane |
| 17 | obsolete | removed Phase-local Agent artifact pane; Agent error remains in leaves 8/10 |
| 18 | obsolete | removed Phase-local Agent artifact pane; in-flight state remains in Waterfall cases |
| 19 | obsolete | removed occurrence streaming API |
| 20 | obsolete | removed occurrence list/poll API |
| 21 | obsolete | removed occurrence detail API |
| 22 | obsolete | removed occurrence list API |
| 23 | adapted | `a Sandbox deep link shows the exact acquisition and its Phase` |
| 24 | adapted | `the second Sandbox acquisition exposes Gate idle time and setup cost` |
| 25 | adapted | `a Phase and its Sandbox acquisition remain one link apart` |
| 26 | adapted | `a held Sandbox panel states which release facts are not recorded yet` |
| 27 | adapted | `a missing Run is a settled answer and not a reconnecting outage` |
| 28 | adapted | `the Phase panel keeps one page scroll and the whole Waterfall axis reachable` |
| 29 | adapted | `the Phase panel keeps one page scroll and the whole Waterfall axis reachable` |
| 30 | adapted | `the Phase panel keeps one page scroll and the whole Waterfall axis reachable` |
| 31 | adapted | `failed Run outcome and labelled provenance remain on the Run page` |
| 32 | adapted | `a successful Run has no failure outcome and a Host-only Run states no branch` |
| 33 | adapted | `the Waterfall stays visible while a person reads the Phase panel` |
| 34 | adapted | `failed Run outcome and labelled provenance remain on the Run page` |
| 35 | adapted | `a successful Run has no failure outcome and a Host-only Run states no branch` |

The Gate and real-Run declarations remain current as Recorded/Applied, expiry, answering,
structured Asking routes, and rebuilt Sandbox behavior. Their adaptations record only a Verdict
through the Daemon; no client applies it.

The three degraded declarations remain current at new ownership seams: a registered Project can have
a Missing Factory, a Project can have no current Workflow, and a disconnected Console preserves the
last authoritative snapshot. Both polling declarations remain current because live Runs still use
the accepted one-second refresh interval and terminal Runs stop that interval. Their adaptations use
the authenticated Daemon transport. Separate current tests require a per-attempt five-second
notification deadline, two retries, an explicit Reconnect state, mutation lockout, and fresh
authoritative reads before actions return.

## Restored current-contract suites

The audit restores 38 suites. Each path keeps its suffix and moves from
`packages/kojo/tests/<tier>/` to `packages/kojo-runtime/tests/<tier>/`.

| Old path suffix | New path suffix |
| --- | --- |
| `unit/contexts/agent/adapters/InMemoryAgentInvoker.test.ts` | same |
| `unit/contexts/agent/services/envelopeBlock.test.ts` | same |
| `unit/contexts/agent/services/piSession.test.ts` | same |
| `unit/contexts/agent/services/renderPrompt.test.ts` | same |
| `unit/contexts/gate/models/AskedGate.test.ts` | same |
| `unit/contexts/sandbox/guards/hiddenPaths.test.ts` | same |
| `unit/contexts/sandbox/adapters/InMemoryWorkspace.test.ts` | same |
| `unit/contexts/sandbox/guards/workspaceIsReachable.test.ts` | same |
| `unit/contexts/sandbox/guards/worktreeIsUsable.test.ts` | same |
| `unit/contexts/sandbox/models/SandboxHooks.test.ts` | same |
| `unit/contexts/sandbox/models/SandboxProvider.test.ts` | same |
| `unit/contexts/shared/models/RunBranch.test.ts` | same |
| `unit/contexts/workflow/guards/Permissions.test.ts` | same |
| `unit/contexts/workflow/guards/checks.test.ts` | same |
| `unit/contexts/workflow/guards/pathPattern.test.ts` | same |
| `unit/contexts/workflow/models/Acceptance.test.ts` | same |
| `unit/contexts/workflow/models/Envelope.test.ts` | same |
| `unit/contexts/workflow/models/PermissionBreach.test.ts` | same |
| `unit/contexts/workflow/services/acceptance.test.ts` | same |
| `unit/contexts/workflow/services/compensation.test.ts` | same |
| `unit/contexts/workflow/services/corrections.test.ts` | same |
| `unit/contexts/workflow/services/phase/agent.test.ts` | same |
| `unit/contexts/workflow/services/phase/checkedAgent.test.ts` | same |
| `unit/contexts/workflow/services/phase/commit.test.ts` | same |
| `unit/contexts/workflow/services/phase/merge.test.ts` | same |
| `unit/contexts/workflow/services/phase/whereItRan.test.ts` | same |
| `unit/contexts/workflow/services/reviewed.test.ts` | same |
| `unit/contexts/workflow/services/sandboxed.test.ts` | same |
| `integration/contexts/agent/adapters/SandcastleAgentInvoker.test.ts` | same |
| `integration/contexts/agent/adapters/YamlRoster.test.ts` | same |
| `integration/contexts/agent/adapters/kojoPi.test.ts` | `integration/contexts/agent/adapters/kojoPiProcess.test.ts` |
| `integration/contexts/sandbox/adapters/BindMountWorkspace.test.ts` | same |
| `integration/contexts/sandbox/adapters/SandboxExecWorkspace.test.ts` | same |
| `integration/contexts/sandbox/adapters/SandcastleSandboxSource.test.ts` | same |
| `integration/contexts/sandbox/adapters/boundary.test.ts` | same |
| `integration/contexts/sandbox/adapters/providerEnvironment.test.ts` | same |
| `integration/contexts/sandbox/adapters/providers.test.ts` | same |
| `integration/contexts/workflow/guards/Permissions.test.ts` | same |

The restored suites use `@effect/vitest`. Unit suites use in-memory adapters. Integration suites use
real process, file-system, Git, or sandbox adapters. Current Daemon ownership changes are part of
the assertions: `.kojo/artifacts` is protected, Resource identity variables cross the sandbox
boundary, compensation follows the current replay result, and `.kojo/data` is tested only as a
barred historic Project path. The restored in-memory adapter suites retain script exhaustion,
resume refusal, unsafe-command refusal, traversal safety, write, stat, and unlink coverage.
`SandcastleAgentInvoker.test.ts` stays in the integration tier because it uses the real Sandcastle,
YamlRoster, Daemon Resource, Artifact, sandbox, Git, file-system, and child-process adapters. Its
scripted Agent Provider is an executable process boundary, not an in-memory port layer.
`tests/unit/contexts/workflow/services/DaemonWorkflowReplay.test.ts` uses the pure
`DaemonWorkflowReplay` identity and replay-decision service without any adapter. The substantive
`DaemonWorkflowEngine` adapter owns Effect Workflow encoding, registration, execution, Activity,
and deferred composition. The real adapter stays covered by the Runner process integration in
`tests/integration/contexts/workflow/replay.test.ts`.
`tests/unit/contexts/daemon/services/launchConsole.test.ts` moved to a mirrored unit path because its Console
access and Browser Service ports are controlled; authenticated browser and CLI tests keep the real
Host transport boundary. `removePurge.test.ts` stays in Integration and now uses the concrete systemd
service adapter with controlled native command results, together with its real SQLite, file-system,
process, and recovery-capsule boundaries. `SandboxExecWorkspace.test.ts` performs its sequential
build and check directly through the real sandbox Workspace. The Integration tier does not count a
hand-built port as a real boundary.

The lifecycle-control test boundary follows the same rule. Pure request and owner-byte validation
lives in the unit `LifecycleControlProtocol.test.ts` suite. Endpoint loss and durable resume stay in
the unit `LifecycleController.test.ts` use-case suite. The real Unix-socket lifecycle adapter remains
in `ownership.test.ts`. The real `SocketDaemonUpgradeControl` client runs against a private Daemon
socket in the staged-release `activation.test.ts` integration case. Controlled readiness and rollback
outcomes stay in the unit
`UpgradeActivationController.test.ts` suite. The old mixed socket-plus-fake-control integration
suite is therefore split without dropping a current behavior.

## Prepared mutation replay matrix

The exact operation inventory has 18 entries. Sixteen SQLite owners use the real
`SqliteOperationRepository` receipt boundary. `SqliteMutationOwnerEvidence.ts` is the mechanical
operation-to-leaf manifest. Its exhaustive typed registry binds every operation to an imported
production owner identity, including `checkDaemonUpgrade` to `SqliteUpgradePreflightRepository`.
Its validator fails when one accepted operation has no exact declared leaf, when an owner differs
from the imported registry identity, or when the named leaf is absent. Each named real-owner leaf invokes its domain adapter or
private HTTP boundary and proves the initial effect and receipt, same-content replay with the
original result and no second effect, and changed-content conflict. The generic SQLite transaction
test is infrastructure evidence only. The two Host-file owners use their own real adapter tests and
do not enter the SQLite manifest.

| Operation | Real owner evidence |
| --- | --- |
| `registerProject`, `relocateProject`, `archiveProject`, `restoreProject` | `registration.test.ts` |
| `configureProject`, `configureDaemon`, `confirmDaemonConfiguration` | `ownership.test.ts` |
| `repairProject` | `runnerRecovery.test.ts` |
| `repairRevision`, `collectRevision` | `runApi.test.ts`, `revisionRepair.test.ts` |
| `startWorkflow`, `stopWorkflow` | `activity.test.ts`, `runApi.test.ts` |
| `cancelRun` | `forcedStop.test.ts` |
| `retryUncertainAction` | `uncertainAction.test.ts`, `cliContract.test.ts` |
| `recordGateVerdict` | `application.test.ts` |
| `checkDaemonUpgrade` | `activation.test.ts` |
| `repairDaemonSupervision` | `adapters/HostClientRequestRepository.test.ts` |
| `repairPurgeSafety` | `removePurge.test.ts` |

The Host supervision and purge tests apply the same request twice and prove that the second call
uses the retained result without a second external side effect. The purge leaf uses a one-use
capability, so any repeated child application fails the test.
`CLIENT-01` names all sixteen SQLite owner observations and both Host owner observations. Its
collector test removes each Host leaf in turn and proves that either missing leaf closes the gate.

The current CLI command suites are also retained. Their pure command and formatting behavior moved
from `tests/integration/cli` to mirrored `tests/unit/contexts/{daemon,gate,project,scaffold,shared,
workflow}/adapters`, where they use in-memory dependencies. `gateAndResume.test.ts` remains an
integration test because it uses a real Daemon, SQLite, private HTTP, and a child CLI process.
`cliContract.test.ts` adds the same real boundary for selectors, JSON and JSON Lines, waits,
uncertainty retries, privacy, and exit codes 0 through 4.

The obsolete `integration/cli/duplicateEffect.test.ts` is not restored as a CLI suite. Its current
contract is retained as a focused validation integration leaf: a real second physical Effect copy
makes Factory Refresh report the Factory as Invalid before it executes a Workflow.

One superseded current suite was removed:
`packages/kojo-runtime/tests/integration/contexts/agent/adapters/kojoPi.test.ts`. Its only process
case is fully present in `kojoPiProcess.test.ts`, together with command, system prompt, tools,
standard input, and session checks. This removal does not change the 38 restored-suite mapping:
`kojoPiProcess.test.ts` is still the current target for the old `kojoPi.test.ts` behavior. No Gate,
cutover, evidence, recovery, or safety test was removed.

## Obsolete old-codebase suites

The other 68 removed suites are not restored. They test one or more removed contracts:

- Old CLI and Console suites test the removed local execution owner, `watch`, old Factory
  commands, or the removed embedded Console. Current CLI unit, integration, and browser suites
  replace these contracts.
- Adapter suites test removed SQLite readers, the old Gate repository, old Trigger inbox, old
  trace readers, or old in-memory seams. Daemon repositories and the private Runner channel now own
  these behaviors and have current tests.
- Workflow suites test `SingleNodeEngine`, `InMemoryClusterEngine`, lanes, `oneRunner`,
  `durability`, `stopped`, and the old Factory execution owner. These types do not exist in the new
  runtime.
- Policy and fixture suites test removed `AgentSpend`, spawn-site policy, session transfer,
  invisible checks, risk notes, old example Workflows, and aggregate removed error types.

The exact obsolete inventory is:

```text
integration/cli/correctionLoop.test.ts
integration/cli/doctor.test.ts
integration/cli/duplicateEffect.test.ts
integration/cli/factoryCommands.test.ts
integration/cli/failedRun.test.ts
integration/cli/initInstructions.test.ts
integration/cli/landsOnTrunk.test.ts
integration/cli/realAgent.test.ts
integration/cli/stampedRun.test.ts
integration/cli/ui.test.ts
integration/cli/watch.test.ts
integration/console/api.test.ts
integration/console/gateAnswer.test.ts
integration/console/shell.test.ts
integration/contexts/agent/adapters/kojoPiRealSession.test.ts
integration/contexts/agent/guards/spawnAgent.test.ts
integration/contexts/gate/adapters/SqliteGateRepository.test.ts
integration/contexts/sandbox/adapters/hiddenFactoryPaths.test.ts
integration/contexts/scaffold/services/initialise.test.ts
integration/contexts/shared/adapters/SqliteDatabase.test.ts
integration/contexts/shared/adapters/oneFileTwoSchemas.test.ts
integration/contexts/trace/adapters/SqliteTraceReader.test.ts
integration/contexts/trace/adapters/SqliteTracer.test.ts
integration/contexts/trace/adapters/WorkspaceArtifactReader.test.ts
integration/contexts/trigger/adapters/InboxTrigger.test.ts
integration/contexts/workflow/adapters/SingleNodeEngine.test.ts
integration/contexts/workflow/services/compensation.test.ts
integration/contexts/workflow/services/factory.test.ts
integration/contexts/workflow/services/lane.test.ts
integration/contexts/workflow/services/parallelLanes.test.ts
integration/contexts/workflow/services/unreachableWorkspace.test.ts
integration/factory/ownFactory.test.ts
unit/cli/ends.test.ts
unit/cli/failureLine.test.ts
unit/cli/gateTable.test.ts
unit/cli/phaseTable.test.ts
unit/cli/watchLine.test.ts
unit/cli/workflows.test.ts
unit/console/FactoryHealth.test.ts
unit/console/api.test.ts
unit/console/application.test.ts
unit/console/fixtures.test.ts
unit/console/ui.test.ts
unit/contexts/agent/adapters/InMemoryRoster.test.ts
unit/contexts/agent/guards/agentSpawnSites.test.ts
unit/contexts/agent/guards/invisibleChecks.test.ts
unit/contexts/agent/guards/maySpawn.test.ts
unit/contexts/agent/models/AgentSpend.test.ts
unit/contexts/agent/services/riskNoteDesign.test.ts
unit/contexts/gate/adapters/RecordingGate.test.ts
unit/contexts/gate/adapters/TerminalGate.test.ts
unit/contexts/gate/gate.test.ts
unit/contexts/sandbox/guards/sessions.test.ts
unit/contexts/trace/adapters/InMemoryArtifactReader.test.ts
unit/contexts/trace/adapters/InMemoryTraceReader.test.ts
unit/contexts/trace/adapters/RecordingTracer.test.ts
unit/contexts/trace/guards/identifiers.test.ts
unit/contexts/trigger/trigger.test.ts
unit/contexts/trigger/watch.test.ts
unit/contexts/workflow/adapters/InMemoryClusterEngine.test.ts
unit/contexts/workflow/hello.test.ts
unit/contexts/workflow/models/RunnerRegistration.test.ts
unit/contexts/workflow/models/errors.test.ts
unit/contexts/workflow/services/durability.test.ts
unit/contexts/workflow/services/lanes.test.ts
unit/contexts/workflow/services/oneRunner.test.ts
unit/contexts/workflow/services/run.test.ts
unit/contexts/workflow/services/stopped.test.ts

```

The audit also rejects eight tempting but obsolete restorations by exact path:

- `integration/contexts/agent/adapters/kojoPiRealSession.test.ts` starts a paid live provider.
- `integration/contexts/sandbox/adapters/hiddenFactoryPaths.test.ts` mixes the removed Factory owner
  with the hidden-path guard. The pure current guard suite is restored.
- `integration/contexts/workflow/services/compensation.test.ts`
- `integration/contexts/workflow/services/factory.test.ts`
- `integration/contexts/workflow/services/lane.test.ts`
- `integration/contexts/workflow/services/parallelLanes.test.ts`
- `integration/contexts/workflow/services/unreachableWorkspace.test.ts`
- `unit/contexts/workflow/models/errors.test.ts`

The last six paths depend on removed engine or aggregate-error ownership. Their current domain
invariants remain covered by the restored runtime compensation, workspace, Envelope, Acceptance,
and phase suites. No current negative cutover, evidence, recovery, or safety test was removed.
