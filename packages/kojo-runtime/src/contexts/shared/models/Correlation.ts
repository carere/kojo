import type { RunId } from "./RunId.ts";

/**
 * What names the unit of work that caused something, on the far side of a boundary Effect cannot
 * cross.
 *
 * Sandcastle bundles its own Effect 3 runtime into its `dist`, so a Kojo process runs two runtimes
 * side by side and nothing propagates between them — no fiber, no FiberRef, no tracing context. A
 * container is a second gap on top of that. So correlation crosses as three environment variables
 * or it does not cross at all, and timestamp matching is not a fallback: it stops working the moment
 * two lanes run in parallel, which is the case a factory reaches on its first busy afternoon.
 */
export interface Correlation {
  readonly runId: RunId;
  /**
   * The unit of work inside the run.
   *
   * A phase id when a phase is asking. A **sandbox id** when the acquisition itself is asking, which
   * is the only honest answer at that moment: a sandbox is a scope around phases, so when its
   * container starts there is no phase yet, and the row the container's own output belongs to is the
   * sandbox row. Both ids are `runId/name/discriminator`, so a reader parses one shape.
   */
  readonly phaseId: string;
  /**
   * Which attempt of that unit of work this is.
   *
   * `Activity.CurrentAttempt` counts from **1**, so `0` cannot be a phase attempt and is used for
   * the sandbox acquisition — it reads as "no phase yet" rather than as a plausible first attempt.
   */
  readonly attempt: number;
}

/** The attempt a sandbox acquisition stamps. Not a phase, so not a number a phase can have. */
export const acquisitionAttempt = 0;

/**
 * The three variables, and nothing else.
 *
 * Named rather than spelled out at each call site so the sandbox environment and the agent
 * invocation cannot drift apart — the whole value of the join is that both sides wrote the same
 * three keys.
 */
export const correlationEnvironment = (correlation: Correlation): Record<string, string> => ({
  KOJO_RUN_ID: correlation.runId,
  KOJO_PHASE_ID: correlation.phaseId,
  KOJO_ATTEMPT: String(correlation.attempt),
});
