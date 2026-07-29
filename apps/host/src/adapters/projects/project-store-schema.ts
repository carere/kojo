import { sql } from "drizzle-orm";
import { blob, check, index, integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";

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
    parentRunId: text("parent_run_id"),
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
    check("workflow_run_row_version_positive", sql`${table.rowVersion} > 0`),
    check(
      "workflow_run_final_state_valid",
      sql`((${table.state} IN ('stopped', 'failed', 'completed')) AND ${table.outcomeEventId} IS NOT NULL AND ${table.finalizedAtMs} IS NOT NULL) OR ((${table.state} IN ('running', 'suspended', 'stopping')) AND ${table.outcomeEventId} IS NULL AND ${table.finalizedAtMs} IS NULL)`,
    ),
    unique("workflow_run_child_identity").on(
      table.parentRunId,
      table.workflowKey,
      table.childInvocationKey,
    ),
    index("kojo_workflow_runs_accepted_idx").on(table.acceptedAtMs, table.runId),
    index("kojo_workflow_runs_workflow_idx").on(table.workflowKey, table.acceptedAtMs, table.runId),
    index("kojo_workflow_runs_state_updated_idx").on(table.state, table.updatedAtMs),
    index("kojo_workflow_runs_parent_idx").on(table.parentRunId, table.acceptedAtMs),
    index("kojo_workflow_runs_schedule_idx").on(table.scheduleKey, table.scheduledAtMs),
    index("kojo_workflow_runs_non_final_idx")
      .on(table.updatedAtMs, table.runId)
      .where(sql`${table.state} IN ('running', 'suspended', 'stopping')`),
  ],
);

export const projectStoreMigrations = sqliteTable("kojo_schema_migrations", {
  version: integer("version").primaryKey(),
  checksum: text("checksum").notNull(),
  appliedAt: text("applied_at").notNull(),
});
