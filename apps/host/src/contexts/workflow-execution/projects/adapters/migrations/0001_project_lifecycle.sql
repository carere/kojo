CREATE TABLE kojo_schema_migrations (
  version INTEGER PRIMARY KEY NOT NULL,
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
  created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
) STRICT;

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
  UNIQUE(parent_run_id, workflow_key, child_invocation_key)
) STRICT;

INSERT INTO kojo_schema_migrations(version, applied_at)
VALUES (1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

PRAGMA user_version = 1;
