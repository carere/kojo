import type { AgentActivity } from "../../agent/models/AgentActivity.ts";
import type { PhaseId } from "../../shared/models/PhaseId.ts";
import type { RunId } from "../../shared/models/RunId.ts";

/** One ordered observation of a physical invocation within a Phase attempt. */
export interface InvocationObservation {
  readonly runId: RunId;
  readonly phaseId: PhaseId;
  readonly phasePath: string;
  readonly attempt: number;
  readonly invocationId: string;
  readonly sequence: number;
  readonly activity: AgentActivity;
}
