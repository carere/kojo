import { Context, type Effect, type Option } from "effect";
import type { AgentAnswer } from "../models/AgentAnswer.ts";
import type { AgentInvocationError } from "../models/AgentInvocationError.ts";
import type { AgentSessionId } from "../models/AgentSessionId.ts";

/**
 * What this invoker can do with a session — asked, never assumed.
 *
 * Two capabilities, not one, and the real matrix has three rows: a **bind-mount** provider captures
 * the transcript back to the host and resumes it; **no sandbox** resumes without capturing, because
 * the agent writes its session in place on the host and nothing has to move it; an **isolated**
 * provider does neither. Capture is further limited to the agent providers that have session
 * storage at all.
 *
 * None of that is derivable from a provider value — Sandcastle strips its own discriminant from the
 * published types, so an isolated provider and a no-sandbox one are structurally identical. So the
 * invoker states its capabilities, and a caller that wants a cheap correction turn reads `resume`
 * first rather than finding out by burning a call.
 */
export interface AgentCapabilities {
  /** Can a call re-enter an existing session? */
  readonly resume: boolean;
  /** Is the transcript pulled back to the host, so a rebuilt sandbox restores the agent's context? */
  readonly capture: boolean;
}

/** One agent call. The author's program owns looping, so this is one turn and never a loop. */
export interface AgentCall {
  /** The roster name of the agent to call. */
  readonly agent: string;
  readonly prompt: string;
  /**
   * `Some` re-enters that session, `None` opens a cold one.
   *
   * This is the seam the correction loop sits on: a retry that re-enters the session costs one
   * message rather than a whole cold start, which is the reason D4 puts the loop in the author's
   * program rather than in the provider.
   */
  readonly session: Option.Option<AgentSessionId>;
}

/**
 * One agent call, wherever the agent physically runs.
 *
 * The port is deliberately narrow — no iteration count, no completion signal, no schema. Sandcastle
 * offers all three; taking them would put a second control plane under Kojo's, and two control
 * planes means neither can say why a run stopped (D4). And the schema stays on Kojo's side of the
 * boundary so the decode failure lands where the correction loop can act on it (§5, claim 4).
 */
export class AgentInvoker extends Context.Service<
  AgentInvoker,
  {
    readonly capabilities: AgentCapabilities;
    readonly invoke: (call: AgentCall) => Effect.Effect<AgentAnswer, AgentInvocationError>;
  }
>()("kojo/agent/AgentInvoker") {}
