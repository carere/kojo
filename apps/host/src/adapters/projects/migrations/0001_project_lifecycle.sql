-- Custom Drizzle migration: SQLite STRICT tables and partial indexes are not generator output.
CREATE TABLE kojo_schema_migrations (
  version INTEGER PRIMARY KEY NOT NULL,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
) STRICT;

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

CREATE INDEX kojo_schedule_states_workflow_idx
ON kojo_workflow_schedule_states(current_workflow_key);
CREATE INDEX kojo_schedule_states_due_idx
ON kojo_workflow_schedule_states(next_occurrence_ms, schedule_key)
WHERE enabled_intent = 1 AND condition = 'available';

CREATE TABLE kojo_workflow_runs (
  run_id TEXT PRIMARY KEY NOT NULL,
  start_request_key TEXT NOT NULL UNIQUE, start_request_sha256 BLOB NOT NULL,
  workflow_key TEXT NOT NULL, workflow_revision TEXT NOT NULL,
  engine_reference_version INTEGER NOT NULL, engine_reference_json TEXT NOT NULL,
  engine_reference_sha256 BLOB NOT NULL UNIQUE,
  trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('manual', 'schedule', 'child')),
  parent_run_id TEXT REFERENCES kojo_workflow_runs(run_id) ON DELETE CASCADE,
  child_invocation_key TEXT,
  schedule_key TEXT, scheduled_at_ms INTEGER, schedule_revision TEXT,
  state TEXT NOT NULL CHECK (state IN ('running', 'suspended', 'stopping', 'stopped', 'failed', 'completed')),
  suspension_kind TEXT, suspension_reason_code TEXT, suspension_details_json TEXT,
  suspension_sensitivity_map_json TEXT,
  stop_request_key TEXT, stop_requested_at_ms INTEGER, stop_reason_code TEXT,
  outcome_event_id TEXT UNIQUE, outcome_code TEXT, outcome_summary_json TEXT,
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

CREATE INDEX kojo_workflow_runs_accepted_idx
ON kojo_workflow_runs(accepted_at_ms DESC, run_id DESC);
CREATE INDEX kojo_workflow_runs_workflow_idx
ON kojo_workflow_runs(workflow_key, accepted_at_ms DESC, run_id DESC);
CREATE INDEX kojo_workflow_runs_state_updated_idx
ON kojo_workflow_runs(state, updated_at_ms DESC);
CREATE INDEX kojo_workflow_runs_parent_idx
ON kojo_workflow_runs(parent_run_id, accepted_at_ms DESC);
CREATE INDEX kojo_workflow_runs_schedule_idx
ON kojo_workflow_runs(schedule_key, scheduled_at_ms DESC);
CREATE INDEX kojo_workflow_runs_non_final_idx
ON kojo_workflow_runs(updated_at_ms, run_id)
WHERE state IN ('running', 'suspended', 'stopping');
