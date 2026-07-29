-- Custom Drizzle migration: SQLite STRICT tables, partial indexes, and immutable-event triggers
-- are not generator output. Runtime applies this checked-in migration through Drizzle migrate().
CREATE TABLE IF NOT EXISTS kojo_store_metadata (
  singleton_key INTEGER PRIMARY KEY NOT NULL CHECK (singleton_key = 1),
  project_identity TEXT NOT NULL UNIQUE,
  database_instance_id TEXT NOT NULL UNIQUE,
  store_format_version INTEGER NOT NULL,
  engine_adapter_kind TEXT NOT NULL,
  engine_adapter_schema_version INTEGER NOT NULL,
  effect_family_version TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  last_migrated_at_ms INTEGER NOT NULL
) STRICT;
--> statement-breakpoint

CREATE TABLE kojo_control_requests (
  request_key TEXT PRIMARY KEY NOT NULL,
  operation_kind TEXT NOT NULL,
  request_sha256 BLOB NOT NULL CHECK (length(request_sha256) = 32),
  target_kind TEXT NOT NULL,
  target_run_id TEXT REFERENCES kojo_workflow_runs(run_id) ON DELETE CASCADE,
  target_schedule_key TEXT REFERENCES kojo_workflow_schedule_states(schedule_key) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('pending', 'completed', 'needs-attention')),
  result_encoding_version INTEGER, result_schema_identity TEXT, result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  result_sensitivity_map_version INTEGER, result_sensitivity_map_json TEXT CHECK (result_sensitivity_map_json IS NULL OR json_valid(result_sensitivity_map_json)),
  result_sha256 BLOB CHECK (result_sha256 IS NULL OR length(result_sha256) = 32),
  result_code TEXT, safe_error_code TEXT,
  created_at_ms INTEGER NOT NULL, completed_at_ms INTEGER, expires_at_ms INTEGER
) STRICT;
--> statement-breakpoint
CREATE INDEX kojo_control_requests_active_idx ON kojo_control_requests(created_at_ms, request_key) WHERE state != 'completed';
--> statement-breakpoint
CREATE INDEX kojo_control_requests_expiry_idx ON kojo_control_requests(expires_at_ms);
--> statement-breakpoint
CREATE INDEX kojo_control_requests_run_idx ON kojo_control_requests(target_run_id);
--> statement-breakpoint
CREATE INDEX kojo_control_requests_schedule_idx ON kojo_control_requests(target_schedule_key);
--> statement-breakpoint

CREATE TABLE kojo_workflow_schedule_states (
  schedule_key TEXT PRIMARY KEY NOT NULL,
  enabled_intent INTEGER NOT NULL CHECK (enabled_intent IN (0, 1)),
  condition TEXT NOT NULL CHECK (condition IN ('available', 'unavailable', 'needs-attention')),
  condition_reason_code TEXT,
  current_workflow_key TEXT, current_revision TEXT, current_cron TEXT, current_time_zone TEXT,
  current_overlap_policy TEXT CHECK (current_overlap_policy IN ('allow', 'skip')),
  current_input_rule_revision TEXT,
  applied_workflow_key TEXT, applied_revision TEXT, applied_cron TEXT, applied_time_zone TEXT,
  applied_overlap_policy TEXT CHECK (applied_overlap_policy IN ('allow', 'skip')),
  applied_input_rule_revision TEXT,
  high_water_mark_ms INTEGER, next_occurrence_ms INTEGER,
  row_version INTEGER NOT NULL CHECK (row_version > 0),
  created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
  CHECK (
    (current_workflow_key IS NULL AND current_revision IS NULL AND current_cron IS NULL AND current_time_zone IS NULL AND current_overlap_policy IS NULL AND current_input_rule_revision IS NULL)
    OR
    (current_workflow_key IS NOT NULL AND current_revision IS NOT NULL AND current_cron IS NOT NULL AND current_time_zone IS NOT NULL AND current_overlap_policy IS NOT NULL AND current_input_rule_revision IS NOT NULL)
  ),
  CHECK (
    (applied_workflow_key IS NULL AND applied_revision IS NULL AND applied_cron IS NULL AND applied_time_zone IS NULL AND applied_overlap_policy IS NULL AND applied_input_rule_revision IS NULL)
    OR
    (applied_workflow_key IS NOT NULL AND applied_revision IS NOT NULL AND applied_cron IS NOT NULL AND applied_time_zone IS NOT NULL AND applied_overlap_policy IS NOT NULL AND applied_input_rule_revision IS NOT NULL)
  ),
  CHECK (next_occurrence_ms IS NULL OR (enabled_intent = 1 AND condition = 'available' AND (high_water_mark_ms IS NULL OR next_occurrence_ms > high_water_mark_ms)))
) STRICT;
--> statement-breakpoint

CREATE INDEX kojo_schedule_states_workflow_idx
ON kojo_workflow_schedule_states(current_workflow_key);
--> statement-breakpoint
CREATE INDEX kojo_schedule_states_due_idx
ON kojo_workflow_schedule_states(next_occurrence_ms, schedule_key)
WHERE enabled_intent = 1 AND condition = 'available';
--> statement-breakpoint

CREATE TABLE kojo_workflow_runs (
  run_id TEXT PRIMARY KEY NOT NULL,
  start_request_key TEXT NOT NULL UNIQUE, start_request_sha256 BLOB NOT NULL CHECK (length(start_request_sha256) = 32),
  workflow_key TEXT NOT NULL, workflow_revision TEXT NOT NULL,
  engine_reference_version INTEGER NOT NULL, engine_reference_json TEXT NOT NULL CHECK (json_valid(engine_reference_json)),
  engine_reference_sha256 BLOB NOT NULL UNIQUE CHECK (length(engine_reference_sha256) = 32),
  trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('manual', 'schedule', 'child')),
  parent_run_id TEXT REFERENCES kojo_workflow_runs(run_id) ON DELETE CASCADE,
  child_invocation_key TEXT,
  schedule_key TEXT, scheduled_at_ms INTEGER, schedule_revision TEXT,
  state TEXT NOT NULL CHECK (state IN ('running', 'suspended', 'stopping', 'stopped', 'failed', 'completed')),
  suspension_kind TEXT, suspension_reason_code TEXT, suspension_details_json TEXT CHECK (suspension_details_json IS NULL OR json_valid(suspension_details_json)),
  suspension_sensitivity_map_json TEXT CHECK (suspension_sensitivity_map_json IS NULL OR json_valid(suspension_sensitivity_map_json)),
  stop_request_key TEXT, stop_requested_at_ms INTEGER, stop_reason_code TEXT,
  outcome_event_id TEXT UNIQUE, outcome_code TEXT, outcome_summary_json TEXT CHECK (outcome_summary_json IS NULL OR json_valid(outcome_summary_json)),
  last_event_sequence INTEGER NOT NULL DEFAULT 0,
  row_version INTEGER NOT NULL CHECK (row_version > 0),
  accepted_at_ms INTEGER NOT NULL, engine_confirmed_at_ms INTEGER,
  updated_at_ms INTEGER NOT NULL, finalized_at_ms INTEGER,
  UNIQUE(parent_run_id, workflow_key, child_invocation_key),
  CHECK (
    (state IN ('stopped', 'failed', 'completed') AND outcome_event_id IS NOT NULL AND finalized_at_ms IS NOT NULL)
    OR
    (state IN ('running', 'suspended', 'stopping') AND outcome_event_id IS NULL AND finalized_at_ms IS NULL)
  )
) STRICT;
--> statement-breakpoint

CREATE INDEX kojo_workflow_runs_accepted_idx
ON kojo_workflow_runs(accepted_at_ms DESC, run_id DESC);
--> statement-breakpoint
CREATE INDEX kojo_workflow_runs_workflow_idx
ON kojo_workflow_runs(workflow_key, accepted_at_ms DESC, run_id DESC);
--> statement-breakpoint
CREATE INDEX kojo_workflow_runs_state_updated_idx
ON kojo_workflow_runs(state, updated_at_ms DESC);
--> statement-breakpoint
CREATE INDEX kojo_workflow_runs_parent_idx
ON kojo_workflow_runs(parent_run_id, accepted_at_ms DESC);
--> statement-breakpoint
CREATE INDEX kojo_workflow_runs_schedule_idx
ON kojo_workflow_runs(schedule_key, scheduled_at_ms DESC);
--> statement-breakpoint
CREATE INDEX kojo_workflow_runs_non_final_idx
ON kojo_workflow_runs(updated_at_ms, run_id)
WHERE state IN ('running', 'suspended', 'stopping');
--> statement-breakpoint

CREATE TABLE kojo_workflow_schedule_occurrences (
  schedule_key TEXT NOT NULL REFERENCES kojo_workflow_schedule_states(schedule_key) ON DELETE CASCADE,
  scheduled_at_ms INTEGER NOT NULL,
  applied_revision TEXT NOT NULL,
  resolved_input_encoding_version INTEGER NOT NULL,
  resolved_input_schema_identity TEXT NOT NULL,
  resolved_input_json TEXT NOT NULL CHECK (json_valid(resolved_input_json)),
  resolved_input_sensitivity_map_version INTEGER NOT NULL,
  resolved_input_sensitivity_map_json TEXT NOT NULL CHECK (json_valid(resolved_input_sensitivity_map_json)),
  resolved_input_sha256 BLOB NOT NULL CHECK (length(resolved_input_sha256) = 32),
  outcome TEXT NOT NULL CHECK (outcome IN ('planned', 'started', 'skipped', 'invalidated', 'failed')),
  reason_code TEXT, delivery_attempt_count INTEGER NOT NULL,
  planned_at_ms INTEGER NOT NULL, first_attempted_at_ms INTEGER, processed_at_ms INTEGER,
  linked_run_id TEXT REFERENCES kojo_workflow_runs(run_id) ON DELETE SET NULL,
  deleted_run_id TEXT, deleted_run_at_ms INTEGER,
  row_version INTEGER NOT NULL CHECK (row_version > 0),
  PRIMARY KEY (schedule_key, scheduled_at_ms)
) STRICT;
--> statement-breakpoint
CREATE INDEX kojo_schedule_occurrences_history_idx ON kojo_workflow_schedule_occurrences(schedule_key, scheduled_at_ms DESC);
--> statement-breakpoint
CREATE INDEX kojo_schedule_occurrences_outcome_idx ON kojo_workflow_schedule_occurrences(outcome, scheduled_at_ms DESC);
--> statement-breakpoint
CREATE INDEX kojo_schedule_occurrences_due_idx ON kojo_workflow_schedule_occurrences(scheduled_at_ms, schedule_key) WHERE outcome = 'planned';
--> statement-breakpoint
CREATE UNIQUE INDEX kojo_schedule_occurrences_linked_run_unique ON kojo_workflow_schedule_occurrences(linked_run_id) WHERE linked_run_id IS NOT NULL;
--> statement-breakpoint

CREATE TABLE kojo_engine_operations (
  operation_id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL REFERENCES kojo_workflow_runs(run_id) ON DELETE CASCADE,
  kind TEXT NOT NULL, operation_key TEXT NOT NULL,
  request_encoding_version INTEGER NOT NULL, request_schema_identity TEXT NOT NULL,
  request_json TEXT NOT NULL CHECK (json_valid(request_json)),
  request_sensitivity_map_version INTEGER NOT NULL,
  request_sensitivity_map_json TEXT NOT NULL CHECK (json_valid(request_sensitivity_map_json)),
  request_sha256 BLOB NOT NULL CHECK (length(request_sha256) = 32),
  state TEXT NOT NULL CHECK (state IN ('pending', 'confirmed', 'needs-attention')),
  attempt_count INTEGER NOT NULL, next_attempt_at_ms INTEGER, last_attempted_at_ms INTEGER,
  confirmed_at_ms INTEGER, confirmation_event_id TEXT UNIQUE, safe_error_code TEXT,
  created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
  UNIQUE (run_id, kind, operation_key)
) STRICT;
--> statement-breakpoint
CREATE INDEX kojo_engine_operations_run_idx ON kojo_engine_operations(run_id, created_at_ms);
--> statement-breakpoint
CREATE INDEX kojo_engine_operations_pending_idx ON kojo_engine_operations(next_attempt_at_ms, operation_id) WHERE state = 'pending';
--> statement-breakpoint

CREATE TABLE kojo_workflow_activity_attempts (
  attempt_id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL REFERENCES kojo_workflow_runs(run_id) ON DELETE CASCADE,
  durable_operation_key TEXT NOT NULL, activity_name TEXT NOT NULL,
  effect_retry_number INTEGER NOT NULL, invocation_number INTEGER NOT NULL,
  activity_idempotency_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('started', 'result-observed', 'engine-confirmed')),
  outcome_code TEXT, outcome_summary_json TEXT CHECK (outcome_summary_json IS NULL OR json_valid(outcome_summary_json)),
  started_at_ms INTEGER NOT NULL, result_observed_at_ms INTEGER, engine_confirmed_at_ms INTEGER,
  UNIQUE (run_id, durable_operation_key, effect_retry_number, invocation_number)
) STRICT;
--> statement-breakpoint
CREATE INDEX kojo_activity_attempts_run_idx ON kojo_workflow_activity_attempts(run_id, durable_operation_key, started_at_ms);
--> statement-breakpoint
CREATE INDEX kojo_activity_attempts_idempotency_idx ON kojo_workflow_activity_attempts(activity_idempotency_key);
--> statement-breakpoint

CREATE TABLE kojo_execution_events (
  event_id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL REFERENCES kojo_workflow_runs(run_id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK (sequence > 0), envelope_version INTEGER NOT NULL,
  kind TEXT NOT NULL, kind_version INTEGER NOT NULL, recorded_at_ms INTEGER NOT NULL,
  observed_at_ms INTEGER, engine_operation_id TEXT, activity_attempt_id TEXT,
  boundary_id TEXT, child_run_id TEXT,
  payload_encoding_version INTEGER NOT NULL, payload_schema_identity TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  payload_sensitivity_map_version INTEGER NOT NULL,
  payload_sensitivity_map_json TEXT NOT NULL CHECK (json_valid(payload_sensitivity_map_json)),
  payload_sha256 BLOB NOT NULL CHECK (length(payload_sha256) = 32),
  UNIQUE (run_id, sequence), UNIQUE (run_id, event_id)
) STRICT;
--> statement-breakpoint
CREATE INDEX kojo_execution_events_kind_idx ON kojo_execution_events(run_id, kind, sequence);
--> statement-breakpoint
CREATE INDEX kojo_execution_events_engine_operation_idx ON kojo_execution_events(engine_operation_id);
--> statement-breakpoint
CREATE INDEX kojo_execution_events_activity_attempt_idx ON kojo_execution_events(activity_attempt_id);
--> statement-breakpoint
CREATE INDEX kojo_execution_events_boundary_idx ON kojo_execution_events(boundary_id);
--> statement-breakpoint
CREATE INDEX kojo_execution_events_child_run_idx ON kojo_execution_events(child_run_id);
--> statement-breakpoint
CREATE TRIGGER kojo_execution_events_immutable BEFORE UPDATE ON kojo_execution_events BEGIN SELECT RAISE(ABORT, 'Execution Events are immutable'); END;
--> statement-breakpoint

CREATE TABLE kojo_execution_artifacts (
  artifact_id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL REFERENCES kojo_workflow_runs(run_id) ON DELETE CASCADE,
  storage_key TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, media_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0), sha256 BLOB NOT NULL CHECK (length(sha256) = 32),
  condition TEXT NOT NULL CHECK (condition IN ('available', 'missing', 'expired')),
  created_at_ms INTEGER NOT NULL, unavailable_at_ms INTEGER, unavailable_reason_code TEXT,
  UNIQUE (run_id, artifact_id)
) STRICT;
--> statement-breakpoint
CREATE INDEX kojo_execution_artifacts_run_idx ON kojo_execution_artifacts(run_id, created_at_ms);
--> statement-breakpoint
CREATE INDEX kojo_execution_artifacts_condition_idx ON kojo_execution_artifacts(condition);
--> statement-breakpoint

CREATE TABLE kojo_execution_event_artifacts (
  run_id TEXT NOT NULL, event_id TEXT NOT NULL, artifact_id TEXT NOT NULL, role TEXT NOT NULL,
  PRIMARY KEY (event_id, artifact_id, role),
  FOREIGN KEY (run_id, event_id) REFERENCES kojo_execution_events(run_id, event_id) ON DELETE CASCADE,
  FOREIGN KEY (run_id, artifact_id) REFERENCES kojo_execution_artifacts(run_id, artifact_id) ON DELETE CASCADE
) STRICT;
--> statement-breakpoint

CREATE TABLE kojo_retention_policy (
  singleton_key INTEGER PRIMARY KEY NOT NULL CHECK (singleton_key = 1),
  diagnostic_max_age_ms INTEGER, diagnostic_max_bytes INTEGER,
  disposable_max_age_ms INTEGER, disposable_max_bytes INTEGER,
  row_version INTEGER NOT NULL CHECK (row_version > 0), updated_at_ms INTEGER NOT NULL,
  CHECK (diagnostic_max_age_ms IS NULL OR diagnostic_max_age_ms > 0),
  CHECK (diagnostic_max_bytes IS NULL OR diagnostic_max_bytes > 0),
  CHECK (disposable_max_age_ms IS NULL OR disposable_max_age_ms > 0),
  CHECK (disposable_max_bytes IS NULL OR disposable_max_bytes > 0)
) STRICT;
--> statement-breakpoint

CREATE TABLE kojo_deletion_intents (
  deletion_id TEXT PRIMARY KEY NOT NULL, request_key TEXT NOT NULL UNIQUE,
  target_kind TEXT NOT NULL, target_sha256 BLOB NOT NULL CHECK (length(target_sha256) = 32),
  target_snapshot_json TEXT NOT NULL CHECK (json_valid(target_snapshot_json)),
  expected_revision INTEGER,
  phase TEXT NOT NULL CHECK (phase IN ('quiescing', 'clearing-engine', 'clearing-owned-content', 'deleting-records', 'needs-attention')),
  safe_error_code TEXT, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
) STRICT;
--> statement-breakpoint
CREATE INDEX kojo_deletion_intents_active_idx ON kojo_deletion_intents(phase, updated_at_ms) WHERE phase != 'needs-attention';
--> statement-breakpoint

CREATE TABLE kojo_deletion_items (
  deletion_id TEXT NOT NULL REFERENCES kojo_deletion_intents(deletion_id) ON DELETE CASCADE,
  item_kind TEXT NOT NULL, item_key TEXT NOT NULL, stable_order INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'completed', 'warning', 'needs-attention')),
  attempt_count INTEGER NOT NULL, completed_at_ms INTEGER, safe_error_code TEXT,
  PRIMARY KEY (deletion_id, item_kind, item_key)
) STRICT;
--> statement-breakpoint
CREATE INDEX kojo_deletion_items_next_idx ON kojo_deletion_items(deletion_id, state, stable_order);
