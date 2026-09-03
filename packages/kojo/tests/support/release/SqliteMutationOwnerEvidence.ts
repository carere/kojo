import { ManagedDaemonSupervision } from "../../../src/contexts/daemon/adapters/ManagedDaemonSupervision.ts";
import { PurgeSafetyRecovery } from "../../../src/contexts/daemon/adapters/PurgeSafetyRecovery.ts";
import { SqliteConfigurationRepository } from "../../../src/contexts/daemon/adapters/SqliteConfigurationRepository.ts";
import { SqliteUpgradePreflightRepository } from "../../../src/contexts/daemon/adapters/SqliteUpgradePreflightRepository.ts";
import { SqliteDaemonGateRepository } from "../../../src/contexts/gate/adapters/SqliteDaemonGateRepository.ts";
import { SqliteProjectRecoveryRepository } from "../../../src/contexts/project/adapters/SqliteProjectRecoveryRepository.ts";
import { SqliteProjectRepository } from "../../../src/contexts/project/adapters/SqliteProjectRepository.ts";
import { SqliteExternalActionRepository } from "../../../src/contexts/workflow/adapters/SqliteExternalActionRepository.ts";
import { SqliteRevisionRepository } from "../../../src/contexts/workflow/adapters/SqliteRevisionRepository.ts";
import { SqliteRunRepository } from "../../../src/contexts/workflow/adapters/SqliteRunRepository.ts";

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

export type SqliteMutationOperation = (typeof sqliteMutationOperations)[number];

interface OwnerIdentity {
  readonly name: string;
}

/** Exhaustive operation ownership bound to imported production adapter identity. */
export const sqliteMutationOwnerRegistry = {
  registerProject: SqliteProjectRepository,
  relocateProject: SqliteProjectRepository,
  archiveProject: SqliteProjectRepository,
  restoreProject: SqliteProjectRepository,
  configureProject: SqliteConfigurationRepository,
  repairProject: SqliteProjectRecoveryRepository,
  repairRevision: SqliteRevisionRepository,
  collectRevision: SqliteRevisionRepository,
  startWorkflow: SqliteRunRepository,
  stopWorkflow: SqliteProjectRepository,
  cancelRun: SqliteRunRepository,
  retryUncertainAction: SqliteExternalActionRepository,
  recordGateVerdict: SqliteDaemonGateRepository,
  configureDaemon: SqliteConfigurationRepository,
  confirmDaemonConfiguration: SqliteConfigurationRepository,
  checkDaemonUpgrade: SqliteUpgradePreflightRepository,
} satisfies Record<SqliteMutationOperation, OwnerIdentity>;

interface MutationOwnerEvidence {
  readonly operation: SqliteMutationOperation;
  readonly owner: string;
  readonly path: string;
  readonly name: string;
  readonly declaration?: string;
}

const evidence = (
  operation: MutationOwnerEvidence["operation"],
  owner: OwnerIdentity,
  path: string,
  name: string,
  declaration?: string,
): MutationOwnerEvidence => ({
  operation,
  owner: owner.name,
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
    sqliteMutationOwnerRegistry.registerProject,
    "packages/kojo/tests/integration/contexts/project/registration.test.ts",
    "keeps exact worktree identity, duplicates, atomic receipts, and Factory states",
  ),
  ...(["relocateProject", "archiveProject", "restoreProject"] as const).map((operation) =>
    evidence(
      operation,
      sqliteMutationOwnerRegistry[operation],
      "packages/kojo/tests/integration/contexts/project/registration.test.ts",
      projectLocationLeaf,
    ),
  ),
  evidence(
    "configureProject",
    sqliteMutationOwnerRegistry.configureProject,
    "packages/kojo/tests/integration/contexts/daemon/ownership.test.ts",
    configurationLeaf,
  ),
  evidence(
    "repairProject",
    sqliteMutationOwnerRegistry.repairProject,
    "packages/kojo/tests/integration/contexts/project/runnerRecovery.test.ts",
    "confirms the crashed group stopped and continues the same Run in one replacement",
  ),
  evidence(
    "repairRevision",
    sqliteMutationOwnerRegistry.repairRevision,
    "packages/kojo/tests/integration/contexts/workflow/runApi.test.ts",
    "admits an exact retained revision and seals its stopped Runner cache for removal",
  ),
  evidence(
    "collectRevision",
    sqliteMutationOwnerRegistry.collectRevision,
    "packages/kojo/tests/integration/contexts/workflow/revisionRepair.test.ts",
    "excludes new readers atomically, waits 24 hours, and keeps shared objects",
  ),
  evidence(
    "startWorkflow",
    sqliteMutationOwnerRegistry.startWorkflow,
    "packages/kojo/tests/integration/contexts/workflow/activity.test.ts",
    "atomically admits a no-Trigger Run, activates its Workflow, and records its exact replay",
  ),
  evidence(
    "stopWorkflow",
    sqliteMutationOwnerRegistry.stopWorkflow,
    "packages/kojo/tests/integration/contexts/workflow/runApi.test.ts",
    "runs one authored Trigger poller, acknowledges after durable admission, and stops its boundary",
  ),
  evidence(
    "cancelRun",
    sqliteMutationOwnerRegistry.cancelRun,
    "packages/kojo/tests/integration/contexts/workflow/forcedStop.test.ts",
    "force-stops the owned process group after the cooperative deadline and confirms before reply",
  ),
  evidence(
    "retryUncertainAction",
    sqliteMutationOwnerRegistry.retryUncertainAction,
    "packages/kojo/tests/integration/contexts/workflow/uncertainAction.test.ts",
    "holds an arbitrary action after its effect result is lost and consumes one exact retry authorization",
  ),
  evidence(
    "recordGateVerdict",
    sqliteMutationOwnerRegistry.recordGateVerdict,
    "packages/kojo/tests/integration/contexts/gate/application.test.ts",
    "keeps an on-time Verdict Recorded until a later fenced Runner marks it Applied",
  ),
  ...(["configureDaemon", "confirmDaemonConfiguration"] as const).map((operation) =>
    evidence(
      operation,
      sqliteMutationOwnerRegistry[operation],
      "packages/kojo/tests/integration/contexts/daemon/ownership.test.ts",
      configurationLeaf,
    ),
  ),
  evidence(
    "checkDaemonUpgrade",
    sqliteMutationOwnerRegistry.checkDaemonUpgrade,
    "packages/kojo/tests/integration/contexts/daemon/activation.test.ts",
    "holds ordinary mutations, verifies backup, migrates restricted, and activates without Workflow execution",
  ),
];

export const hostMutationOwnerEvidence = [
  {
    operation: "repairDaemonSupervision" as const,
    owner: ManagedDaemonSupervision.name,
    path: "packages/kojo/tests/integration/contexts/daemon/adapters/HostClientRequestRepository.test.ts",
    name: "replays an exact Host repair without accepting replacement content",
  },
  {
    operation: "repairPurgeSafety" as const,
    owner: PurgeSafetyRecovery.name,
    path: "packages/kojo/tests/integration/contexts/daemon/removePurge.test.ts",
    name: "recovers stale safety once and replays the exact Host result after loss and compaction",
  },
] as const;
