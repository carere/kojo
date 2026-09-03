export const sqliteMutationOperations = [
  "registerProject",
  "relocateProject",
  "archiveProject",
  "restoreProject",
  "configureProject",
  "repairProject",
  "repairRevision",
  "collectRevision",
  "startWorkflow",
  "stopWorkflow",
  "cancelRun",
  "retryUncertainAction",
  "recordGateVerdict",
  "configureDaemon",
  "confirmDaemonConfiguration",
  "checkDaemonUpgrade",
] as const;

interface MutationOwnerEvidence {
  readonly operation: (typeof sqliteMutationOperations)[number];
  readonly owner: string;
  readonly path: string;
  readonly name: string;
  readonly declaration?: string;
}

const evidence = (
  operation: MutationOwnerEvidence["operation"],
  owner: string,
  path: string,
  name: string,
  declaration?: string,
): MutationOwnerEvidence => ({
  operation,
  owner,
  path,
  name,
  ...(declaration === undefined ? {} : { declaration }),
});

const projectLocationLeaf =
  "requires explicit same-path confirmation and retains identity while locations change";
const configurationLeaf =
  "executes and replays exact Daemon and Project configuration owners through the private socket";

/** The exact actual-owner integration leaf for every SQLite-backed mutation operation. */
export const sqliteMutationOwnerEvidence: ReadonlyArray<MutationOwnerEvidence> = [
  evidence(
    "registerProject",
    "SqliteProjectRepository",
    "packages/kojo/tests/integration/contexts/project/registration.test.ts",
    "keeps exact worktree identity, duplicates, atomic receipts, and Factory states",
  ),
  ...(["relocateProject", "archiveProject", "restoreProject"] as const).map((operation) =>
    evidence(
      operation,
      "SqliteProjectRepository",
      "packages/kojo/tests/integration/contexts/project/registration.test.ts",
      projectLocationLeaf,
    ),
  ),
  evidence(
    "configureProject",
    "SqliteConfigurationRepository",
    "packages/kojo/tests/integration/contexts/daemon/ownership.test.ts",
    configurationLeaf,
  ),
  evidence(
    "repairProject",
    "SqliteProjectRecoveryRepository",
    "packages/kojo/tests/integration/contexts/project/runnerRecovery.test.ts",
    "confirms the crashed group stopped and continues the same Run in one replacement",
  ),
  evidence(
    "repairRevision",
    "SqliteRevisionRepository",
    "packages/kojo/tests/integration/contexts/workflow/runApi.test.ts",
    "admits an exact retained revision and seals its stopped Runner cache for removal",
  ),
  evidence(
    "collectRevision",
    "SqliteRevisionRepository",
    "packages/kojo/tests/integration/contexts/workflow/revisionRepair.test.ts",
    "excludes new readers atomically, waits 24 hours, and keeps shared objects",
  ),
  evidence(
    "startWorkflow",
    "SqliteRunRepository",
    "packages/kojo/tests/integration/contexts/workflow/activity.test.ts",
    "atomically admits a no-Trigger Run, activates its Workflow, and records its exact replay",
  ),
  evidence(
    "stopWorkflow",
    "SqliteProjectRepository",
    "packages/kojo/tests/integration/contexts/workflow/runApi.test.ts",
    "runs one authored Trigger poller, acknowledges after durable admission, and stops its boundary",
  ),
  evidence(
    "cancelRun",
    "SqliteRunRepository",
    "packages/kojo/tests/integration/contexts/workflow/forcedStop.test.ts",
    "force-stops the owned process group after the cooperative deadline and confirms before reply",
  ),
  evidence(
    "retryUncertainAction",
    "SqliteExternalActionRepository",
    "packages/kojo/tests/integration/contexts/workflow/uncertainAction.test.ts",
    "holds an arbitrary action after its effect result is lost and consumes one exact retry authorization",
  ),
  evidence(
    "recordGateVerdict",
    "SqliteDaemonGateRepository",
    "packages/kojo/tests/integration/contexts/gate/application.test.ts",
    "keeps an on-time Verdict Recorded until a later fenced Runner marks it Applied",
  ),
  ...(["configureDaemon", "confirmDaemonConfiguration"] as const).map((operation) =>
    evidence(
      operation,
      "SqliteConfigurationRepository",
      "packages/kojo/tests/integration/contexts/daemon/ownership.test.ts",
      configurationLeaf,
    ),
  ),
  evidence(
    "checkDaemonUpgrade",
    "SqliteUpgradeCheckRepository",
    "packages/kojo/tests/integration/contexts/daemon/activation.test.ts",
    "holds ordinary mutations, verifies backup, migrates restricted, and activates without Workflow execution",
  ),
];
