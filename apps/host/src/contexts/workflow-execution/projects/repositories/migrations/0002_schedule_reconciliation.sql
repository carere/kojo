ALTER TABLE kojo_workflow_schedule_occurrences
ADD COLUMN missed_range_count INTEGER CHECK (missed_range_count IS NULL OR missed_range_count > 0);
--> statement-breakpoint
ALTER TABLE kojo_workflow_schedule_occurrences
ADD COLUMN missed_range_last_scheduled_at_ms INTEGER CHECK (missed_range_last_scheduled_at_ms IS NULL OR missed_range_last_scheduled_at_ms >= 0);
