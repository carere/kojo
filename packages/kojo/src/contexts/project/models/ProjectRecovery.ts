export const DEFAULT_RUNNER_REPLACEMENT_DELAYS_MILLIS = [
  1_000, 2_000, 4_000, 8_000, 16_000,
] as const;
export const DEFAULT_RUNNER_HEALTHY_RESET_MILLIS = 5 * 60_000;

export type ProjectRecoveryState = "healthy" | "recovering" | "held";
export type ProjectSafetyState = "safe" | "pending" | "uncertain";

/** Durable Project-owned supervision state. Trace and heartbeat records are not evidence here. */
export interface ProjectRecovery {
  readonly projectId: string;
  readonly cycle: number;
  readonly attempts: number;
  readonly state: ProjectRecoveryState;
  readonly safety: ProjectSafetyState;
  readonly failedOperationPending: boolean;
  readonly healthySince?: string;
  readonly nextAttemptAt?: string;
  readonly priorRunnerInstanceId?: string;
  readonly lastFault?: string;
}

export interface RunnerFailure {
  readonly projectId: string;
  readonly runnerInstanceId: string;
  readonly failedAt: string;
  readonly fault: string;
  /** True only when work, and not a heartbeat, failed. */
  readonly operationFailed: boolean;
}

export type UnsafeRunnerTraffic =
  | "malformed-frame"
  | "oversized-frame"
  | "stale-authority"
  | "wrong-scope";

export type RunnerFaultLocality = "connection" | "request";

/** Malformed and scope-expanding traffic retires the connection. Stale authority rejects one request. */
export const runnerFaultLocality = (fault: UnsafeRunnerTraffic): RunnerFaultLocality =>
  fault === "stale-authority" ? "request" : "connection";
