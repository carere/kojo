import { desc, sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  blob,
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const projectStoreIdentityBootstrap = sqliteTable(
  "kojo_project_store_identity",
  {
    singletonKey: integer("singleton_key").primaryKey(),
    projectIdentity: text("project_identity").notNull().unique(),
    databaseInstanceId: text("database_instance_id").notNull().unique(),
  },
  (table) => [check("project_store_identity_singleton", sql`${table.singletonKey} = 1`)],
);

export const storeMetadata = sqliteTable(
  "kojo_store_metadata",
  {
    singletonKey: integer("singleton_key").primaryKey(),
    projectIdentity: text("project_identity").notNull().unique(),
    databaseInstanceId: text("database_instance_id").notNull().unique(),
    storeFormatVersion: integer("store_format_version").notNull(),
    engineAdapterKind: text("engine_adapter_kind").notNull(),
    engineAdapterSchemaVersion: integer("engine_adapter_schema_version").notNull(),
    effectFamilyVersion: text("effect_family_version").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
    lastMigratedAtMs: integer("last_migrated_at_ms").notNull(),
  },
  (table) => [
    check("store_metadata_singleton", sql`${table.singletonKey} = 1`),
    check(
      "store_metadata_times_non_negative",
      sql`${table.createdAtMs} >= 0 AND ${table.lastMigratedAtMs} >= ${table.createdAtMs}`,
    ),
  ],
);

export const controlRequests = sqliteTable(
  "kojo_control_requests",
  {
    requestKey: text("request_key").primaryKey(),
    operationKind: text("operation_kind").notNull(),
    requestSha256: blob("request_sha256").notNull(),
    targetKind: text("target_kind").notNull(),
    targetRunId: text("target_run_id").references((): AnySQLiteColumn => workflowRuns.runId, {
      onDelete: "cascade",
    }),
    targetScheduleKey: text("target_schedule_key").references(
      (): AnySQLiteColumn => workflowScheduleStates.scheduleKey,
      { onDelete: "cascade" },
    ),
    state: text("state").notNull(),
    resultEncodingVersion: integer("result_encoding_version"),
    resultSchemaIdentity: text("result_schema_identity"),
    resultJson: text("result_json"),
    resultSensitivityMapVersion: integer("result_sensitivity_map_version"),
    resultSensitivityMapJson: text("result_sensitivity_map_json"),
    resultSha256: blob("result_sha256"),
    resultCode: text("result_code"),
    safeErrorCode: text("safe_error_code"),
    createdAtMs: integer("created_at_ms").notNull(),
    completedAtMs: integer("completed_at_ms"),
    expiresAtMs: integer("expires_at_ms"),
  },
  (table) => [
    check(
      "control_request_state_valid",
      sql`${table.state} IN ('pending', 'completed', 'needs-attention')`,
    ),
    check("control_request_sha256_length", sql`length(${table.requestSha256}) = 32`),
    check(
      "control_request_target_consistent",
      sql`(${table.targetKind} = 'none' AND ${table.targetRunId} IS NULL AND ${table.targetScheduleKey} IS NULL) OR (${table.targetKind} = 'run' AND ${table.targetRunId} IS NOT NULL AND ${table.targetScheduleKey} IS NULL) OR (${table.targetKind} = 'schedule' AND ${table.targetRunId} IS NULL AND ${table.targetScheduleKey} IS NOT NULL)`,
    ),
    check(
      "control_result_bundle_consistent",
      sql`(${table.resultEncodingVersion} IS NULL AND ${table.resultSchemaIdentity} IS NULL AND ${table.resultJson} IS NULL AND ${table.resultSensitivityMapVersion} IS NULL AND ${table.resultSensitivityMapJson} IS NULL AND ${table.resultSha256} IS NULL) OR (${table.resultEncodingVersion} IS NOT NULL AND ${table.resultSchemaIdentity} IS NOT NULL AND ${table.resultJson} IS NOT NULL AND ${table.resultSensitivityMapVersion} IS NOT NULL AND ${table.resultSensitivityMapJson} IS NOT NULL AND ${table.resultSha256} IS NOT NULL)`,
    ),
    check(
      "control_completion_consistent",
      sql`(${table.state} = 'completed' AND ${table.completedAtMs} IS NOT NULL AND ${table.resultJson} IS NOT NULL) OR (${table.state} != 'completed' AND ${table.completedAtMs} IS NULL)`,
    ),
    check(
      "control_times_non_negative",
      sql`${table.createdAtMs} >= 0 AND (${table.completedAtMs} IS NULL OR ${table.completedAtMs} >= ${table.createdAtMs}) AND (${table.expiresAtMs} IS NULL OR ${table.expiresAtMs} >= ${table.createdAtMs})`,
    ),
    check(
      "control_result_json_valid",
      sql`${table.resultJson} IS NULL OR json_valid(${table.resultJson})`,
    ),
    check(
      "control_result_sensitivity_json_valid",
      sql`${table.resultSensitivityMapJson} IS NULL OR json_valid(${table.resultSensitivityMapJson})`,
    ),
    check(
      "control_result_sha256_length",
      sql`${table.resultSha256} IS NULL OR length(${table.resultSha256}) = 32`,
    ),
    index("kojo_control_requests_active_idx")
      .on(table.createdAtMs, table.requestKey)
      .where(sql`${table.state} != 'completed'`),
    index("kojo_control_requests_expiry_idx").on(table.expiresAtMs),
    index("kojo_control_requests_run_idx").on(table.targetRunId),
    index("kojo_control_requests_schedule_idx").on(table.targetScheduleKey),
  ],
);

export const workflowScheduleStates = sqliteTable(
  "kojo_workflow_schedule_states",
  {
    scheduleKey: text("schedule_key").primaryKey(),
    enabledIntent: integer("enabled_intent").notNull(),
    condition: text("condition").notNull(),
    conditionReasonCode: text("condition_reason_code"),
    currentWorkflowKey: text("current_workflow_key"),
    currentRevision: text("current_revision"),
    currentCron: text("current_cron"),
    currentTimeZone: text("current_time_zone"),
    currentOverlapPolicy: text("current_overlap_policy"),
    currentInputRuleRevision: text("current_input_rule_revision"),
    appliedWorkflowKey: text("applied_workflow_key"),
    appliedRevision: text("applied_revision"),
    appliedCron: text("applied_cron"),
    appliedTimeZone: text("applied_time_zone"),
    appliedOverlapPolicy: text("applied_overlap_policy"),
    appliedInputRuleRevision: text("applied_input_rule_revision"),
    highWaterMarkMs: integer("high_water_mark_ms"),
    nextOccurrenceMs: integer("next_occurrence_ms"),
    rowVersion: integer("row_version").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (table) => [
    check("schedule_enabled_intent_boolean", sql`${table.enabledIntent} IN (0, 1)`),
    check(
      "schedule_condition_valid",
      sql`${table.condition} IN ('available', 'unavailable', 'needs-attention')`,
    ),
    check("schedule_row_version_positive", sql`${table.rowVersion} > 0`),
    check(
      "schedule_times_non_negative",
      sql`${table.createdAtMs} >= 0 AND ${table.updatedAtMs} >= ${table.createdAtMs} AND (${table.highWaterMarkMs} IS NULL OR ${table.highWaterMarkMs} >= 0) AND (${table.nextOccurrenceMs} IS NULL OR ${table.nextOccurrenceMs} >= 0)`,
    ),
    check(
      "schedule_current_overlap_valid",
      sql`${table.currentOverlapPolicy} IS NULL OR ${table.currentOverlapPolicy} IN ('allow', 'skip')`,
    ),
    check(
      "schedule_applied_overlap_valid",
      sql`${table.appliedOverlapPolicy} IS NULL OR ${table.appliedOverlapPolicy} IN ('allow', 'skip')`,
    ),
    check(
      "schedule_current_definition_complete",
      sql`(${table.currentWorkflowKey} IS NULL AND ${table.currentRevision} IS NULL AND ${table.currentCron} IS NULL AND ${table.currentTimeZone} IS NULL AND ${table.currentOverlapPolicy} IS NULL AND ${table.currentInputRuleRevision} IS NULL) OR (${table.currentWorkflowKey} IS NOT NULL AND ${table.currentRevision} IS NOT NULL AND ${table.currentCron} IS NOT NULL AND ${table.currentTimeZone} IS NOT NULL AND ${table.currentOverlapPolicy} IS NOT NULL AND ${table.currentInputRuleRevision} IS NOT NULL)`,
    ),
    check(
      "schedule_applied_definition_complete",
      sql`(${table.appliedWorkflowKey} IS NULL AND ${table.appliedRevision} IS NULL AND ${table.appliedCron} IS NULL AND ${table.appliedTimeZone} IS NULL AND ${table.appliedOverlapPolicy} IS NULL AND ${table.appliedInputRuleRevision} IS NULL) OR (${table.appliedWorkflowKey} IS NOT NULL AND ${table.appliedRevision} IS NOT NULL AND ${table.appliedCron} IS NOT NULL AND ${table.appliedTimeZone} IS NOT NULL AND ${table.appliedOverlapPolicy} IS NOT NULL AND ${table.appliedInputRuleRevision} IS NOT NULL)`,
    ),
    check(
      "schedule_next_occurrence_valid",
      sql`${table.nextOccurrenceMs} IS NULL OR (${table.enabledIntent} = 1 AND ${table.condition} = 'available' AND (${table.highWaterMarkMs} IS NULL OR ${table.nextOccurrenceMs} > ${table.highWaterMarkMs}))`,
    ),
    index("kojo_schedule_states_workflow_idx").on(table.currentWorkflowKey),
    index("kojo_schedule_states_due_idx")
      .on(table.nextOccurrenceMs, table.scheduleKey)
      .where(sql`${table.enabledIntent} = 1 AND ${table.condition} = 'available'`),
  ],
);

export const workflowRuns = sqliteTable(
  "kojo_workflow_runs",
  {
    runId: text("run_id").primaryKey(),
    startRequestKey: text("start_request_key").notNull().unique(),
    startRequestSha256: blob("start_request_sha256").notNull(),
    workflowKey: text("workflow_key").notNull(),
    workflowRevision: text("workflow_revision").notNull(),
    engineReferenceVersion: integer("engine_reference_version").notNull(),
    engineReferenceJson: text("engine_reference_json").notNull(),
    engineReferenceSha256: blob("engine_reference_sha256").notNull().unique(),
    triggerKind: text("trigger_kind").notNull(),
    parentRunId: text("parent_run_id").references((): AnySQLiteColumn => workflowRuns.runId, {
      onDelete: "cascade",
    }),
    childInvocationKey: text("child_invocation_key"),
    scheduleKey: text("schedule_key"),
    scheduledAtMs: integer("scheduled_at_ms"),
    scheduleRevision: text("schedule_revision"),
    state: text("state").notNull(),
    suspensionKind: text("suspension_kind"),
    suspensionReasonCode: text("suspension_reason_code"),
    suspensionDetailsJson: text("suspension_details_json"),
    suspensionSensitivityMapJson: text("suspension_sensitivity_map_json"),
    stopRequestKey: text("stop_request_key"),
    stopRequestedAtMs: integer("stop_requested_at_ms"),
    stopReasonCode: text("stop_reason_code"),
    outcomeEventId: text("outcome_event_id").unique(),
    outcomeCode: text("outcome_code"),
    outcomeSummaryJson: text("outcome_summary_json"),
    lastEventSequence: integer("last_event_sequence").notNull().default(0),
    rowVersion: integer("row_version").notNull(),
    acceptedAtMs: integer("accepted_at_ms").notNull(),
    engineConfirmedAtMs: integer("engine_confirmed_at_ms"),
    updatedAtMs: integer("updated_at_ms").notNull(),
    finalizedAtMs: integer("finalized_at_ms"),
  },
  (table) => [
    check(
      "workflow_run_state_valid",
      sql`${table.state} IN ('running', 'suspended', 'stopping', 'stopped', 'failed', 'completed')`,
    ),
    check(
      "workflow_run_trigger_valid",
      sql`${table.triggerKind} IN ('manual', 'schedule', 'child')`,
    ),
    check("workflow_run_start_sha256_length", sql`length(${table.startRequestSha256}) = 32`),
    check("workflow_run_engine_json_valid", sql`json_valid(${table.engineReferenceJson})`),
    check("workflow_run_engine_sha256_length", sql`length(${table.engineReferenceSha256}) = 32`),
    check(
      "workflow_run_suspension_json_valid",
      sql`${table.suspensionDetailsJson} IS NULL OR json_valid(${table.suspensionDetailsJson})`,
    ),
    check(
      "workflow_run_suspension_sensitivity_json_valid",
      sql`${table.suspensionSensitivityMapJson} IS NULL OR json_valid(${table.suspensionSensitivityMapJson})`,
    ),
    check(
      "workflow_run_outcome_json_valid",
      sql`${table.outcomeSummaryJson} IS NULL OR json_valid(${table.outcomeSummaryJson})`,
    ),
    check("workflow_run_row_version_positive", sql`${table.rowVersion} > 0`),
    check(
      "workflow_run_trigger_fields_consistent",
      sql`(${table.triggerKind} = 'manual' AND ${table.parentRunId} IS NULL AND ${table.childInvocationKey} IS NULL AND ${table.scheduleKey} IS NULL AND ${table.scheduledAtMs} IS NULL AND ${table.scheduleRevision} IS NULL) OR (${table.triggerKind} = 'schedule' AND ${table.parentRunId} IS NULL AND ${table.childInvocationKey} IS NULL AND ${table.scheduleKey} IS NOT NULL AND ${table.scheduledAtMs} IS NOT NULL AND ${table.scheduleRevision} IS NOT NULL) OR (${table.triggerKind} = 'child' AND ${table.parentRunId} IS NOT NULL AND ${table.childInvocationKey} IS NOT NULL AND ${table.scheduleKey} IS NULL AND ${table.scheduledAtMs} IS NULL AND ${table.scheduleRevision} IS NULL)`,
    ),
    check(
      "workflow_run_times_non_negative",
      sql`${table.acceptedAtMs} >= 0 AND ${table.updatedAtMs} >= ${table.acceptedAtMs} AND (${table.engineConfirmedAtMs} IS NULL OR ${table.engineConfirmedAtMs} >= ${table.acceptedAtMs}) AND (${table.scheduledAtMs} IS NULL OR ${table.scheduledAtMs} >= 0) AND (${table.stopRequestedAtMs} IS NULL OR ${table.stopRequestedAtMs} >= ${table.acceptedAtMs}) AND (${table.finalizedAtMs} IS NULL OR ${table.finalizedAtMs} >= ${table.acceptedAtMs})`,
    ),
    check(
      "workflow_run_final_state_valid",
      sql`((${table.state} IN ('stopped', 'failed', 'completed')) AND ${table.outcomeEventId} IS NOT NULL AND ${table.finalizedAtMs} IS NOT NULL) OR ((${table.state} IN ('running', 'suspended', 'stopping')) AND ${table.outcomeEventId} IS NULL AND ${table.finalizedAtMs} IS NULL)`,
    ),
    unique("workflow_run_child_identity").on(
      table.parentRunId,
      table.workflowKey,
      table.childInvocationKey,
    ),
    index("kojo_workflow_runs_accepted_idx").on(desc(table.acceptedAtMs), desc(table.runId)),
    index("kojo_workflow_runs_workflow_idx").on(
      table.workflowKey,
      desc(table.acceptedAtMs),
      desc(table.runId),
    ),
    index("kojo_workflow_runs_state_updated_idx").on(table.state, desc(table.updatedAtMs)),
    index("kojo_workflow_runs_parent_idx").on(table.parentRunId, desc(table.acceptedAtMs)),
    index("kojo_workflow_runs_schedule_idx").on(table.scheduleKey, desc(table.scheduledAtMs)),
    index("kojo_workflow_runs_non_final_idx")
      .on(table.updatedAtMs, table.runId)
      .where(sql`${table.state} IN ('running', 'suspended', 'stopping')`),
  ],
);

export const workflowScheduleOccurrences = sqliteTable(
  "kojo_workflow_schedule_occurrences",
  {
    scheduleKey: text("schedule_key")
      .notNull()
      .references(() => workflowScheduleStates.scheduleKey, { onDelete: "cascade" }),
    scheduledAtMs: integer("scheduled_at_ms").notNull(),
    appliedRevision: text("applied_revision").notNull(),
    resolvedInputEncodingVersion: integer("resolved_input_encoding_version").notNull(),
    resolvedInputSchemaIdentity: text("resolved_input_schema_identity").notNull(),
    resolvedInputJson: text("resolved_input_json").notNull(),
    resolvedInputSensitivityMapVersion: integer("resolved_input_sensitivity_map_version").notNull(),
    resolvedInputSensitivityMapJson: text("resolved_input_sensitivity_map_json").notNull(),
    resolvedInputSha256: blob("resolved_input_sha256").notNull(),
    outcome: text("outcome").notNull(),
    reasonCode: text("reason_code"),
    deliveryAttemptCount: integer("delivery_attempt_count").notNull(),
    plannedAtMs: integer("planned_at_ms").notNull(),
    firstAttemptedAtMs: integer("first_attempted_at_ms"),
    processedAtMs: integer("processed_at_ms"),
    linkedRunId: text("linked_run_id").references(() => workflowRuns.runId, {
      onDelete: "set null",
    }),
    deletedRunId: text("deleted_run_id"),
    deletedRunAtMs: integer("deleted_run_at_ms"),
    rowVersion: integer("row_version").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.scheduleKey, table.scheduledAtMs] }),
    check(
      "schedule_occurrence_outcome_valid",
      sql`${table.outcome} IN ('planned', 'started', 'skipped', 'invalidated', 'failed')`,
    ),
    check("schedule_occurrence_input_json_valid", sql`json_valid(${table.resolvedInputJson})`),
    check(
      "schedule_occurrence_sensitivity_json_valid",
      sql`json_valid(${table.resolvedInputSensitivityMapJson})`,
    ),
    check("schedule_occurrence_sha256_length", sql`length(${table.resolvedInputSha256}) = 32`),
    check("schedule_occurrence_row_version_positive", sql`${table.rowVersion} > 0`),
    check(
      "schedule_occurrence_lifecycle_consistent",
      sql`(${table.outcome} = 'planned' AND ${table.processedAtMs} IS NULL AND ${table.linkedRunId} IS NULL AND ${table.deletedRunId} IS NULL AND ${table.deletedRunAtMs} IS NULL) OR (${table.outcome} = 'started' AND ${table.processedAtMs} IS NOT NULL AND ((${table.linkedRunId} IS NOT NULL AND ${table.deletedRunId} IS NULL AND ${table.deletedRunAtMs} IS NULL) OR (${table.linkedRunId} IS NULL AND ${table.deletedRunId} IS NOT NULL AND ${table.deletedRunAtMs} IS NOT NULL))) OR (${table.outcome} IN ('skipped', 'invalidated', 'failed') AND ${table.processedAtMs} IS NOT NULL AND ${table.linkedRunId} IS NULL AND ${table.deletedRunId} IS NULL AND ${table.deletedRunAtMs} IS NULL)`,
    ),
    check(
      "schedule_occurrence_times_non_negative",
      sql`${table.scheduledAtMs} >= 0 AND ${table.deliveryAttemptCount} >= 0 AND ${table.plannedAtMs} >= 0 AND (${table.firstAttemptedAtMs} IS NULL OR ${table.firstAttemptedAtMs} >= ${table.plannedAtMs}) AND (${table.processedAtMs} IS NULL OR ${table.processedAtMs} >= ${table.plannedAtMs}) AND (${table.deletedRunAtMs} IS NULL OR ${table.deletedRunAtMs} >= 0)`,
    ),
    index("kojo_schedule_occurrences_history_idx").on(table.scheduleKey, desc(table.scheduledAtMs)),
    index("kojo_schedule_occurrences_outcome_idx").on(table.outcome, desc(table.scheduledAtMs)),
    index("kojo_schedule_occurrences_due_idx")
      .on(table.scheduledAtMs, table.scheduleKey)
      .where(sql`${table.outcome} = 'planned'`),
    uniqueIndex("kojo_schedule_occurrences_linked_run_unique")
      .on(table.linkedRunId)
      .where(sql`${table.linkedRunId} IS NOT NULL`),
  ],
);

export const engineOperations = sqliteTable(
  "kojo_engine_operations",
  {
    operationId: text("operation_id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => workflowRuns.runId, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    operationKey: text("operation_key").notNull(),
    requestEncodingVersion: integer("request_encoding_version").notNull(),
    requestSchemaIdentity: text("request_schema_identity").notNull(),
    requestJson: text("request_json").notNull(),
    requestSensitivityMapVersion: integer("request_sensitivity_map_version").notNull(),
    requestSensitivityMapJson: text("request_sensitivity_map_json").notNull(),
    requestSha256: blob("request_sha256").notNull(),
    state: text("state").notNull(),
    attemptCount: integer("attempt_count").notNull(),
    nextAttemptAtMs: integer("next_attempt_at_ms"),
    lastAttemptedAtMs: integer("last_attempted_at_ms"),
    confirmedAtMs: integer("confirmed_at_ms"),
    confirmationEventId: text("confirmation_event_id").unique(),
    safeErrorCode: text("safe_error_code"),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (table) => [
    unique("engine_operation_identity").on(table.runId, table.kind, table.operationKey),
    check(
      "engine_operation_state_valid",
      sql`${table.state} IN ('pending', 'confirmed', 'needs-attention')`,
    ),
    check("engine_operation_request_json_valid", sql`json_valid(${table.requestJson})`),
    check(
      "engine_operation_sensitivity_json_valid",
      sql`json_valid(${table.requestSensitivityMapJson})`,
    ),
    check("engine_operation_sha256_length", sql`length(${table.requestSha256}) = 32`),
    check(
      "engine_operation_confirmation_consistent",
      sql`(${table.state} = 'confirmed' AND ${table.confirmedAtMs} IS NOT NULL AND ${table.confirmationEventId} IS NOT NULL AND ${table.nextAttemptAtMs} IS NULL) OR (${table.state} != 'confirmed' AND ${table.confirmedAtMs} IS NULL AND ${table.confirmationEventId} IS NULL)`,
    ),
    check(
      "engine_operation_times_non_negative",
      sql`${table.attemptCount} >= 0 AND ${table.createdAtMs} >= 0 AND ${table.updatedAtMs} >= ${table.createdAtMs} AND (${table.nextAttemptAtMs} IS NULL OR ${table.nextAttemptAtMs} >= 0) AND (${table.lastAttemptedAtMs} IS NULL OR ${table.lastAttemptedAtMs} >= ${table.createdAtMs}) AND (${table.confirmedAtMs} IS NULL OR ${table.confirmedAtMs} >= ${table.createdAtMs})`,
    ),
    index("kojo_engine_operations_run_idx").on(table.runId, table.createdAtMs),
    index("kojo_engine_operations_pending_idx")
      .on(table.nextAttemptAtMs, table.operationId)
      .where(sql`${table.state} = 'pending'`),
  ],
);

/**
 * The replay contract for each developer-chosen Durable Operation Key. It is
 * separate from invocation attempts so a completed Activity can be checked for
 * conflicting reuse before Effect is asked to replay it.
 */
export const workflowActivityOperations = sqliteTable(
  "kojo_workflow_activity_operations",
  {
    runId: text("run_id")
      .notNull()
      .references(() => workflowRuns.runId, { onDelete: "cascade" }),
    durableOperationKey: text("durable_operation_key").notNull(),
    activityName: text("activity_name").notNull(),
    definitionFingerprint: text("definition_fingerprint").notNull(),
    executionGeneration: integer("execution_generation").notNull(),
    confirmedAttemptId: text("confirmed_attempt_id").unique(),
    resultJson: text("result_json"),
    preparedAtMs: integer("prepared_at_ms").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.durableOperationKey] }),
    check("workflow_activity_operation_generation_positive", sql`${table.executionGeneration} > 0`),
    check(
      "workflow_activity_operation_result_json_valid",
      sql`${table.resultJson} IS NULL OR json_valid(${table.resultJson})`,
    ),
    check("workflow_activity_operation_prepared_non_negative", sql`${table.preparedAtMs} >= 0`),
    index("kojo_activity_operations_run_idx").on(table.runId, table.preparedAtMs),
  ],
);

export const workflowActivityAttempts = sqliteTable(
  "kojo_workflow_activity_attempts",
  {
    attemptId: text("attempt_id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => workflowRuns.runId, { onDelete: "cascade" }),
    durableOperationKey: text("durable_operation_key").notNull(),
    activityName: text("activity_name").notNull(),
    executionGeneration: integer("execution_generation").notNull(),
    effectRetryNumber: integer("effect_retry_number").notNull(),
    invocationNumber: integer("invocation_number").notNull(),
    activityIdempotencyKey: text("activity_idempotency_key").notNull(),
    state: text("state").notNull(),
    outcomeCode: text("outcome_code"),
    outcomeSummaryJson: text("outcome_summary_json"),
    startedAtMs: integer("started_at_ms").notNull(),
    resultObservedAtMs: integer("result_observed_at_ms"),
    engineConfirmedAtMs: integer("engine_confirmed_at_ms"),
  },
  (table) => [
    unique("workflow_activity_attempt_identity").on(
      table.runId,
      table.durableOperationKey,
      table.effectRetryNumber,
      table.invocationNumber,
    ),
    check(
      "workflow_activity_attempt_state_valid",
      sql`${table.state} IN ('started', 'result-observed', 'engine-confirmed')`,
    ),
    check(
      "workflow_activity_outcome_json_valid",
      sql`${table.outcomeSummaryJson} IS NULL OR json_valid(${table.outcomeSummaryJson})`,
    ),
    check(
      "workflow_activity_state_consistent",
      sql`(${table.state} = 'started' AND ${table.resultObservedAtMs} IS NULL AND ${table.engineConfirmedAtMs} IS NULL) OR (${table.state} = 'result-observed' AND ${table.resultObservedAtMs} IS NOT NULL AND ${table.engineConfirmedAtMs} IS NULL) OR (${table.state} = 'engine-confirmed' AND ${table.resultObservedAtMs} IS NOT NULL AND ${table.engineConfirmedAtMs} IS NOT NULL)`,
    ),
    check(
      "workflow_activity_times_non_negative",
      sql`${table.executionGeneration} > 0 AND ${table.effectRetryNumber} >= 0 AND ${table.invocationNumber} >= 0 AND ${table.startedAtMs} >= 0 AND (${table.resultObservedAtMs} IS NULL OR ${table.resultObservedAtMs} >= ${table.startedAtMs}) AND (${table.engineConfirmedAtMs} IS NULL OR ${table.engineConfirmedAtMs} >= ${table.startedAtMs})`,
    ),
    index("kojo_activity_attempts_run_idx").on(
      table.runId,
      table.durableOperationKey,
      table.startedAtMs,
    ),
    index("kojo_activity_attempts_idempotency_idx").on(table.activityIdempotencyKey),
  ],
);

export const executionEvents = sqliteTable(
  "kojo_execution_events",
  {
    eventId: text("event_id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => workflowRuns.runId, { onDelete: "cascade" }),
    sequence: integer("sequence").notNull(),
    envelopeVersion: integer("envelope_version").notNull(),
    kind: text("kind").notNull(),
    kindVersion: integer("kind_version").notNull(),
    recordedAtMs: integer("recorded_at_ms").notNull(),
    observedAtMs: integer("observed_at_ms"),
    engineOperationId: text("engine_operation_id"),
    activityAttemptId: text("activity_attempt_id"),
    boundaryId: text("boundary_id"),
    childRunId: text("child_run_id"),
    payloadEncodingVersion: integer("payload_encoding_version").notNull(),
    payloadSchemaIdentity: text("payload_schema_identity").notNull(),
    payloadJson: text("payload_json").notNull(),
    payloadSensitivityMapVersion: integer("payload_sensitivity_map_version").notNull(),
    payloadSensitivityMapJson: text("payload_sensitivity_map_json").notNull(),
    payloadSha256: blob("payload_sha256").notNull(),
  },
  (table) => [
    unique("execution_event_sequence").on(table.runId, table.sequence),
    unique("execution_event_identity").on(table.runId, table.eventId),
    check("execution_event_sequence_positive", sql`${table.sequence} > 0`),
    check("execution_event_payload_json_valid", sql`json_valid(${table.payloadJson})`),
    check(
      "execution_event_sensitivity_json_valid",
      sql`json_valid(${table.payloadSensitivityMapJson})`,
    ),
    check("execution_event_sha256_length", sql`length(${table.payloadSha256}) = 32`),
    check(
      "execution_event_times_non_negative",
      sql`${table.envelopeVersion} > 0 AND ${table.kindVersion} > 0 AND ${table.recordedAtMs} >= 0 AND (${table.observedAtMs} IS NULL OR ${table.observedAtMs} >= 0)`,
    ),
    index("kojo_execution_events_kind_idx").on(table.runId, table.kind, table.sequence),
    index("kojo_execution_events_engine_operation_idx").on(table.engineOperationId),
    index("kojo_execution_events_activity_attempt_idx").on(table.activityAttemptId),
    index("kojo_execution_events_boundary_idx").on(table.boundaryId),
    index("kojo_execution_events_child_run_idx").on(table.childRunId),
  ],
);

export const executionArtifacts = sqliteTable(
  "kojo_execution_artifacts",
  {
    artifactId: text("artifact_id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => workflowRuns.runId, { onDelete: "cascade" }),
    storageKey: text("storage_key").notNull().unique(),
    displayName: text("display_name").notNull(),
    mediaType: text("media_type").notNull(),
    byteSize: integer("byte_size").notNull(),
    sha256: blob("sha256").notNull(),
    condition: text("condition").notNull(),
    createdAtMs: integer("created_at_ms").notNull(),
    unavailableAtMs: integer("unavailable_at_ms"),
    unavailableReasonCode: text("unavailable_reason_code"),
  },
  (table) => [
    unique("execution_artifact_run_identity").on(table.runId, table.artifactId),
    check("execution_artifact_byte_size_non_negative", sql`${table.byteSize} >= 0`),
    check("execution_artifact_sha256_length", sql`length(${table.sha256}) = 32`),
    check(
      "execution_artifact_condition_valid",
      sql`${table.condition} IN ('available', 'missing', 'expired')`,
    ),
    check(
      "execution_artifact_condition_consistent",
      sql`(${table.condition} = 'available' AND ${table.unavailableAtMs} IS NULL AND ${table.unavailableReasonCode} IS NULL) OR (${table.condition} IN ('missing', 'expired') AND ${table.unavailableAtMs} IS NOT NULL AND ${table.unavailableReasonCode} IS NOT NULL)`,
    ),
    check(
      "execution_artifact_times_non_negative",
      sql`${table.createdAtMs} >= 0 AND (${table.unavailableAtMs} IS NULL OR ${table.unavailableAtMs} >= ${table.createdAtMs})`,
    ),
    index("kojo_execution_artifacts_run_idx").on(table.runId, table.createdAtMs),
    index("kojo_execution_artifacts_condition_idx").on(table.condition),
  ],
);

export const executionEventArtifacts = sqliteTable(
  "kojo_execution_event_artifacts",
  {
    runId: text("run_id").notNull(),
    eventId: text("event_id").notNull(),
    artifactId: text("artifact_id").notNull(),
    role: text("role").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.eventId, table.artifactId, table.role] }),
    foreignKey({
      columns: [table.runId, table.eventId],
      foreignColumns: [executionEvents.runId, executionEvents.eventId],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.runId, table.artifactId],
      foreignColumns: [executionArtifacts.runId, executionArtifacts.artifactId],
    }).onDelete("cascade"),
  ],
);

export const retentionPolicy = sqliteTable(
  "kojo_retention_policy",
  {
    singletonKey: integer("singleton_key").primaryKey(),
    diagnosticMaxAgeMs: integer("diagnostic_max_age_ms"),
    diagnosticMaxBytes: integer("diagnostic_max_bytes"),
    disposableMaxAgeMs: integer("disposable_max_age_ms"),
    disposableMaxBytes: integer("disposable_max_bytes"),
    rowVersion: integer("row_version").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (table) => [
    check("retention_policy_singleton", sql`${table.singletonKey} = 1`),
    check("retention_policy_row_version_positive", sql`${table.rowVersion} > 0`),
    check("retention_policy_updated_non_negative", sql`${table.updatedAtMs} >= 0`),
    check(
      "retention_diagnostic_age_positive",
      sql`${table.diagnosticMaxAgeMs} IS NULL OR ${table.diagnosticMaxAgeMs} > 0`,
    ),
    check(
      "retention_diagnostic_bytes_positive",
      sql`${table.diagnosticMaxBytes} IS NULL OR ${table.diagnosticMaxBytes} > 0`,
    ),
    check(
      "retention_disposable_age_positive",
      sql`${table.disposableMaxAgeMs} IS NULL OR ${table.disposableMaxAgeMs} > 0`,
    ),
    check(
      "retention_disposable_bytes_positive",
      sql`${table.disposableMaxBytes} IS NULL OR ${table.disposableMaxBytes} > 0`,
    ),
  ],
);

export const deletionIntents = sqliteTable(
  "kojo_deletion_intents",
  {
    deletionId: text("deletion_id").primaryKey(),
    requestKey: text("request_key").notNull().unique(),
    targetKind: text("target_kind").notNull(),
    targetSha256: blob("target_sha256").notNull(),
    targetSnapshotJson: text("target_snapshot_json").notNull(),
    expectedRevision: integer("expected_revision"),
    phase: text("phase").notNull(),
    safeErrorCode: text("safe_error_code"),
    createdAtMs: integer("created_at_ms").notNull(),
    updatedAtMs: integer("updated_at_ms").notNull(),
  },
  (table) => [
    check(
      "deletion_intent_phase_valid",
      sql`${table.phase} IN ('quiescing', 'clearing-engine', 'clearing-owned-content', 'deleting-records', 'needs-attention')`,
    ),
    check("deletion_intent_sha256_length", sql`length(${table.targetSha256}) = 32`),
    check("deletion_intent_snapshot_json_valid", sql`json_valid(${table.targetSnapshotJson})`),
    check(
      "deletion_intent_times_non_negative",
      sql`${table.createdAtMs} >= 0 AND ${table.updatedAtMs} >= ${table.createdAtMs}`,
    ),
    index("kojo_deletion_intents_active_idx")
      .on(table.phase, table.updatedAtMs)
      .where(sql`${table.phase} != 'needs-attention'`),
  ],
);

export const deletionItems = sqliteTable(
  "kojo_deletion_items",
  {
    deletionId: text("deletion_id")
      .notNull()
      .references(() => deletionIntents.deletionId, { onDelete: "cascade" }),
    itemKind: text("item_kind").notNull(),
    itemKey: text("item_key").notNull(),
    stableOrder: integer("stable_order").notNull(),
    state: text("state").notNull(),
    attemptCount: integer("attempt_count").notNull(),
    completedAtMs: integer("completed_at_ms"),
    safeErrorCode: text("safe_error_code"),
  },
  (table) => [
    primaryKey({ columns: [table.deletionId, table.itemKind, table.itemKey] }),
    check(
      "deletion_item_state_valid",
      sql`${table.state} IN ('pending', 'completed', 'warning', 'needs-attention')`,
    ),
    check(
      "deletion_item_completion_consistent",
      sql`(${table.state} = 'completed' AND ${table.completedAtMs} IS NOT NULL) OR (${table.state} != 'completed' AND ${table.completedAtMs} IS NULL)`,
    ),
    check(
      "deletion_item_counts_non_negative",
      sql`${table.stableOrder} >= 0 AND ${table.attemptCount} >= 0 AND (${table.completedAtMs} IS NULL OR ${table.completedAtMs} >= 0)`,
    ),
    index("kojo_deletion_items_next_idx").on(table.deletionId, table.state, table.stableOrder),
  ],
);

export const schemaMigrations = sqliteTable("kojo_schema_migrations", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  hash: text("hash").notNull(),
  createdAt: integer("created_at").notNull(),
});
