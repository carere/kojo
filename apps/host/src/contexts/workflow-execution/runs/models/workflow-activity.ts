import { createHash } from "node:crypto";

export type StoredWorkflowActivityAttemptState = "started" | "result-observed" | "engine-confirmed";

export interface WorkflowActivityDefinitionIdentity {
  readonly activityName: string;
  readonly definitionFingerprint: string;
  readonly durableOperationKey: string;
}

export interface StoredWorkflowActivityOperation extends WorkflowActivityDefinitionIdentity {
  readonly confirmedAttemptId: string | null;
  readonly executionGeneration: number;
  readonly resultJson: string | null;
}

export type WorkflowActivityReplayDecision =
  | { readonly _tag: "ready"; readonly executionGeneration: number }
  | { readonly _tag: "awaiting-confirmation" }
  | {
      readonly _tag: "completed";
      readonly confirmedAttemptId: string;
      readonly executionGeneration: number;
      readonly resultJson: string;
    }
  | { readonly _tag: "conflict" };

const sameDefinition = (
  stored: StoredWorkflowActivityOperation,
  proposed: WorkflowActivityDefinitionIdentity,
) =>
  stored.activityName === proposed.activityName &&
  stored.definitionFingerprint === proposed.definitionFingerprint;

/**
 * Decides whether a replay may execute, must wait for durable confirmation,
 * reuses a result, or conflicts before another external invocation begins.
 */
export const decideWorkflowActivityReplay = (
  proposed: WorkflowActivityDefinitionIdentity,
  stored: StoredWorkflowActivityOperation | undefined,
  latestAttemptState: StoredWorkflowActivityAttemptState | undefined,
): WorkflowActivityReplayDecision => {
  if (stored === undefined) return { _tag: "ready", executionGeneration: 1 };
  if (!sameDefinition(stored, proposed)) return { _tag: "conflict" };
  if (stored.confirmedAttemptId !== null) {
    if (stored.resultJson === null) return { _tag: "conflict" };
    return {
      _tag: "completed",
      confirmedAttemptId: stored.confirmedAttemptId,
      executionGeneration: stored.executionGeneration,
      resultJson: stored.resultJson,
    };
  }
  if (latestAttemptState === "result-observed") return { _tag: "awaiting-confirmation" };
  return { _tag: "ready", executionGeneration: stored.executionGeneration };
};

/** The external identity policy is stable unless an author explicitly opts into per-retry work. */
export const workflowActivityIdempotencyKey = (
  runId: string,
  durableOperationKey: string,
  idempotency: "stable" | "per-retry",
  effectRetryNumber: number,
) =>
  createHash("sha256")
    .update(
      [
        runId,
        durableOperationKey,
        ...(idempotency === "per-retry" ? [effectRetryNumber] : []),
      ].join(":"),
    )
    .digest("hex");
