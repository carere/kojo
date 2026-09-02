import type { Effect, Layer } from "effect";
import { WorkflowEngine } from "effect/unstable/workflow";

/**
 * The Effect workflow package types its self-contained memory adapter with an `unknown` input.
 * Narrow that declaration at the test boundary: the implementation creates all of its own state.
 */
export const inMemoryWorkflowEngine =
  WorkflowEngine.layerMemory as Layer.Layer<WorkflowEngine.WorkflowEngine>;

/** Narrow a Workflow operation whose test schemas declare no encoding or decoding services. */
export const serviceFreeWorkflowEffect = <A, E>(
  effect: Effect.Effect<A, E, unknown>,
): Effect.Effect<A, E, WorkflowEngine.WorkflowEngine> =>
  effect as Effect.Effect<A, E, WorkflowEngine.WorkflowEngine>;

/** Mark a fully assembled test Layer after every required adapter is present. */
export const selfContainedTestLayer = <ROut, E>(
  layer: Layer.Layer<ROut, E, unknown>,
): Layer.Layer<ROut, E> => layer as Layer.Layer<ROut, E>;
