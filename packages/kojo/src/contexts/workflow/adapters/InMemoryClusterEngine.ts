import { Layer } from "effect";
import { ClusterWorkflowEngine, TestRunner } from "effect/unstable/cluster";
import type { WorkflowEngine } from "effect/unstable/workflow";

/**
 * The **real** cluster engine, with no SQL under it.
 *
 * `InMemoryEngine` is a different implementation of the same port, so a workflow that suspends and
 * resumes there has not exercised message envelopes, entity mailboxes, or durable-clock wakeups —
 * the three things `SingleNodeEngine` actually runs on. This layer does, and it needs no file, no
 * client and no crypto to do it: `TestRunner` has no requirements and no error channel.
 *
 * So it is the rung between the two. A durability behaviour that holds here and not in
 * `InMemoryEngine` is a behaviour of the engine Kojo ships, not of a test double.
 */
export const layer: Layer.Layer<WorkflowEngine.WorkflowEngine> = ClusterWorkflowEngine.layer.pipe(
  Layer.provide(TestRunner.layer),
);
