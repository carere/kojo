import type { Layer } from "effect";
import { WorkflowEngine } from "effect/unstable/workflow";

/**
 * The engine a test runs on: every execution, activity result and answered gate in a plain `Map`.
 *
 * It suspends and resumes correctly **in-process** — a run stops at a gate, holds nothing, and
 * continues when the answer arrives. What it cannot do is outlive the process: the maps are built
 * when the layer is built, so closing the laptop loses every waiting run. That is the whole
 * difference between this and `SingleNodeEngine`, and it is why the durable engine exists.
 *
 * This is also a separate, hand-rolled implementation rather than the cluster engine with the
 * storage swapped, so a workflow that runs here is not proof that it runs on the real one. See
 * `InMemoryClusterEngine`.
 */
export const layer: Layer.Layer<WorkflowEngine.WorkflowEngine> = WorkflowEngine.layerMemory;
