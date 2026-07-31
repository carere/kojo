import { ProjectIdentity } from "@kojo/workflow";
import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import {
  ProjectDefinitionSnapshot,
  WorkflowDefinitionSnapshot,
} from "./project-definition-validation";

export { ProjectIdentity } from "@kojo/workflow";

export const PROTOCOL_VERSION = { major: 1, minor: 5 } as const;
export const CONTROL_CAPABILITIES = [
  "projects:list",
  "projects:list-page",
  "projects:show",
  "projects:register",
  "projects:forget",
  "workflows:list",
  "workflows:show",
  "schedules:list",
  "schedules:show",
  "schedules:next",
  "schedules:enable",
  "schedules:disable",
  "occurrences:list",
  "occurrences:show",
  "runs:start",
  "runs:list",
  "runs:show",
  "runs:reveal",
  "runs:resume",
  "runs:deferred-complete",
] as const;

export const ControlCapability = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
);
export type ControlCapability = typeof ControlCapability.Type;

export const ProtocolVersion = Schema.Struct({
  major: Schema.Number,
  minor: Schema.Number,
});

export const RequestKey = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)).pipe(
  Schema.brand("RequestKey"),
);
export type RequestKey = typeof RequestKey.Type;

export const HostInformation = Schema.Struct({
  protocol: ProtocolVersion,
  hostVersion: Schema.String,
  capabilities: Schema.Array(ControlCapability),
});
export type HostInformation = typeof HostInformation.Type;

export const ProjectSnapshot = Schema.Struct({
  identity: ProjectIdentity,
  path: Schema.String,
});
export type ProjectSnapshot = typeof ProjectSnapshot.Type;

export const ProjectCondition = Schema.Literals(["ready", "limited", "needs-attention"]);
export type ProjectCondition = typeof ProjectCondition.Type;

export const ProjectListItem = Schema.Struct({
  ...ProjectSnapshot.fields,
  condition: ProjectCondition,
});
export type ProjectListItem = typeof ProjectListItem.Type;

export const ProjectSelector = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("identity"), identity: ProjectIdentity }),
  Schema.Struct({ kind: Schema.Literal("path"), path: Schema.String }),
]);
export type ProjectSelector = typeof ProjectSelector.Type;

export const ProjectList = Schema.Struct({
  projects: Schema.Array(ProjectSnapshot),
});
export type ProjectList = typeof ProjectList.Type;

export const ProjectListPage = Schema.Struct({
  items: Schema.Array(ProjectListItem),
  nextCursor: Schema.NullOr(Schema.String),
});
export type ProjectListPage = typeof ProjectListPage.Type;

export const ProjectListInput = Schema.Struct({
  conditions: Schema.Array(ProjectCondition),
  limit: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 200 })),
  cursor: Schema.optionalKey(Schema.String),
});
export type ProjectListInput = typeof ProjectListInput.Type;

export const ProjectListCursorErrorCode = Schema.Literals([
  "project-cursor-malformed",
  "project-cursor-version-unsupported",
  "project-cursor-filter-mismatch",
]);
export type ProjectListCursorErrorCode = typeof ProjectListCursorErrorCode.Type;

export const ProjectListCursorError = Schema.Struct({
  code: ProjectListCursorErrorCode,
  message: Schema.String,
  next: Schema.String,
});
export type ProjectListCursorError = typeof ProjectListCursorError.Type;

export const ProjectListResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), page: ProjectListPage }),
  Schema.Struct({ ok: Schema.Literal(false), error: ProjectListCursorError }),
]);
export type ProjectListResult = typeof ProjectListResult.Type;

export const ReadinessFindingKey = Schema.Literals([
  "layout.ignore-rule-missing",
  "workflow.revision-unavailable",
  "workflow.revision-conflict",
  "schedule.definition-unavailable",
  "run.engine-state-missing",
  "sandbox.state-missing",
  "dependency.workflow-package-missing",
  "dependency.workflow-package-incompatible",
  "configuration.missing",
  "configuration.load-failed",
  "configuration.invalid",
  "workflow.key-duplicate",
  "workflow.schema-invalid",
  "workflow.child-definition-missing",
  "schedule.key-duplicate",
  "schedule.definition-invalid",
  "layout.path-conflict",
  "layout.symbolic-link",
  "layout.owner-invalid",
  "layout.permissions-invalid",
  "layout.version-unsupported",
  "layout.metadata-invalid",
  "project.identity-missing",
  "project.identity-duplicate",
  "store.missing",
  "store.open-failed",
  "store.integrity-failed",
  "store.version-unsupported",
  "store.migration-failed",
  "engine.ownership-unavailable",
  "engine.global-state-invalid",
  "engine.execution-unowned",
]);
export type ReadinessFindingKey = typeof ReadinessFindingKey.Type;

export const ProjectOperationErrorCode = Schema.Literals([
  "project-not-found",
  "project-identity-duplicate",
  "project-layout-invalid",
  "project-forget-blocked",
  "request-key-conflict",
]);
export type ProjectOperationErrorCode = typeof ProjectOperationErrorCode.Type;

export const ProjectOperationError = Schema.Struct({
  code: ProjectOperationErrorCode,
  message: Schema.String,
  next: Schema.String,
  affectedResource: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("project"), identity: ProjectIdentity }),
    Schema.Struct({ kind: Schema.Literal("project-path"), path: Schema.String }),
    Schema.Struct({ kind: Schema.Literal("project-index") }),
    Schema.Struct({ kind: Schema.Literal("request-key"), requestKey: RequestKey }),
  ]),
  findingKeys: Schema.Array(ReadinessFindingKey),
});
export type ProjectOperationError = typeof ProjectOperationError.Type;

export const ProjectQueryResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), project: ProjectSnapshot }),
  Schema.Struct({ ok: Schema.Literal(false), error: ProjectOperationError }),
]);
export type ProjectQueryResult = typeof ProjectQueryResult.Type;

export const ProjectWorkflowSnapshot = Schema.Struct({
  project: ProjectSnapshot,
  definitions: ProjectDefinitionSnapshot,
});
export type ProjectWorkflowSnapshot = typeof ProjectWorkflowSnapshot.Type;

export const ProjectWorkflowQueryResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), snapshot: ProjectWorkflowSnapshot }),
  Schema.Struct({ ok: Schema.Literal(false), error: ProjectOperationError }),
]);
export type ProjectWorkflowQueryResult = typeof ProjectWorkflowQueryResult.Type;

export const WorkflowDefinitionQueryResult = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    project: ProjectSnapshot,
    snapshotId: Schema.String,
    workflow: WorkflowDefinitionSnapshot,
  }),
  Schema.Struct({ ok: Schema.Literal(false), error: ProjectOperationError }),
]);
export type WorkflowDefinitionQueryResult = typeof WorkflowDefinitionQueryResult.Type;

export const WorkflowScheduleCondition = Schema.Literals([
  "available",
  "unavailable",
  "needs-attention",
]);
export type WorkflowScheduleCondition = typeof WorkflowScheduleCondition.Type;

export const WorkflowScheduleDefinition = Schema.Struct({
  scheduleKey: Schema.String,
  workflowKey: Schema.String,
  revision: Schema.String,
  cron: Schema.String,
  timeZone: Schema.String,
  overlapPolicy: Schema.Literals(["allow", "skip"]),
  inputRuleRevision: Schema.String,
});
export type WorkflowScheduleDefinition = typeof WorkflowScheduleDefinition.Type;

export const WorkflowScheduleAllowedAction = Schema.Literals(["enable", "disable"]);
export type WorkflowScheduleAllowedAction = typeof WorkflowScheduleAllowedAction.Type;

export const WorkflowScheduleSnapshot = Schema.Struct({
  scheduleKey: Schema.String,
  definition: Schema.NullOr(WorkflowScheduleDefinition),
  appliedRevision: Schema.NullOr(Schema.String),
  enabledIntent: Schema.Boolean,
  condition: WorkflowScheduleCondition,
  conditionReasonCode: Schema.NullOr(Schema.String),
  highWaterMarkMs: Schema.NullOr(Schema.Number),
  nextOccurrenceMs: Schema.NullOr(Schema.Number),
  rowVersion: Schema.Number,
  allowedActions: Schema.Array(WorkflowScheduleAllowedAction),
});
export type WorkflowScheduleSnapshot = typeof WorkflowScheduleSnapshot.Type;

export const WorkflowScheduleOperationErrorCode = Schema.Literals([
  "project-not-found",
  "project-layout-invalid",
  "project-runtime-not-ready",
  "schedule-not-found",
  "schedule-revision-conflict",
  "request-key-conflict",
]);
export type WorkflowScheduleOperationErrorCode = typeof WorkflowScheduleOperationErrorCode.Type;

export const WorkflowScheduleOperationError = Schema.Struct({
  code: WorkflowScheduleOperationErrorCode,
  message: Schema.String,
  next: Schema.String,
  affectedResource: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("project"), identity: ProjectIdentity }),
    Schema.Struct({
      kind: Schema.Literal("schedule"),
      identity: ProjectIdentity,
      scheduleKey: Schema.String,
    }),
    Schema.Struct({ kind: Schema.Literal("request-key"), requestKey: RequestKey }),
  ]),
  findingKeys: Schema.Array(ReadinessFindingKey),
  currentSchedule: Schema.optionalKey(WorkflowScheduleSnapshot),
});
export type WorkflowScheduleOperationError = typeof WorkflowScheduleOperationError.Type;

export const WorkflowScheduleListInput = Schema.Struct({
  identity: ProjectIdentity,
  workflowKeys: Schema.Array(Schema.String),
  conditions: Schema.Array(WorkflowScheduleCondition),
});
export type WorkflowScheduleListInput = typeof WorkflowScheduleListInput.Type;

export const WorkflowScheduleListResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), schedules: Schema.Array(WorkflowScheduleSnapshot) }),
  Schema.Struct({ ok: Schema.Literal(false), error: WorkflowScheduleOperationError }),
]);
export type WorkflowScheduleListResult = typeof WorkflowScheduleListResult.Type;

export const WorkflowScheduleQueryResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), schedule: WorkflowScheduleSnapshot }),
  Schema.Struct({ ok: Schema.Literal(false), error: WorkflowScheduleOperationError }),
]);
export type WorkflowScheduleQueryResult = typeof WorkflowScheduleQueryResult.Type;

export const WorkflowScheduleMutationResult = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    schedule: WorkflowScheduleSnapshot,
    alreadyApplied: Schema.Boolean,
    /** Disable never stops a Run whose start was already accepted. */
    acceptedRunsContinue: Schema.Boolean,
    requestKey: RequestKey,
  }),
  Schema.Struct({
    ok: Schema.Literal(false),
    requestKey: RequestKey,
    error: WorkflowScheduleOperationError,
  }),
]);
export type WorkflowScheduleMutationResult = typeof WorkflowScheduleMutationResult.Type;

export const WorkflowScheduleOccurrenceOutcome = Schema.Literals([
  "planned",
  "started",
  "skipped",
  "invalidated",
  "failed",
]);
export type WorkflowScheduleOccurrenceOutcome = typeof WorkflowScheduleOccurrenceOutcome.Type;

/**
 * The durable, inspectable lifecycle of one Schedule Key + scheduled UTC
 * instant. It remains separate from the Workflow Run it may start.
 */
export const WorkflowScheduleOccurrenceSnapshot = Schema.Struct({
  scheduleKey: Schema.String,
  scheduledAtMs: Schema.Number,
  appliedRevision: Schema.String,
  input: Schema.Unknown,
  inputSensitivityPaths: Schema.Array(Schema.String),
  outcome: WorkflowScheduleOccurrenceOutcome,
  reasonCode: Schema.NullOr(Schema.String),
  deliveryAttemptCount: Schema.Number,
  plannedAtMs: Schema.Number,
  firstAttemptedAtMs: Schema.NullOr(Schema.Number),
  processedAtMs: Schema.NullOr(Schema.Number),
  linkedRunId: Schema.NullOr(Schema.String),
  /**
   * A compact record for consecutive older instants skipped during Host
   * downtime. It is present only on a `skipped` occurrence with the
   * `schedule.missed-range` reason.
   */
  missedRange: Schema.NullOr(
    Schema.Struct({
      count: Schema.Int,
      firstScheduledAtMs: Schema.Number,
      lastScheduledAtMs: Schema.Number,
    }),
  ),
});
export type WorkflowScheduleOccurrenceSnapshot = typeof WorkflowScheduleOccurrenceSnapshot.Type;

export const WorkflowScheduleOccurrenceOperationErrorCode = Schema.Literals([
  "project-not-found",
  "project-layout-invalid",
  "project-runtime-not-ready",
  "schedule-not-found",
  "occurrence-not-found",
]);
export type WorkflowScheduleOccurrenceOperationErrorCode =
  typeof WorkflowScheduleOccurrenceOperationErrorCode.Type;

export const WorkflowScheduleOccurrenceOperationError = Schema.Struct({
  code: WorkflowScheduleOccurrenceOperationErrorCode,
  message: Schema.String,
  next: Schema.String,
  affectedResource: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("project"), identity: ProjectIdentity }),
    Schema.Struct({
      kind: Schema.Literal("schedule"),
      identity: ProjectIdentity,
      scheduleKey: Schema.String,
    }),
    Schema.Struct({
      kind: Schema.Literal("occurrence"),
      identity: ProjectIdentity,
      scheduleKey: Schema.String,
      scheduledAtMs: Schema.Number,
    }),
  ]),
  findingKeys: Schema.Array(ReadinessFindingKey),
});
export type WorkflowScheduleOccurrenceOperationError =
  typeof WorkflowScheduleOccurrenceOperationError.Type;

export const WorkflowScheduleOccurrenceListInput = Schema.Struct({
  identity: ProjectIdentity,
  scheduleKeys: Schema.Array(Schema.String),
  outcomes: Schema.Array(WorkflowScheduleOccurrenceOutcome),
  limit: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 200 })),
});
export type WorkflowScheduleOccurrenceListInput = typeof WorkflowScheduleOccurrenceListInput.Type;

export const WorkflowScheduleOccurrenceListResult = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    occurrences: Schema.Array(WorkflowScheduleOccurrenceSnapshot),
  }),
  Schema.Struct({ ok: Schema.Literal(false), error: WorkflowScheduleOccurrenceOperationError }),
]);
export type WorkflowScheduleOccurrenceListResult = typeof WorkflowScheduleOccurrenceListResult.Type;

export const WorkflowScheduleOccurrenceQueryResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), occurrence: WorkflowScheduleOccurrenceSnapshot }),
  Schema.Struct({ ok: Schema.Literal(false), error: WorkflowScheduleOccurrenceOperationError }),
]);
export type WorkflowScheduleOccurrenceQueryResult =
  typeof WorkflowScheduleOccurrenceQueryResult.Type;

export const WorkflowRunId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(200),
).pipe(Schema.brand("WorkflowRunId"));
export type WorkflowRunId = typeof WorkflowRunId.Type;

export const WorkflowRunState = Schema.Literals([
  "running",
  "suspended",
  "stopping",
  "stopped",
  "failed",
  "completed",
]);
export type WorkflowRunState = typeof WorkflowRunState.Type;

export const WorkflowRunSuspension = Schema.Struct({
  kind: Schema.Literals(["clock", "manual", "deferred"]),
  operationKey: Schema.String,
  completionToken: Schema.optionalKey(Schema.String),
});
export type WorkflowRunSuspension = typeof WorkflowRunSuspension.Type;

export const WorkflowRunAction = Schema.Literals(["resume", "deferred-complete"]);
export type WorkflowRunAction = typeof WorkflowRunAction.Type;

export const WorkflowRunStartSnapshot = Schema.Struct({
  workflow: Schema.Struct({
    workflowKey: Schema.String,
    workflowRevision: Schema.String,
    sourceIdentity: Schema.String,
    inputSchemaFingerprint: Schema.String,
  }),
  trigger: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("manual"), requestKey: RequestKey }),
    Schema.Struct({
      kind: Schema.Literal("schedule"),
      requestKey: RequestKey,
      scheduleKey: Schema.String,
      occurrence: Schema.Struct({ scheduleKey: Schema.String, scheduledAtMs: Schema.Number }),
      scheduledAtMs: Schema.Number,
      scheduleRevision: Schema.String,
    }),
  ]),
  environment: Schema.Struct({
    projectIdentity: ProjectIdentity,
    definitionSnapshotId: Schema.String,
    runtimeKind: Schema.Literal("local-effect-workflow"),
  }),
  input: Schema.Unknown,
  inputSensitivityPaths: Schema.Array(Schema.String),
});
export type WorkflowRunStartSnapshot = typeof WorkflowRunStartSnapshot.Type;

/**
 * A value that was deliberately withheld from ordinary inspection. It contains
 * neither a preview nor metadata about the exact value.
 */
export const MaskedWorkflowValue = Schema.Struct({
  _tag: Schema.Literal("sensitive-value-masked"),
});
export type MaskedWorkflowValue = typeof MaskedWorkflowValue.Type;

export const WorkflowRunListItem = Schema.Struct({
  runId: WorkflowRunId,
  workflowKey: Schema.String,
  workflowRevision: Schema.String,
  state: WorkflowRunState,
  acceptedAtMs: Schema.Number,
  engineConfirmedAtMs: Schema.NullOr(Schema.Number),
  updatedAtMs: Schema.Number,
  finalizedAtMs: Schema.NullOr(Schema.Number),
  allowedActions: Schema.Array(WorkflowRunAction),
});
export type WorkflowRunListItem = typeof WorkflowRunListItem.Type;

export const WorkflowRunSnapshot = Schema.Struct({
  ...WorkflowRunListItem.fields,
  startRequestKey: RequestKey,
  startSnapshot: Schema.Union([WorkflowRunStartSnapshot, MaskedWorkflowValue]),
  suspension: Schema.NullOr(WorkflowRunSuspension),
  outcome: Schema.Union([
    Schema.Null,
    Schema.Struct({
      kind: Schema.Literals(["completed", "failed"]),
      value: Schema.optionalKey(Schema.Unknown),
    }),
    MaskedWorkflowValue,
  ]),
});
export type WorkflowRunSnapshot = typeof WorkflowRunSnapshot.Type;

export const WorkflowRunOperationErrorCode = Schema.Literals([
  "project-not-found",
  "project-layout-invalid",
  "project-runtime-not-ready",
  "workflow-not-found",
  "workflow-revision-conflict",
  "workflow-input-invalid",
  "request-key-conflict",
  "run-not-found",
  "run-not-suspended",
  "run-resume-not-allowed",
  "workflow-deferred-not-found",
  "workflow-deferred-value-invalid",
]);
export type WorkflowRunOperationErrorCode = typeof WorkflowRunOperationErrorCode.Type;

export const WorkflowRunOperationError = Schema.Struct({
  code: WorkflowRunOperationErrorCode,
  message: Schema.String,
  next: Schema.String,
  affectedResource: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("project"), identity: ProjectIdentity }),
    Schema.Struct({
      kind: Schema.Literal("workflow"),
      identity: ProjectIdentity,
      workflowKey: Schema.String,
    }),
    Schema.Struct({ kind: Schema.Literal("run"), identity: ProjectIdentity, runId: WorkflowRunId }),
    Schema.Struct({ kind: Schema.Literal("request-key"), requestKey: RequestKey }),
  ]),
  findingKeys: Schema.Array(ReadinessFindingKey),
  currentWorkflow: Schema.optionalKey(WorkflowDefinitionSnapshot),
});
export type WorkflowRunOperationError = typeof WorkflowRunOperationError.Type;

export const WorkflowRunStartResult = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    run: WorkflowRunSnapshot,
    alreadyApplied: Schema.Boolean,
    requestKey: RequestKey,
  }),
  Schema.Struct({
    ok: Schema.Literal(false),
    requestKey: RequestKey,
    error: WorkflowRunOperationError,
  }),
]);
export type WorkflowRunStartResult = typeof WorkflowRunStartResult.Type;

export const WorkflowRunMutationResult = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    run: WorkflowRunSnapshot,
    alreadyApplied: Schema.Boolean,
    requestKey: RequestKey,
  }),
  Schema.Struct({
    ok: Schema.Literal(false),
    requestKey: RequestKey,
    error: WorkflowRunOperationError,
  }),
]);
export type WorkflowRunMutationResult = typeof WorkflowRunMutationResult.Type;

export const WorkflowRunListInput = Schema.Struct({
  identity: ProjectIdentity,
  workflowKeys: Schema.Array(Schema.String),
  states: Schema.Array(WorkflowRunState),
  limit: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 200 })),
});
export type WorkflowRunListInput = typeof WorkflowRunListInput.Type;

export const WorkflowRunListResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), runs: Schema.Array(WorkflowRunListItem) }),
  Schema.Struct({ ok: Schema.Literal(false), error: WorkflowRunOperationError }),
]);
export type WorkflowRunListResult = typeof WorkflowRunListResult.Type;

export const WorkflowRunQueryResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), run: WorkflowRunSnapshot }),
  Schema.Struct({ ok: Schema.Literal(false), error: WorkflowRunOperationError }),
]);
export type WorkflowRunQueryResult = typeof WorkflowRunQueryResult.Type;

export const ProjectWorkflowRunsSnapshot = Schema.Struct({
  project: ProjectSnapshot,
  runs: Schema.Array(WorkflowRunListItem),
});
export type ProjectWorkflowRunsSnapshot = typeof ProjectWorkflowRunsSnapshot.Type;

export const ProjectWorkflowSchedulesSnapshot = Schema.Struct({
  project: ProjectSnapshot,
  schedules: Schema.Array(WorkflowScheduleSnapshot),
});
export type ProjectWorkflowSchedulesSnapshot = typeof ProjectWorkflowSchedulesSnapshot.Type;

export const ProjectWorkflowScheduleOccurrencesSnapshot = Schema.Struct({
  project: ProjectSnapshot,
  occurrences: Schema.Array(WorkflowScheduleOccurrenceSnapshot),
});
export type ProjectWorkflowScheduleOccurrencesSnapshot =
  typeof ProjectWorkflowScheduleOccurrencesSnapshot.Type;

export const ProjectMutationResult = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    project: ProjectSnapshot,
    alreadyApplied: Schema.Boolean,
    requestKey: RequestKey,
  }),
  Schema.Struct({
    ok: Schema.Literal(false),
    requestKey: RequestKey,
    error: ProjectOperationError,
  }),
]);
export type ProjectMutationResult = typeof ProjectMutationResult.Type;

export const HostOverview = Schema.Struct({
  host: HostInformation,
  projects: Schema.Array(ProjectSnapshot),
  projectDefinitions: Schema.Array(ProjectWorkflowSnapshot),
  workflowSchedules: Schema.Array(ProjectWorkflowSchedulesSnapshot),
  workflowOccurrences: Schema.Array(ProjectWorkflowScheduleOccurrencesSnapshot),
  workflowRuns: Schema.Array(ProjectWorkflowRunsSnapshot),
});
export type HostOverview = typeof HostOverview.Type;

export const Negotiate = Rpc.make("Negotiate", {
  success: HostInformation,
});

export const NegotiateCapabilities = Rpc.make("NegotiateCapabilities", {
  success: HostInformation,
});

export const ListProjects = Rpc.make("ListProjects", {
  success: ProjectList,
});

export const ListProjectPage = Rpc.make("ListProjectPage", {
  payload: ProjectListInput.fields,
  success: ProjectListResult,
});

export const ShowProject = Rpc.make("ShowProject", {
  payload: { identity: ProjectIdentity },
  success: ProjectQueryResult,
});

export const ListWorkflowDefinitions = Rpc.make("ListWorkflowDefinitions", {
  payload: { identity: ProjectIdentity },
  success: ProjectWorkflowQueryResult,
});

export const ShowWorkflowDefinition = Rpc.make("ShowWorkflowDefinition", {
  payload: { identity: ProjectIdentity, workflowKey: Schema.String },
  success: WorkflowDefinitionQueryResult,
});

export const ListWorkflowSchedules = Rpc.make("ListWorkflowSchedules", {
  payload: WorkflowScheduleListInput.fields,
  success: WorkflowScheduleListResult,
});

export const ShowWorkflowSchedule = Rpc.make("ShowWorkflowSchedule", {
  payload: { identity: ProjectIdentity, scheduleKey: Schema.String },
  success: WorkflowScheduleQueryResult,
});

export const ListNextWorkflowSchedules = Rpc.make("ListNextWorkflowSchedules", {
  payload: WorkflowScheduleListInput.fields,
  success: WorkflowScheduleListResult,
});

export const EnableWorkflowSchedule = Rpc.make("EnableWorkflowSchedule", {
  payload: {
    identity: ProjectIdentity,
    scheduleKey: Schema.String,
    scheduleRevision: Schema.String,
    requestKey: RequestKey,
  },
  success: WorkflowScheduleMutationResult,
});

export const DisableWorkflowSchedule = Rpc.make("DisableWorkflowSchedule", {
  payload: { identity: ProjectIdentity, scheduleKey: Schema.String, requestKey: RequestKey },
  success: WorkflowScheduleMutationResult,
});

export const ListWorkflowScheduleOccurrences = Rpc.make("ListWorkflowScheduleOccurrences", {
  payload: WorkflowScheduleOccurrenceListInput.fields,
  success: WorkflowScheduleOccurrenceListResult,
});

export const ShowWorkflowScheduleOccurrence = Rpc.make("ShowWorkflowScheduleOccurrence", {
  payload: { identity: ProjectIdentity, scheduleKey: Schema.String, scheduledAtMs: Schema.Number },
  success: WorkflowScheduleOccurrenceQueryResult,
});

export const StartWorkflowRun = Rpc.make("StartWorkflowRun", {
  payload: {
    identity: ProjectIdentity,
    workflowKey: Schema.String,
    workflowRevision: Schema.String,
    input: Schema.Unknown,
    requestKey: RequestKey,
  },
  success: WorkflowRunStartResult,
});

export const ListWorkflowRuns = Rpc.make("ListWorkflowRuns", {
  payload: WorkflowRunListInput.fields,
  success: WorkflowRunListResult,
});

export const ShowWorkflowRun = Rpc.make("ShowWorkflowRun", {
  payload: { identity: ProjectIdentity, runId: WorkflowRunId },
  success: WorkflowRunQueryResult,
});

/**
 * Reveals one Run inspection response only. This request never changes Project
 * policy or the durable Run record.
 */
export const RevealWorkflowRun = Rpc.make("RevealWorkflowRun", {
  payload: { identity: ProjectIdentity, runId: WorkflowRunId },
  success: WorkflowRunQueryResult,
});

export const ResumeWorkflowRun = Rpc.make("ResumeWorkflowRun", {
  payload: {
    identity: ProjectIdentity,
    runId: WorkflowRunId,
    value: Schema.optionalKey(Schema.Unknown),
    requestKey: RequestKey,
  },
  success: WorkflowRunMutationResult,
});

export const CompleteWorkflowDeferred = Rpc.make("CompleteWorkflowDeferred", {
  payload: {
    identity: ProjectIdentity,
    runId: WorkflowRunId,
    token: Schema.String,
    value: Schema.optionalKey(Schema.Unknown),
    requestKey: RequestKey,
  },
  success: WorkflowRunMutationResult,
});

export const RegisterProject = Rpc.make("RegisterProject", {
  payload: { path: Schema.String, requestKey: RequestKey },
  success: ProjectMutationResult,
});

export const ForgetProject = Rpc.make("ForgetProject", {
  payload: { identity: ProjectIdentity, selector: ProjectSelector, requestKey: RequestKey },
  success: ProjectMutationResult,
});

export const ReplayForgetProject = Rpc.make("ReplayForgetProject", {
  payload: { selector: ProjectSelector, requestKey: RequestKey },
  success: ProjectMutationResult,
});

export const KojoControl = RpcGroup.make(
  Negotiate,
  NegotiateCapabilities,
  ListProjects,
  ListProjectPage,
  ShowProject,
  ListWorkflowDefinitions,
  ShowWorkflowDefinition,
  ListWorkflowSchedules,
  ShowWorkflowSchedule,
  ListNextWorkflowSchedules,
  EnableWorkflowSchedule,
  DisableWorkflowSchedule,
  ListWorkflowScheduleOccurrences,
  ShowWorkflowScheduleOccurrence,
  StartWorkflowRun,
  ListWorkflowRuns,
  ShowWorkflowRun,
  RevealWorkflowRun,
  ResumeWorkflowRun,
  CompleteWorkflowDeferred,
  RegisterProject,
  ForgetProject,
  ReplayForgetProject,
);
