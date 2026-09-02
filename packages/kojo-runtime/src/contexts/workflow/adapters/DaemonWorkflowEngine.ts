import type { Layer } from "effect";
import type { WorkflowEngine } from "effect/unstable/workflow";
import type { DaemonExecutionRepository } from "../ports/DaemonExecutionRepository.ts";
import { replayLayer } from "../services/DaemonWorkflowReplay.ts";

/** Runtime adapter for the durable Workflow replay use case. */
export const layer = <RExecution>(
  revisionId: string,
  executionServices?: Layer.Layer<RExecution, never, never>,
): Layer.Layer<WorkflowEngine.WorkflowEngine, never, DaemonExecutionRepository> =>
  replayLayer(revisionId, executionServices);
