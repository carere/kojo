import type {
  ConfigurationApplyResult,
  ConfigurationCheck,
  ConfigurationStatus,
} from "../models/Configuration.ts";
import type { DaemonStatus } from "../models/DaemonStatus.ts";
import type { LifecycleOperationStatus } from "../models/LifecycleOperation.ts";
import type { UpgradeCheckReport } from "../models/ManagedUpgrade.ts";
import type { DaemonSupervisionStatus } from "./ManagedDaemonSupervision.ts";

export const daemonCommandLine = (name: string, value: string): string => `${name}: ${value}.`;

export const configurationStatusLines = (status: ConfigurationStatus): ReadonlyArray<string> => [
  daemonCommandLine("Configuration scope", status.scope),
  ...(status.projectId === undefined ? [] : [daemonCommandLine("Project", status.projectId)]),
  daemonCommandLine("Configuration state version", String(status.stateVersion)),
  daemonCommandLine("Explicit lifecycle restart required", status.restartRequired ? "yes" : "no"),
  ...status.fields.map((field) =>
    daemonCommandLine(
      field.path,
      `effective=${JSON.stringify(field.effective)} default=${JSON.stringify(field.default)} scope=${field.scope} activation=${field.activation}${field.pending === undefined ? "" : ` pending=${JSON.stringify(field.pending)}`}`,
    ),
  ),
];

export const configurationCheckLines = (check: ConfigurationCheck): ReadonlyArray<string> => [
  ...configurationStatusLines(check.proposed),
  ...(check.plan === undefined
    ? [daemonCommandLine("Retention plan", "not required")]
    : [
        daemonCommandLine("Retention plan", check.plan.planId),
        daemonCommandLine("Plan data identity", check.plan.dataIdentity),
        daemonCommandLine("Plan request hash", check.plan.requestHash),
        daemonCommandLine("Plan scope", check.plan.affectedScope),
        daemonCommandLine("Plan configuration state", String(check.plan.expectedStateVersion)),
        daemonCommandLine("Plan retained-data state", check.plan.expectedDataState),
        daemonCommandLine("Plan issued at", check.plan.issuedAt),
        daemonCommandLine("Plan expires at", check.plan.expiresAt),
        daemonCommandLine("Plan changes", JSON.stringify(check.plan.changes)),
        daemonCommandLine(
          "Runs selected for correctness collection",
          check.plan.impact.runIds.join(", ") || "none",
        ),
        daemonCommandLine(
          "Runs selected for Trace collection",
          check.plan.impact.traceRunIds.join(", ") || "none",
        ),
        daemonCommandLine(
          "Artifacts selected for collection",
          check.plan.impact.artifactIds.join(", ") || "none",
        ),
        daemonCommandLine("Protected Runs", check.plan.impact.protectedRunIds.join(", ") || "none"),
      ]),
];

export const configurationApplyLines = (
  applied: ConfigurationApplyResult,
): ReadonlyArray<string> => [
  ...configurationStatusLines(applied.status),
  daemonCommandLine("Collected Run correctness", applied.collection.runs.join(", ") || "none"),
  daemonCommandLine("Collected Traces", applied.collection.traces.join(", ") || "none"),
  daemonCommandLine("Collected Artifacts", applied.collection.artifacts.join(", ") || "none"),
];

export const supervisionLines = (status: DaemonSupervisionStatus): ReadonlyArray<string> => [
  daemonCommandLine("Daemon supervision", status.state),
  daemonCommandLine("Daemon restart attempts remaining", String(status.restartAttemptsRemaining)),
  daemonCommandLine("Daemon supervision repair required", status.repairRequired ? "yes" : "no"),
  daemonCommandLine("Daemon restart delays", JSON.stringify(status.policy.restartDelaysMs)),
  daemonCommandLine("Daemon healthy reset", `${status.policy.healthyResetMs} ms`),
  ...(status.lastFailure === undefined
    ? []
    : [
        daemonCommandLine("Last Daemon failure", status.lastFailure.failedAt),
        daemonCommandLine("Last Daemon failure detail", status.lastFailure.detail),
      ]),
  ...(status.repairPlan === undefined
    ? []
    : [
        daemonCommandLine("Daemon repair plan", status.repairPlan.planId),
        daemonCommandLine("Daemon repair expected state", status.repairPlan.expectedState),
        daemonCommandLine("Daemon repair plan issued", status.repairPlan.issuedAt),
        daemonCommandLine("Daemon repair plan expires", status.repairPlan.expiresAt),
      ]),
  ...(status.lastRepair === undefined
    ? []
    : [
        daemonCommandLine("Last applied Daemon repair plan", status.lastRepair.planId),
        daemonCommandLine("Last Daemon repair applied", status.lastRepair.appliedAt),
      ]),
];

export const daemonStatusLines = (status: DaemonStatus): ReadonlyArray<string> => [
  daemonCommandLine("Installed", status.installed ? "yes" : "no"),
  daemonCommandLine("Managed CLI", status.managedCli),
  daemonCommandLine("Automatic start", status.automaticStart),
  daemonCommandLine("Manager", status.manager),
  daemonCommandLine("Process", status.process),
  daemonCommandLine("Responsive", status.responsiveness),
  daemonCommandLine("Ready", status.ready ? "yes" : "no"),
  daemonCommandLine("Supported lifetime", status.loginLifetime),
  daemonCommandLine("Keep running after logout", status.logoutPersistence),
  ...(status.detail === undefined ? [] : [daemonCommandLine("Manager detail", status.detail)]),
];

export const lifecycleStatusLines = (status: LifecycleOperationStatus): ReadonlyArray<string> => [
  daemonCommandLine("Lifecycle operation", status.operation.operationId),
  daemonCommandLine("Lifecycle kind", status.operation.kind),
  daemonCommandLine("Lifecycle outcome", status.outcome),
  daemonCommandLine("Last lifecycle stage", status.operation.stage),
  daemonCommandLine(
    "Recorded Daemon owner",
    status.recordedOwner?.daemonInstanceId ?? "not recorded",
  ),
  daemonCommandLine(
    "Recorded Runner owners",
    status.recordedOwner?.runnerInstanceIds.join(", ") || "none",
  ),
  daemonCommandLine(
    "Observed Daemon owner",
    status.observedOwner.daemonInstanceId ?? "not observed",
  ),
  daemonCommandLine("Observed manager", status.observedOwner.manager),
  daemonCommandLine("Observed process", status.observedOwner.process),
  daemonCommandLine(
    "Executing Runs in drain",
    String(status.progress?.executingRunIds.length ?? 0),
  ),
  daemonCommandLine("Next permitted action", status.nextPermittedAction),
];

export const upgradeStatusLines = (report: UpgradeCheckReport): ReadonlyArray<string> => [
  daemonCommandLine("Managed upgrade check", report.outcome),
  daemonCommandLine("Staged candidate", report.candidateReleaseId),
  daemonCommandLine("Active source release", report.sourceReleaseId),
  daemonCommandLine("Checked Daemon data", report.dataIdentity),
  daemonCommandLine("Checked retained set", report.retainedSetHash),
  daemonCommandLine("Checked at", report.checkedAt),
  daemonCommandLine("Checked current Workflows", String(report.checked.currentWorkflows)),
  daemonCommandLine("Checked retained Runs", String(report.checked.retainedRuns)),
  daemonCommandLine("Checked terminal Runs", String(report.checked.terminalRuns)),
  daemonCommandLine("Checked validation references", String(report.checked.validations)),
  daemonCommandLine("Checked readers", String(report.checked.readers)),
  daemonCommandLine("Checked Workflow Revisions", String(report.checked.revisions)),
  daemonCommandLine("Rollback-loss approval", report.rollbackApproval),
  ...report.compatibilityFaults.map((fault) =>
    daemonCommandLine(
      `Compatibility ${fault.code}${fault.revisionId === undefined ? "" : ` for ${fault.revisionId}`}`,
      `${fault.detail} Scope: ${fault.affectedScope.join(", ") || "none"}. Remedy: ${fault.remedy}`,
    ),
  ),
  ...report.existingFaults.map((fault) =>
    daemonCommandLine(
      `Existing ${fault.code}${fault.revisionId === undefined ? "" : ` for ${fault.revisionId}`}`,
      `${fault.detail} Scope: ${fault.affectedScope.join(", ") || "none"}. Remedy: ${fault.remedy}`,
    ),
  ),
  ...(report.plan === undefined
    ? []
    : [
        daemonCommandLine("No-rollback plan", report.plan.planId),
        daemonCommandLine("Plan affected scope", report.plan.affectedScope.join(", ") || "none"),
        daemonCommandLine("Plan state version", report.plan.expectedStateVersion),
        daemonCommandLine(
          "Migration consequence",
          `${report.plan.migration.description}; rollback from data format ${report.plan.migration.toDataFormat} to ${report.plan.migration.fromDataFormat} is not available`,
        ),
        daemonCommandLine("Plan expiry", report.plan.expiresAt),
      ]),
  daemonCommandLine("Managed upgrade remedy", report.remedy),
];
