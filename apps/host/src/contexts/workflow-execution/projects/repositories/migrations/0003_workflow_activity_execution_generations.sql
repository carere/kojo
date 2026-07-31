ALTER TABLE kojo_workflow_activity_operations
  ADD COLUMN execution_generation INTEGER NOT NULL DEFAULT 1 CHECK (execution_generation > 0);
--> statement-breakpoint
ALTER TABLE kojo_workflow_activity_attempts
  ADD COLUMN execution_generation INTEGER NOT NULL DEFAULT 1 CHECK (execution_generation > 0);
