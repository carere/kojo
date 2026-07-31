CREATE INDEX kojo_activity_attempt_generation_retry_idx
  ON kojo_workflow_activity_attempts(
    run_id,
    durable_operation_key,
    execution_generation,
    effect_retry_number
  );
