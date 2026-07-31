ALTER TABLE kojo_workflow_activity_operations
  ADD COLUMN result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json));
