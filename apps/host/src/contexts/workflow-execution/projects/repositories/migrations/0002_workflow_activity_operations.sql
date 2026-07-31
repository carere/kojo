CREATE TABLE kojo_workflow_activity_operations (
  run_id TEXT NOT NULL REFERENCES kojo_workflow_runs(run_id) ON DELETE CASCADE,
  durable_operation_key TEXT NOT NULL,
  activity_name TEXT NOT NULL,
  definition_fingerprint TEXT NOT NULL,
  confirmed_attempt_id TEXT UNIQUE,
  prepared_at_ms INTEGER NOT NULL CHECK (prepared_at_ms >= 0),
  PRIMARY KEY (run_id, durable_operation_key)
) STRICT;
--> statement-breakpoint
CREATE INDEX kojo_activity_operations_run_idx ON kojo_workflow_activity_operations(run_id, prepared_at_ms);
