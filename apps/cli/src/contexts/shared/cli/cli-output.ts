import type {
  ExecutionTraceEvent,
  ExecutionTracePage,
  ProjectListCursorError,
  ProjectMutationResult,
  ProjectOperationError,
  ProjectReadinessAssessment,
  ProjectReadinessOperationError,
  ProjectSnapshot,
  RequestKey,
  WorkflowRunOperationError,
  WorkflowRunSnapshot,
  WorkflowScheduleOccurrenceOperationError,
  WorkflowScheduleOccurrenceSnapshot,
  WorkflowScheduleOperationError,
  WorkflowScheduleSnapshot,
} from "@kojo/control";
import {
  IncompatibleProtocolError,
  LocalTransportError,
  UnsupportedControlCapabilityError,
} from "@kojo/control/local-client";

export interface CliFailure {
  readonly affectedResource?:
    | ProjectOperationError["affectedResource"]
    | WorkflowScheduleOperationError["affectedResource"]
    | WorkflowScheduleOccurrenceOperationError["affectedResource"]
    | WorkflowRunOperationError["affectedResource"];
  readonly code: string;
  readonly currentSchedule?: WorkflowScheduleSnapshot;
  readonly exitCode: number;
  readonly findingKeys?: ReadonlyArray<string>;
  readonly message: string;
  readonly next: string;
  readonly requestKey?: RequestKey;
}

export interface CliWarning {
  readonly code: string;
  readonly message: string;
  readonly next: string;
}

export const invalid = (next: string): CliFailure => ({
  code: "invalid-command",
  exitCode: 2,
  message: "Invalid command.",
  next,
});

export const transportFailure = (error: unknown): CliFailure =>
  error instanceof IncompatibleProtocolError
    ? {
        code: "incompatible-protocol",
        exitCode: 3,
        message: error.message,
        next: "Upgrade Kojo Host or this CLI so their protocol major versions match.",
      }
    : error instanceof UnsupportedControlCapabilityError
      ? {
          code: "unsupported-control-capability",
          exitCode: 3,
          message: error.message,
          next: "Upgrade Kojo Host or use a supported client operation.",
        }
      : error instanceof LocalTransportError
        ? {
            code: "host-unavailable",
            exitCode: 3,
            message: error.message,
            next: "Start the Kojo Host and try again.",
          }
        : {
            code: "host-request-failed",
            exitCode: 3,
            message: "Kojo Host request failed.",
            next: "Try the command again.",
          };

export const projectFailure = (
  result: Extract<ProjectMutationResult, { ok: false }>,
): CliFailure => ({
  ...result.error,
  requestKey: result.requestKey,
  exitCode: result.error.code === "project-layout-invalid" ? 1 : 4,
});

export const projectQueryFailure = (error: ProjectOperationError): CliFailure => ({
  ...error,
  exitCode: 4,
});

export const readinessFailure = (error: ProjectReadinessOperationError): CliFailure => ({
  ...error,
  exitCode: error.code === "stale-assessment" ? 4 : 1,
});

export const writeProjectReadiness = (
  command: string,
  assessment: ProjectReadinessAssessment,
  json: boolean,
  requestKey?: RequestKey,
) => {
  if (json) {
    process.stdout.write(
      `${JSON.stringify({
        schemaVersion: 1,
        command,
        ...(requestKey === undefined ? {} : { requestKey }),
        result: { assessment },
        warnings: [],
      })}\n`,
    );
    return;
  }
  process.stdout.write(
    `Project Identity: ${assessment.project.identity}\n` +
      `Path: ${assessment.project.path}\n` +
      `Condition: ${assessment.condition}\n` +
      `Assessment revision: ${assessment.revision}\n`,
  );
  process.stdout.write(
    `Capabilities:\n${assessment.capabilities
      .map(
        (capability) =>
          `  ${capability.available ? "available" : "blocked"}\t${capability.capability}${capability.findingKeys.length === 0 ? "" : ` (${capability.findingKeys.join(", ")})`}`,
      )
      .join("\n")}\n`,
  );
  if (assessment.findings.length === 0) {
    process.stdout.write("Readiness findings: none\n");
  } else {
    process.stdout.write("Readiness findings:\n");
    for (const finding of assessment.findings) {
      process.stdout.write(`  ${finding.code}\t${finding.summary}\n`);
      for (const repair of finding.actions) {
        process.stdout.write(`    Repair: ${repair.key} — ${repair.label}\n`);
      }
    }
  }
  for (const repair of assessment.repairs) {
    process.stdout.write(`Completed repair: ${repair.code}\t${repair.summary}\n`);
  }
  if (requestKey !== undefined) process.stdout.write(`Request Key: ${requestKey}\n`);
};

export const workflowRunFailure = (
  error: WorkflowRunOperationError,
  requestKey?: RequestKey,
): CliFailure => ({ ...error, requestKey, exitCode: 4 });

export const writeExecutionTracePage = (
  command: string,
  page: ExecutionTracePage,
  json: boolean,
) => {
  if (json) {
    process.stdout.write(
      `${JSON.stringify({ schemaVersion: 1, command, result: { page }, warnings: [] })}\n`,
    );
    return;
  }
  process.stdout.write(
    `Run State: ${page.runState}\nHigh-water sequence: ${page.highWaterSequence}\n` +
      `${page.events.length === 0 ? "No Execution Events.\n" : `${page.events.map(renderExecutionTraceEvent).join("\n")}\n`}`,
  );
  if (page.nextCursor !== null) process.stdout.write(`Next cursor: ${page.nextCursor}\n`);
};

export const writeExecutionTraceEvent = (
  command: string,
  event: ExecutionTraceEvent,
  json: boolean,
) => {
  if (json) {
    process.stdout.write(
      `${JSON.stringify({ schemaVersion: 1, command, result: { event }, warnings: [] })}\n`,
    );
    return;
  }
  process.stdout.write(`${renderExecutionTraceEvent(event)}\n`);
};

const renderExecutionTraceEvent = (event: ExecutionTraceEvent) =>
  `${event.sequence}\t${event.kind}@${event.kindVersion}\t${new Date(event.recordedAtMs).toISOString()}\t${event.compatibility}`;

export const workflowScheduleFailure = (
  error: WorkflowScheduleOperationError,
  requestKey?: RequestKey,
): CliFailure => ({ ...error, requestKey, exitCode: 4 });

export const workflowScheduleOccurrenceFailure = (
  error: WorkflowScheduleOccurrenceOperationError,
): CliFailure => ({ ...error, exitCode: 4 });

export const projectCursorFailure = (error: ProjectListCursorError): CliFailure => ({
  ...error,
  exitCode: 2,
});

export const writeFailure = (failure: CliFailure, json: boolean, command: string) => {
  process.stderr.write(`${failure.message}\nNext: ${failure.next}\n`);
  if (failure.requestKey !== undefined && !json) {
    process.stdout.write(`Request Key: ${failure.requestKey}\n`);
  }
  if (json) {
    process.stdout.write(
      `${JSON.stringify({
        schemaVersion: 1,
        command,
        ...(failure.requestKey === undefined ? {} : { requestKey: failure.requestKey }),
        error: {
          code: failure.code,
          message: failure.message,
          next: failure.next,
          ...(failure.affectedResource === undefined
            ? {}
            : { affectedResource: failure.affectedResource }),
          ...(failure.findingKeys === undefined ? {} : { findingKeys: failure.findingKeys }),
          ...(failure.currentSchedule === undefined
            ? {}
            : { currentSchedule: failure.currentSchedule }),
        },
        warnings: [],
      })}\n`,
    );
  }
  return failure.exitCode;
};

export const writeProject = (
  command: string,
  project: ProjectSnapshot,
  json: boolean,
  mutation?: Extract<ProjectMutationResult, { ok: true }>,
  warnings: ReadonlyArray<CliWarning> = [],
  pendingRequestKey?: RequestKey,
) => {
  const requestKey = mutation?.requestKey ?? pendingRequestKey;
  if (json) {
    process.stdout.write(
      `${JSON.stringify({
        schemaVersion: 1,
        command,
        projectIdentity: project.identity,
        ...(requestKey === undefined ? {} : { requestKey }),
        result: {
          project,
          ...(mutation === undefined ? {} : { alreadyApplied: mutation.alreadyApplied }),
        },
        warnings,
      })}\n`,
    );
  } else {
    process.stdout.write(`Project Identity: ${project.identity}\nPath: ${project.path}\n`);
    if (requestKey !== undefined) process.stdout.write(`Request Key: ${requestKey}\n`);
    for (const warning of warnings) {
      process.stderr.write(`Warning: ${warning.message}\nNext: ${warning.next}\n`);
    }
  }
};

export const writeWorkflowRun = (
  command: string,
  run: WorkflowRunSnapshot,
  json: boolean,
  requestKey?: RequestKey,
  alreadyApplied?: boolean,
  warnings: ReadonlyArray<CliWarning> = [],
) => {
  if (json) {
    process.stdout.write(
      `${JSON.stringify({
        schemaVersion: 1,
        command,
        ...(requestKey === undefined ? {} : { requestKey }),
        result: { run, ...(alreadyApplied === undefined ? {} : { alreadyApplied }) },
        warnings,
      })}\n`,
    );
    return;
  }
  process.stdout.write(
    `Run Identity: ${run.runId}\nWorkflow: ${run.workflowKey}@${run.workflowRevision}\nState: ${run.state}\n`,
  );
  if (run.parentRunId != null) {
    process.stdout.write(
      `Parent Run Identity: ${run.parentRunId}\nChild Invocation Key: ${run.childInvocationKey ?? "-"}\n`,
    );
  }
  process.stdout.write(
    `Activity evidence: ${run.activitySummary.invocationAttempts} attempts, ${run.activitySummary.incompleteAttempts} incomplete, ${run.activitySummary.retries} retries, ${run.activitySummary.durableCompletions} durable completions, ${run.activitySummary.replayReuses} replay reuses\n`,
  );
  if (run.sandboxTrace.length > 0) {
    process.stdout.write(`Sandbox evidence: ${run.sandboxTrace.length} trace entries\n`);
  }
  if (run.agentTrace.length > 0) {
    const attempts = run.agentTrace.filter((entry) => entry.kind === "agent.started").length;
    const replayed = run.agentTrace.filter((entry) => entry.kind === "agent.replayed").length;
    const continued = run.agentTrace.filter(
      (entry) => entry.kind === "agent.session-continued",
    ).length;
    process.stdout.write(
      `Agent evidence: ${attempts} attempts, ${replayed} Activity replays, ${continued} provider-session continuations\n`,
    );
  }
  if (run.allowedActions.includes("resume")) {
    process.stdout.write(
      "Workflow Run resume is available; it is separate from Agent Session continuation.\n",
    );
  }
  if (requestKey !== undefined) process.stdout.write(`Request Key: ${requestKey}\n`);
  if (alreadyApplied === true) process.stdout.write("Reused an existing Workflow Run.\n");
  for (const warning of warnings) {
    process.stderr.write(`Warning: ${warning.message}\nNext: ${warning.next}\n`);
  }
};

const renderScheduleTime = (value: number | null) =>
  value === null ? "None" : new Date(value).toISOString();

export const writeWorkflowSchedule = (
  command: string,
  schedule: WorkflowScheduleSnapshot,
  json: boolean,
  requestKey?: RequestKey,
  alreadyApplied?: boolean,
  acceptedRunsContinue = false,
) => {
  if (json) {
    process.stdout.write(
      `${JSON.stringify({
        schemaVersion: 1,
        command,
        ...(requestKey === undefined ? {} : { requestKey }),
        result: {
          schedule,
          ...(alreadyApplied === undefined ? {} : { alreadyApplied }),
          ...(acceptedRunsContinue ? { acceptedRunsContinue: true } : {}),
        },
        warnings: [],
      })}\n`,
    );
    return;
  }
  const definition = schedule.definition;
  process.stdout.write(
    `Schedule Key: ${schedule.scheduleKey}\n` +
      `Workflow: ${definition === null ? "Unavailable" : definition.workflowKey}\n` +
      `Revision: ${definition?.revision ?? schedule.appliedRevision ?? "None"}\n` +
      `Enabled: ${schedule.enabledIntent ? "yes" : "no"}\n` +
      `Condition: ${schedule.condition}\n` +
      `Cron: ${definition?.cron ?? "Unavailable"}\n` +
      `Time zone: ${definition?.timeZone ?? "Unavailable"}\n` +
      `Overlap: ${definition?.overlapPolicy ?? "Unavailable"}\n` +
      `Next occurrence: ${renderScheduleTime(schedule.nextOccurrenceMs)}\n`,
  );
  if (requestKey !== undefined) process.stdout.write(`Request Key: ${requestKey}\n`);
  if (alreadyApplied === true)
    process.stdout.write("Reused the accepted Schedule control request.\n");
  if (acceptedRunsContinue) {
    process.stdout.write(
      "Accepted Workflow Runs continue; disabling affects future occurrences only.\n",
    );
  }
};

export const writeWorkflowScheduleOccurrence = (
  command: string,
  occurrence: WorkflowScheduleOccurrenceSnapshot,
  json: boolean,
) => {
  if (json) {
    process.stdout.write(
      `${JSON.stringify({ schemaVersion: 1, command, result: { occurrence }, warnings: [] })}\n`,
    );
    return;
  }
  const missedRange =
    occurrence.missedRange === null
      ? ""
      : `Missed range: ${occurrence.missedRange.count} instants from ${new Date(occurrence.missedRange.firstScheduledAtMs).toISOString()} through ${new Date(occurrence.missedRange.lastScheduledAtMs).toISOString()}\n`;
  process.stdout.write(
    `Schedule Key: ${occurrence.scheduleKey}\n` +
      `Scheduled UTC: ${new Date(occurrence.scheduledAtMs).toISOString()}\n` +
      `Applied revision: ${occurrence.appliedRevision}\n` +
      `Outcome: ${occurrence.outcome}\n` +
      `Reason: ${occurrence.reasonCode ?? "None"}\n` +
      missedRange +
      `Linked Run: ${occurrence.linkedRunId ?? "None"}\n`,
  );
};

export const pendingRegistrationWarning = (project: ProjectSnapshot): CliWarning => ({
  code: "project-registration-pending",
  message: "The Kojo Project is initialized, but the Host was not available for registration.",
  next: `Run: kojo project register ${project.path}`,
});
