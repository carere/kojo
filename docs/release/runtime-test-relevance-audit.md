# Runtime test relevance audit

This audit compares the tests removed from `origin/main` with the breaking Daemon runtime. It keeps
tests when their production concept still exists in `packages/kojo-runtime`. It does not restore a
test only because its old file can compile.

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

The current CLI command suites are also retained. Their pure command and formatting behavior moved
from `tests/integration/cli` to mirrored `tests/unit/contexts/{daemon,gate,project,scaffold,shared,
workflow}/adapters`, where they use in-memory dependencies. `gateAndResume.test.ts` remains an
integration test because it uses a real Daemon, SQLite, private HTTP, and a child CLI process.
`cliContract.test.ts` adds the same real boundary for selectors, JSON and JSON Lines, waits,
uncertainty retries, privacy, and exit codes 0 through 4.

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
