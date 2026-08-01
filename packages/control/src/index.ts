import { ProjectIdentity } from "@kojo/workflow";
import { Effect, Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";
import {
  ProjectDefinitionSnapshot,
  WorkflowDefinitionSnapshot,
} from "./project-definition-validation";

export { ProjectIdentity } from "@kojo/workflow";

export const PROTOCOL_VERSION = { major: 1, minor: 13 } as const;
export const CONTROL_CAPABILITIES = [
  "projects:list",
  "projects:list-page",
  "projects:show",
  "projects:register",
  "projects:forget",
  "readiness:show",
  "readiness:refresh",
  "readiness:repair",
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
  "runs:stop",
  "traces:read",
  "traces:export",
  "artifacts:read",
  "retention:show",
  "retention:set",
  "deletion:plan",
  "deletion:confirm",
  "control:subscribe",
  "control:acknowledge",
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

/**
 * Project Runtime Readiness is deliberately separate from Control Capability:
 * a Host can support an operation while a particular Project is not proven
 * safe to perform it.
 */
export const ProjectReadinessCapability = Schema.Literals([
  "project:inspect",
  "history:inspect",
  "runs:control",
  "runs:recover",
  "runs:start",
  "schedules:process",
  "repair:safe",
]);
export type ProjectReadinessCapability = typeof ProjectReadinessCapability.Type;

export const ProjectReadinessResource = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("project"), identity: ProjectIdentity }),
  Schema.Struct({ kind: Schema.Literal("project-path"), path: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("layout"), path: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("configuration"), identity: ProjectIdentity }),
  Schema.Struct({ kind: Schema.Literal("store"), identity: ProjectIdentity }),
  Schema.Struct({ kind: Schema.Literal("engine"), identity: ProjectIdentity }),
  Schema.Struct({
    kind: Schema.Literal("workflow"),
    identity: ProjectIdentity,
    workflowKey: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("schedule"),
    identity: ProjectIdentity,
    scheduleKey: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literal("run"), identity: ProjectIdentity, runId: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("sandbox"),
    identity: ProjectIdentity,
    runId: Schema.String,
    sandboxKey: Schema.String,
  }),
]);
export type ProjectReadinessResource = typeof ProjectReadinessResource.Type;

export const ProjectReadinessRepairClass = Schema.Literals([
  "automatic",
  "explicit",
  "developer-action",
  "unavailable",
]);
export type ProjectReadinessRepairClass = typeof ProjectReadinessRepairClass.Type;

export const ProjectReadinessActionKey = Schema.Literals([
  "layout.add-ignore-rule",
  "project.assign-new-identity",
  "project.replace-missing-data",
  "store.retry-migration",
  "readiness.refresh",
]);
export type ProjectReadinessActionKey = typeof ProjectReadinessActionKey.Type;

export const ProjectReadinessAction = Schema.Struct({
  key: ProjectReadinessActionKey,
  label: Schema.String,
});
export type ProjectReadinessAction = typeof ProjectReadinessAction.Type;

export const ProjectReadinessFinding = Schema.Struct({
  /** Stable identifier for this code and affected resource in one assessment lineage. */
  key: Schema.String,
  code: ReadinessFindingKey,
  affectedResource: ProjectReadinessResource,
  blockedCapabilities: Schema.Array(ProjectReadinessCapability),
  dependents: Schema.Array(ProjectReadinessResource),
  summary: Schema.String,
  relevant: Schema.Array(Schema.String),
  repairClass: ProjectReadinessRepairClass,
  actions: Schema.Array(ProjectReadinessAction),
  firstObservedAtMs: Schema.Number,
  lastObservedAtMs: Schema.Number,
});
export type ProjectReadinessFinding = typeof ProjectReadinessFinding.Type;

export const ProjectReadinessCapabilityResult = Schema.Struct({
  capability: ProjectReadinessCapability,
  available: Schema.Boolean,
  findingKeys: Schema.Array(ReadinessFindingKey),
});
export type ProjectReadinessCapabilityResult = typeof ProjectReadinessCapabilityResult.Type;

export const ProjectReadinessRepairNoticeCode = Schema.Literals([
  "project.path-updated",
  "layout.permissions-tightened",
  "layout.artifacts-recreated",
  "layout.empty-sandboxes-recreated",
  "layout.version-upgraded",
  "store.migrated",
]);
export type ProjectReadinessRepairNoticeCode = typeof ProjectReadinessRepairNoticeCode.Type;

export const ProjectReadinessRepairNotice = Schema.Struct({
  code: ProjectReadinessRepairNoticeCode,
  summary: Schema.String,
  affectedResource: ProjectReadinessResource,
});
export type ProjectReadinessRepairNotice = typeof ProjectReadinessRepairNotice.Type;

export const ProjectReadinessAssessment = Schema.Struct({
  project: ProjectSnapshot,
  revision: Schema.String,
  assessedAtMs: Schema.Number,
  condition: ProjectCondition,
  capabilities: Schema.Array(ProjectReadinessCapabilityResult),
  findings: Schema.Array(ProjectReadinessFinding),
  repairs: Schema.Array(ProjectReadinessRepairNotice),
});
export type ProjectReadinessAssessment = typeof ProjectReadinessAssessment.Type;

export const ProjectReadinessOperationErrorCode = Schema.Literals([
  "project-not-found",
  "stale-assessment",
  "repair-not-available",
  "repair-precondition-failed",
]);
export type ProjectReadinessOperationErrorCode = typeof ProjectReadinessOperationErrorCode.Type;

export const ProjectReadinessOperationError = Schema.Struct({
  code: ProjectReadinessOperationErrorCode,
  message: Schema.String,
  next: Schema.String,
  findingKeys: Schema.Array(ReadinessFindingKey),
  assessment: Schema.optionalKey(ProjectReadinessAssessment),
});
export type ProjectReadinessOperationError = typeof ProjectReadinessOperationError.Type;

export const ProjectReadinessQueryResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), assessment: ProjectReadinessAssessment }),
  Schema.Struct({ ok: Schema.Literal(false), error: ProjectReadinessOperationError }),
]);
export type ProjectReadinessQueryResult = typeof ProjectReadinessQueryResult.Type;

export const ProjectReadinessRepairResult = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    assessment: ProjectReadinessAssessment,
    requestKey: RequestKey,
  }),
  Schema.Struct({
    ok: Schema.Literal(false),
    requestKey: RequestKey,
    error: ProjectReadinessOperationError,
  }),
]);
export type ProjectReadinessRepairResult = typeof ProjectReadinessRepairResult.Type;

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

const RetentionLimit = Schema.NullOr(
  Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
);

export const ProjectRetentionPolicy = Schema.Struct({
  diagnosticMaxAgeMs: RetentionLimit,
  diagnosticMaxBytes: RetentionLimit,
  disposableMaxAgeMs: RetentionLimit,
  disposableMaxBytes: RetentionLimit,
});
export type ProjectRetentionPolicy = typeof ProjectRetentionPolicy.Type;

export const ProjectRetentionUsage = Schema.Struct({
  diagnosticBytes: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  disposableBytes: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  protectedDisposableBytes: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  eligibleDisposableBytes: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  availableArtifactCount: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  missingArtifactCount: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  expiredArtifactCount: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  lastCleanupAtMs: Schema.NullOr(Schema.Number),
});
export type ProjectRetentionUsage = typeof ProjectRetentionUsage.Type;

export const ProjectRetentionWarningCode = Schema.Literals([
  "protected-over-limit",
  "missing-retained-content",
]);
export type ProjectRetentionWarningCode = typeof ProjectRetentionWarningCode.Type;

export const ProjectRetentionWarning = Schema.Struct({
  code: ProjectRetentionWarningCode,
  kind: Schema.Literals(["diagnostics", "disposable"]),
  message: Schema.String,
  next: Schema.String,
  observedAtMs: Schema.Number,
  currentBytes: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  limitBytes: Schema.NullOr(Schema.Number),
});
export type ProjectRetentionWarning = typeof ProjectRetentionWarning.Type;

export const ProjectRetentionSnapshot = Schema.Struct({
  project: ProjectSnapshot,
  policy: ProjectRetentionPolicy,
  usage: ProjectRetentionUsage,
  warnings: Schema.Array(ProjectRetentionWarning),
  hostDiagnosticMaxAgeMs: Schema.Number,
  hostDiagnosticMaxBytes: Schema.Number,
  observedAtMs: Schema.Number,
});
export type ProjectRetentionSnapshot = typeof ProjectRetentionSnapshot.Type;

export const RetentionOperationErrorCode = Schema.Literals([
  "project-not-found",
  "project-layout-invalid",
  "project-runtime-not-ready",
  "retention-invalid",
  "request-key-conflict",
]);
export type RetentionOperationErrorCode = typeof RetentionOperationErrorCode.Type;

export const RetentionOperationError = Schema.Struct({
  code: RetentionOperationErrorCode,
  message: Schema.String,
  next: Schema.String,
  affectedResource: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("project"), identity: ProjectIdentity }),
    Schema.Struct({ kind: Schema.Literal("request-key"), requestKey: RequestKey }),
  ]),
  findingKeys: Schema.Array(Schema.String),
});
export type RetentionOperationError = typeof RetentionOperationError.Type;

export const ProjectRetentionQueryResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), retention: ProjectRetentionSnapshot }),
  Schema.Struct({ ok: Schema.Literal(false), error: RetentionOperationError }),
]);
export type ProjectRetentionQueryResult = typeof ProjectRetentionQueryResult.Type;

const RetentionSetValue = Schema.optionalKey(
  Schema.NullOr(Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1))),
);

export const ProjectRetentionSetInput = Schema.Struct({
  identity: ProjectIdentity,
  requestKey: RequestKey,
  diagnosticMaxAgeMs: RetentionSetValue,
  diagnosticMaxBytes: RetentionSetValue,
  disposableMaxAgeMs: RetentionSetValue,
  disposableMaxBytes: RetentionSetValue,
});
export type ProjectRetentionSetInput = typeof ProjectRetentionSetInput.Type;

export const ProjectRetentionMutationResult = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    retention: ProjectRetentionSnapshot,
    alreadyApplied: Schema.Boolean,
    requestKey: RequestKey,
  }),
  Schema.Struct({
    ok: Schema.Literal(false),
    requestKey: RequestKey,
    error: RetentionOperationError,
  }),
]);
export type ProjectRetentionMutationResult = typeof ProjectRetentionMutationResult.Type;

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

export const WorkflowRunAction = Schema.Literals(["resume", "deferred-complete", "stop"]);
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
      kind: Schema.Literal("child"),
      parentRunId: WorkflowRunId,
      invocationKey: Schema.String,
    }),
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

/** Safe evidence for one real invocation; it never includes an Activity result. */
export const WorkflowActivityAttempt = Schema.Struct({
  attemptId: Schema.String,
  durableOperationKey: Schema.String,
  activityName: Schema.String,
  effectRetryNumber: Schema.Number,
  invocationNumber: Schema.Number,
  activityIdempotencyKey: Schema.String,
  state: Schema.Literals(["started", "result-observed", "engine-confirmed"]),
  outcomeCode: Schema.NullOr(Schema.String),
  startedAtMs: Schema.Number,
  resultObservedAtMs: Schema.NullOr(Schema.Number),
  engineConfirmedAtMs: Schema.NullOr(Schema.Number),
});
export type WorkflowActivityAttempt = typeof WorkflowActivityAttempt.Type;

/** Counts are safe for ordinary CLI and visualizer inspection. */
export const WorkflowActivitySummary = Schema.Struct({
  invocationAttempts: Schema.Number,
  incompleteAttempts: Schema.Number,
  retries: Schema.Number,
  durableCompletions: Schema.Number,
  replayReuses: Schema.Number,
});
export type WorkflowActivitySummary = typeof WorkflowActivitySummary.Type;

export const WorkflowActivityTrace = Schema.Struct({
  attempts: Schema.Array(WorkflowActivityAttempt),
  summary: WorkflowActivitySummary,
});
export type WorkflowActivityTrace = typeof WorkflowActivityTrace.Type;

/** Safe Sandbox and Command evidence. Artifact contents never appear in this trace. */
export const WorkflowSandboxTraceEntry = Schema.Struct({
  artifactIds: Schema.Array(Schema.String),
  durationMs: Schema.NullOr(Schema.Number),
  exitCode: Schema.NullOr(Schema.Number),
  kind: Schema.Literals([
    "sandbox.acquired",
    "sandbox.session-recreated",
    "command.completed",
    "command.failed",
    "command.timed-out",
  ]),
  operationKey: Schema.String,
  providerKind: Schema.String,
  recordedAtMs: Schema.Number,
  sandboxIdentity: Schema.String,
});
export type WorkflowSandboxTraceEntry = typeof WorkflowSandboxTraceEntry.Type;

/**
 * Safe Agent Activity evidence. Session ids, prompts, transcripts, and result
 * text are Sensitive Execution Data and deliberately never appear here.
 */
export const WorkflowAgentTraceEntry = Schema.Struct({
  artifactIds: Schema.Array(Schema.String),
  durationMs: Schema.NullOr(Schema.Number),
  kind: Schema.Literals([
    "agent.started",
    "agent.completed",
    "agent.failed",
    "agent.session-continued",
    "agent.replayed",
  ]),
  operationKey: Schema.String,
  providerKind: Schema.String,
  recordedAtMs: Schema.Number,
  sandboxIdentity: Schema.String,
});
export type WorkflowAgentTraceEntry = typeof WorkflowAgentTraceEntry.Type;

export const WorkflowRunListItem = Schema.Struct({
  runId: WorkflowRunId,
  workflowKey: Schema.String,
  workflowRevision: Schema.String,
  state: WorkflowRunState,
  acceptedAtMs: Schema.Number,
  engineConfirmedAtMs: Schema.NullOr(Schema.Number),
  updatedAtMs: Schema.Number,
  finalizedAtMs: Schema.NullOr(Schema.Number),
  parentRunId: Schema.optionalKey(Schema.NullOr(WorkflowRunId)),
  childInvocationKey: Schema.optionalKey(Schema.NullOr(Schema.String)),
  allowedActions: Schema.Array(WorkflowRunAction),
  activitySummary: WorkflowActivitySummary,
  agentTrace: Schema.Array(WorkflowAgentTraceEntry),
  sandboxTrace: Schema.Array(WorkflowSandboxTraceEntry),
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
      kind: Schema.Literals(["completed", "failed", "stopped"]),
      value: Schema.optionalKey(Schema.Unknown),
    }),
    MaskedWorkflowValue,
  ]),
  activityTrace: WorkflowActivityTrace,
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
  "run-stop-not-allowed",
  "run-stop-needs-attention",
  "run-not-suspended",
  "run-resume-not-allowed",
  "workflow-deferred-not-found",
  "workflow-deferred-value-invalid",
  "execution-trace-cursor-malformed",
  "execution-trace-cursor-version-unsupported",
  "execution-trace-cursor-filter-mismatch",
  "execution-trace-cursor-run-mismatch",
  "execution-trace-query-invalid",
  "execution-artifact-not-found",
  "execution-artifact-unavailable",
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
    Schema.Struct({
      kind: Schema.Literal("artifact"),
      identity: ProjectIdentity,
      runId: WorkflowRunId,
      artifactId: Schema.String,
    }),
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
  parentRunId: Schema.optionalKey(Schema.NullOr(WorkflowRunId)),
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

/**
 * The closed v1 catalog. A future Host may retain a newer Event, but a v1
 * client receives it as an explicit compatibility placeholder rather than
 * silently skipping evidence from the Execution Trace.
 */
export const EXECUTION_EVENT_KINDS_V1 = [
  "run.accepted",
  "run.engine-confirmed",
  "run.suspended",
  "run.resumed",
  "run.stop-requested",
  "run.stopped",
  "run.completed",
  "run.failed",
  "run.late-engine-outcome",
  "child.requested",
  "child.linked",
  "child.finished",
  "activity.attempt-started",
  "activity.result-observed",
  "activity.result-confirmed",
  "activity.result-reused",
  "deferred.created",
  "deferred.completed",
  "clock.scheduled",
  "clock.fired",
  "boundary.started",
  "boundary.completed",
  "artifact.recorded",
  "artifact.unavailable",
  "reconciliation.observation-restored",
] as const;

export const ExecutionEventKindV1 = Schema.Literals(EXECUTION_EVENT_KINDS_V1);
export type ExecutionEventKindV1 = typeof ExecutionEventKindV1.Type;

/**
 * Reader-only identities written before ADR 0011 named the final v1 catalog.
 * ADR 0012 documents why they remain decodable, while every new write uses
 * `EXECUTION_EVENT_KINDS_V1` above.
 */
export const LEGACY_PERSISTED_EXECUTION_EVENT_KINDS_V1 = [
  "child.started",
  "workflow-deferred.completed",
  "run.engine-recovery-queued",
  "run.engine-late-outcome",
  // Sandbox and Agent adapters wrote these source-specific identities before
  // ADR 0011 settled their durable representation as Boundary Events.
  "sandbox.acquired",
  "sandbox.session-recreated",
  "command.completed",
  "command.failed",
  "command.timed-out",
  "agent.started",
  "agent.completed",
  "agent.failed",
  "agent.session-continued",
  "agent.replayed",
] as const;

export const ExecutionTraceCompatibility = Schema.Literals([
  "supported",
  "envelope-version-unsupported",
  "kind-version-unsupported",
]);
export type ExecutionTraceCompatibility = typeof ExecutionTraceCompatibility.Type;

export const ExecutionTraceEventFamily = Schema.Literals([
  "run",
  "child",
  "activity",
  "deferred",
  "clock",
  "boundary",
  "artifact",
  "reconciliation",
]);
export type ExecutionTraceEventFamily = typeof ExecutionTraceEventFamily.Type;

export const ExecutionTraceTriggerKind = Schema.Literals(["manual", "schedule", "child"]);
export type ExecutionTraceTriggerKind = typeof ExecutionTraceTriggerKind.Type;

export const ExecutionTraceArtifactCondition = Schema.Literals(["available", "missing", "expired"]);
export type ExecutionTraceArtifactCondition = typeof ExecutionTraceArtifactCondition.Type;

/** One safe, chronological entry in a Workflow Run's immutable trace. */
export const ExecutionTraceEvent = Schema.Struct({
  eventId: Schema.String,
  runId: WorkflowRunId,
  sequence: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  envelopeVersion: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  kind: Schema.String,
  kindVersion: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  recordedAtMs: Schema.Number,
  observedAtMs: Schema.NullOr(Schema.Number),
  engineOperationId: Schema.NullOr(Schema.String),
  activityAttemptId: Schema.NullOr(Schema.String),
  boundaryId: Schema.NullOr(Schema.String),
  childRunId: Schema.NullOr(WorkflowRunId),
  compatibility: ExecutionTraceCompatibility,
  /** Payloads remain masked by default, including every unsupported Event. */
  payload: Schema.Unknown,
});
export type ExecutionTraceEvent = typeof ExecutionTraceEvent.Type;

/**
 * These are deliberately indexed metadata fields. Trace filtering never
 * inspects opaque payload JSON, so index and cursor behavior stay stable.
 */
export const ExecutionTraceFilters = Schema.Struct({
  activityNames: Schema.optionalKey(Schema.Array(Schema.String)),
  kinds: Schema.Array(ExecutionEventKindV1),
  eventFamilies: Schema.optionalKey(Schema.Array(ExecutionTraceEventFamily)),
  boundaryIds: Schema.optionalKey(Schema.Array(Schema.String)),
  artifactConditions: Schema.optionalKey(Schema.Array(ExecutionTraceArtifactCondition)),
  engineOperationIds: Schema.Array(Schema.String),
  activityAttemptIds: Schema.Array(Schema.String),
  childRunIds: Schema.Array(WorkflowRunId),
  runStates: Schema.optionalKey(Schema.Array(WorkflowRunState)),
  workflowKeys: Schema.optionalKey(Schema.Array(Schema.String)),
  triggerKinds: Schema.optionalKey(Schema.Array(ExecutionTraceTriggerKind)),
  parentRunIds: Schema.optionalKey(Schema.Array(WorkflowRunId)),
  scheduleKeys: Schema.optionalKey(Schema.Array(Schema.String)),
  occurrenceOutcomes: Schema.optionalKey(Schema.Array(WorkflowScheduleOccurrenceOutcome)),
  recordedAfterMs: Schema.optionalKey(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  ),
  recordedBeforeMs: Schema.optionalKey(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  ),
});
export type ExecutionTraceFilters = typeof ExecutionTraceFilters.Type;

/** The one settled empty-filter value shared by every Trace consumer. */
export const EMPTY_EXECUTION_TRACE_FILTERS: ExecutionTraceFilters = {
  activityNames: [],
  artifactConditions: [],
  boundaryIds: [],
  activityAttemptIds: [],
  childRunIds: [],
  engineOperationIds: [],
  eventFamilies: [],
  kinds: [],
  occurrenceOutcomes: [],
  parentRunIds: [],
  runStates: [],
  scheduleKeys: [],
  triggerKinds: [],
  workflowKeys: [],
};

export const ExecutionTraceReadInput = Schema.Struct({
  identity: ProjectIdentity,
  runId: WorkflowRunId,
  filters: ExecutionTraceFilters,
  afterSequence: Schema.optionalKey(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  ),
  beforeSequence: Schema.optionalKey(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  ),
  cursor: Schema.optionalKey(Schema.String),
  limit: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 500 })).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(100)),
  ),
});
export type ExecutionTraceReadInput = typeof ExecutionTraceReadInput.Type;

export const ExecutionTracePage = Schema.Struct({
  events: Schema.Array(ExecutionTraceEvent),
  firstSequence: Schema.NullOr(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  ),
  hasMore: Schema.Boolean,
  lastSequence: Schema.NullOr(
    Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  ),
  nextCursor: Schema.NullOr(Schema.String),
  highWaterSequence: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  /** The state is a snapshot for follow clients; it is not derived from Events. */
  runState: WorkflowRunState,
  final: Schema.Boolean,
});
export type ExecutionTracePage = typeof ExecutionTracePage.Type;

export const ExecutionTraceQueryResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), page: ExecutionTracePage }),
  Schema.Struct({ ok: Schema.Literal(false), error: WorkflowRunOperationError }),
]);
export type ExecutionTraceQueryResult = typeof ExecutionTraceQueryResult.Type;

/** Safe, recorded metadata for an Artifact. Content is never part of a Trace Event. */
export const ExecutionArtifact = Schema.Struct({
  artifactId: Schema.String,
  byteSize: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  condition: ExecutionTraceArtifactCondition,
  createdAtMs: Schema.Number,
  displayName: Schema.String,
  mediaType: Schema.String,
  sha256: Schema.String,
  unavailableAtMs: Schema.NullOr(Schema.Number),
  unavailableReasonCode: Schema.NullOr(Schema.String),
});
export type ExecutionArtifact = typeof ExecutionArtifact.Type;

/**
 * Explicitly selects the two independent sensitive export actions. Revealing
 * Event payloads never opts a caller into Artifact bytes.
 */
export const ExecutionTraceExportInput = Schema.Struct({
  identity: ProjectIdentity,
  includeArtifacts: Schema.Boolean,
  revealPayloads: Schema.Boolean,
  runId: WorkflowRunId,
});
export type ExecutionTraceExportInput = typeof ExecutionTraceExportInput.Type;

export const ExecutionTraceExportArtifact = Schema.Struct({
  artifact: ExecutionArtifact,
  /** Present only when the caller explicitly requested this Artifact's content. */
  contentBase64: Schema.NullOr(Schema.String),
});
export type ExecutionTraceExportArtifact = typeof ExecutionTraceExportArtifact.Type;

/**
 * A point-in-time durable Trace snapshot. `highWaterSequence` bounds every
 * Event in `events`, even if a live Run records more evidence while the caller
 * writes its ZIP.
 */
export const ExecutionTraceExport = Schema.Struct({
  artifacts: Schema.Array(ExecutionTraceExportArtifact),
  compatibilityWarnings: Schema.Array(
    Schema.Struct({
      compatibility: ExecutionTraceCompatibility,
      eventId: Schema.String,
      sequence: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
    }),
  ),
  events: Schema.Array(ExecutionTraceEvent),
  exportedAtMs: Schema.Number,
  final: Schema.Boolean,
  formatVersion: Schema.Literal(1),
  highWaterSequence: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  projectIdentity: ProjectIdentity,
  runId: WorkflowRunId,
  runState: WorkflowRunState,
});
export type ExecutionTraceExport = typeof ExecutionTraceExport.Type;

export const ExecutionTraceExportResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), trace: ExecutionTraceExport }),
  Schema.Struct({ ok: Schema.Literal(false), error: WorkflowRunOperationError }),
]);
export type ExecutionTraceExportResult = typeof ExecutionTraceExportResult.Type;

/** The Host returns bytes only after validating Project, Run, and Artifact identity. */
export const ExecutionArtifactDownloadInput = Schema.Struct({
  artifactId: Schema.String,
  identity: ProjectIdentity,
  runId: WorkflowRunId,
});
export type ExecutionArtifactDownloadInput = typeof ExecutionArtifactDownloadInput.Type;

export const ExecutionArtifactDownload = Schema.Struct({
  artifact: ExecutionArtifact,
  contentBase64: Schema.String,
});
export type ExecutionArtifactDownload = typeof ExecutionArtifactDownload.Type;

export const ExecutionArtifactDownloadResult = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), download: ExecutionArtifactDownload }),
  Schema.Struct({ ok: Schema.Literal(false), error: WorkflowRunOperationError }),
]);
export type ExecutionArtifactDownloadResult = typeof ExecutionArtifactDownloadResult.Type;

export const ControlSubscriptionTopic = Schema.Literals([
  "readiness",
  "schedules",
  "runs",
  "traces",
]);
export type ControlSubscriptionTopic = typeof ControlSubscriptionTopic.Type;

export const ExecutionTraceSubscription = Schema.Struct({
  identity: ProjectIdentity,
  runId: WorkflowRunId,
  afterSequence: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
});
export type ExecutionTraceSubscription = typeof ExecutionTraceSubscription.Type;

/**
 * This identifier and sequence are deliberately ephemeral. They acknowledge
 * delivery within one live subscription only; they neither replace nor order
 * the durable per-Run Execution Trace sequence.
 */
export const ControlSubscriptionId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
).pipe(Schema.brand("ControlSubscriptionId"));
export type ControlSubscriptionId = typeof ControlSubscriptionId.Type;

export const ControlSubscriptionDelivery = Schema.Struct({
  deliverySequence: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  subscriptionId: ControlSubscriptionId,
});
export type ControlSubscriptionDelivery = typeof ControlSubscriptionDelivery.Type;

export const ControlSubscriptionResourceTopic = Schema.Literals(["readiness", "schedules", "runs"]);
export type ControlSubscriptionResourceTopic = typeof ControlSubscriptionResourceTopic.Type;

/** A subscription is advisory; durable trace sequences are the resume point. */
export const ControlSubscriptionInput = Schema.Struct({
  projects: Schema.Array(ProjectIdentity),
  topics: Schema.Array(ControlSubscriptionTopic),
  traces: Schema.Array(ExecutionTraceSubscription),
});
export type ControlSubscriptionInput = typeof ControlSubscriptionInput.Type;

export const ControlSubscriptionUpdate = Schema.Union([
  Schema.Struct({
    ...ControlSubscriptionDelivery.fields,
    kind: Schema.Literal("resource-changed"),
    identity: ProjectIdentity,
    /** A temporary notice; clients reload the authoritative resource snapshot. */
    topic: ControlSubscriptionResourceTopic,
  }),
  Schema.Struct({
    ...ControlSubscriptionDelivery.fields,
    kind: Schema.Literal("trace-event"),
    identity: ProjectIdentity,
    runId: WorkflowRunId,
    sequence: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
    event: ExecutionTraceEvent,
  }),
  Schema.Struct({
    ...ControlSubscriptionDelivery.fields,
    kind: Schema.Literal("resync-required"),
    identity: ProjectIdentity,
    runId: WorkflowRunId,
    /** Last sequence retained by the Host at the point it requested a resync. */
    highWaterSequence: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  }),
  Schema.Struct({
    ...ControlSubscriptionDelivery.fields,
    kind: Schema.Literal("resync-required"),
    identity: ProjectIdentity,
    /**
     * A selected resource changed faster than this advisory subscription could
     * consume it. Reload that resource's authoritative snapshot; there is no
     * Run identity or durable trace sequence in this resource-scoped notice.
     */
    topic: ControlSubscriptionResourceTopic,
  }),
]);
export type ControlSubscriptionUpdate = typeof ControlSubscriptionUpdate.Type;

/** Acknowledging an expired subscription is a safe, typed no-op. */
export const ControlSubscriptionAcknowledgement = Schema.Struct({
  acknowledged: Schema.Boolean,
});
export type ControlSubscriptionAcknowledgement = typeof ControlSubscriptionAcknowledgement.Type;

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

/**
 * Describes one explicit destructive scope. The Host expands this input into
 * an immutable preview before it accepts a confirmation. An empty occurrence
 * schedule list means the Host will enumerate the schedules in the preview;
 * it is not a wildcard and cannot be supplied as one.
 */
export const DeletionScope = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("run"),
    identity: ProjectIdentity,
    runId: WorkflowRunId,
  }),
  Schema.Struct({
    kind: Schema.Literal("occurrences"),
    identity: ProjectIdentity,
    beforeMs: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
    scheduleKeys: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("schedule"),
    identity: ProjectIdentity,
    scheduleKey: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("project"),
    identity: ProjectIdentity,
  }),
]);
export type DeletionScope = typeof DeletionScope.Type;

export const DeletionPlanItemKind = Schema.Literals([
  "run",
  "occurrence",
  "schedule",
  "engine",
  "owned-file",
  "provider",
  "diagnostic",
]);
export type DeletionPlanItemKind = typeof DeletionPlanItemKind.Type;

/** The preview names every item the confirmed plan is allowed to touch. */
export const DeletionPlanItem = Schema.Struct({
  kind: DeletionPlanItemKind,
  key: Schema.String,
});
export type DeletionPlanItem = typeof DeletionPlanItem.Type;

export const DeletionPlanCounts = Schema.Struct({
  runs: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  occurrences: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  schedules: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  engine: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  ownedFiles: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  providers: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  diagnostics: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
});
export type DeletionPlanCounts = typeof DeletionPlanCounts.Type;

export const DeletionPreview = Schema.Struct({
  version: Schema.Literal(1),
  planKey: RequestKey,
  scope: DeletionScope,
  scopeDigest: Schema.String,
  observedAtMs: Schema.Number,
  expiresAtMs: Schema.Number,
  items: Schema.Array(DeletionPlanItem),
  counts: DeletionPlanCounts,
});
export type DeletionPreview = typeof DeletionPreview.Type;

export const DeletionWarningCode = Schema.Literals([
  "provider-unsupported",
  "provider-failed",
  "owned-file-missing",
]);
export type DeletionWarningCode = typeof DeletionWarningCode.Type;

export const DeletionWarning = Schema.Struct({
  code: DeletionWarningCode,
  message: Schema.String,
  next: Schema.String,
});
export type DeletionWarning = typeof DeletionWarning.Type;

/**
 * A completion receipt intentionally has no target identity, path, or scope.
 * It is safe to return again after a lost CLI response.
 */
export const DeletionReceipt = Schema.Struct({
  version: Schema.Literal(1),
  requestKey: RequestKey,
  completedAtMs: Schema.Number,
  counts: DeletionPlanCounts,
  warnings: Schema.Array(DeletionWarning),
});
export type DeletionReceipt = typeof DeletionReceipt.Type;

export const DeletionOperationErrorCode = Schema.Literals([
  "project-not-found",
  "project-layout-invalid",
  "project-runtime-not-ready",
  "scope-invalid",
  "target-not-found",
  "target-not-final",
  "schedule-not-unavailable",
  "schedule-not-disabled",
  "project-runs-not-final",
  "plan-expired",
  "plan-drifted",
  "deletion-in-progress",
  "deletion-needs-attention",
  "request-key-conflict",
  "owned-file-cleanup-failed",
]);
export type DeletionOperationErrorCode = typeof DeletionOperationErrorCode.Type;

export const DeletionOperationError = Schema.Struct({
  code: DeletionOperationErrorCode,
  message: Schema.String,
  next: Schema.String,
  affectedResource: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("project"), identity: ProjectIdentity }),
    Schema.Struct({ kind: Schema.Literal("run"), identity: ProjectIdentity, runId: WorkflowRunId }),
    Schema.Struct({
      kind: Schema.Literal("schedule"),
      identity: ProjectIdentity,
      scheduleKey: Schema.String,
    }),
    Schema.Struct({
      kind: Schema.Literal("occurrences"),
      identity: ProjectIdentity,
    }),
    Schema.Struct({ kind: Schema.Literal("request-key"), requestKey: RequestKey }),
  ]),
  findingKeys: Schema.Array(Schema.String),
});
export type DeletionOperationError = typeof DeletionOperationError.Type;

export const DeletionResult = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    kind: Schema.Literal("preview"),
    preview: DeletionPreview,
  }),
  Schema.Struct({
    ok: Schema.Literal(true),
    kind: Schema.Literal("completed"),
    receipt: DeletionReceipt,
  }),
  Schema.Struct({
    ok: Schema.Literal(false),
    requestKey: RequestKey,
    error: DeletionOperationError,
  }),
]);
export type DeletionResult = typeof DeletionResult.Type;

export const HostOverview = Schema.Struct({
  host: HostInformation,
  projects: Schema.Array(ProjectSnapshot),
  // Optional so older Hosts remain decodable by a newer visualizer overview.
  readiness: Schema.optionalKey(Schema.Array(ProjectReadinessAssessment)),
  // Optional so an older Host can still serve a newer overview client.
  retention: Schema.optionalKey(Schema.Array(ProjectRetentionSnapshot)),
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

export const ShowProjectRetention = Rpc.make("ShowProjectRetention", {
  payload: { identity: ProjectIdentity },
  success: ProjectRetentionQueryResult,
});

export const SetProjectRetention = Rpc.make("SetProjectRetention", {
  payload: ProjectRetentionSetInput.fields,
  success: ProjectRetentionMutationResult,
});

export const ResetProjectRetention = Rpc.make("ResetProjectRetention", {
  payload: { identity: ProjectIdentity, requestKey: RequestKey },
  success: ProjectRetentionMutationResult,
});

/** Plans or confirms one explicit destructive execution-data scope. */
export const DeleteExecutionData = Rpc.make("DeleteExecutionData", {
  payload: {
    scope: DeletionScope,
    planKey: Schema.optionalKey(RequestKey),
  },
  success: DeletionResult,
});

export const ShowProjectReadiness = Rpc.make("ShowProjectReadiness", {
  payload: { identity: ProjectIdentity },
  success: ProjectReadinessQueryResult,
});

export const RefreshProjectReadiness = Rpc.make("RefreshProjectReadiness", {
  payload: { identity: ProjectIdentity },
  success: ProjectReadinessQueryResult,
});

export const RepairProjectReadiness = Rpc.make("RepairProjectReadiness", {
  payload: {
    identity: ProjectIdentity,
    assessmentRevision: Schema.String,
    action: ProjectReadinessActionKey,
    requestKey: RequestKey,
  },
  success: ProjectReadinessRepairResult,
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

/** Reads durable history only; it never drives Workflow Engine replay. */
export const ReadExecutionTrace = Rpc.make("ReadExecutionTrace", {
  payload: ExecutionTraceReadInput.fields,
  success: ExecutionTraceQueryResult,
});

/** Captures one bounded Trace snapshot for a caller-owned portable export. */
export const ExportExecutionTrace = Rpc.make("ExportExecutionTrace", {
  payload: ExecutionTraceExportInput.fields,
  success: ExecutionTraceExportResult,
});

/** Reads one validated Artifact as opaque bytes; consumers must deliver it as an attachment. */
export const DownloadExecutionArtifact = Rpc.make("DownloadExecutionArtifact", {
  payload: ExecutionArtifactDownloadInput.fields,
  success: ExecutionArtifactDownloadResult,
});

/**
 * A bounded, advisory stream. Consumers resume trace delivery from the durable
 * per-Run sequence after reconnecting or receiving `resync-required`.
 */
export const SubscribeControl = Rpc.make("SubscribeControl", {
  payload: ControlSubscriptionInput.fields,
  success: ControlSubscriptionUpdate,
  stream: true,
});

/**
 * Advances the ephemeral delivery window for one subscription. It has no
 * durable effect and never advances a Workflow Run's trace sequence.
 */
export const AcknowledgeControlSubscription = Rpc.make("AcknowledgeControlSubscription", {
  payload: ControlSubscriptionDelivery.fields,
  success: ControlSubscriptionAcknowledgement,
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

/**
 * Records durable stop intent before the Host interrupts the Run tree. This is
 * deliberately separate from client connection lifetime.
 */
export const StopWorkflowRun = Rpc.make("StopWorkflowRun", {
  payload: {
    identity: ProjectIdentity,
    runId: WorkflowRunId,
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
  ShowProjectRetention,
  SetProjectRetention,
  ResetProjectRetention,
  DeleteExecutionData,
  ShowProjectReadiness,
  RefreshProjectReadiness,
  RepairProjectReadiness,
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
  ReadExecutionTrace,
  ExportExecutionTrace,
  DownloadExecutionArtifact,
  SubscribeControl,
  AcknowledgeControlSubscription,
  ResumeWorkflowRun,
  CompleteWorkflowDeferred,
  StopWorkflowRun,
  RegisterProject,
  ForgetProject,
  ReplayForgetProject,
);
