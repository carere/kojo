import { Schema } from "effect";

/**
 * Why a call never produced an answer. Named, because the trace groups on it and the three read
 * very differently to whoever is looking.
 */
export const AgentInvocationFault = Schema.Literals([
  /** No such agent. A roster mistake, and re-prompting cannot fix it. */
  "unknown-agent",
  /** A session was asked for and this invoker cannot re-enter one. See `AgentCapabilities`. */
  "resume-unsupported",
  /** The agent ran and the call failed anyway — spawn refused, the binary died, the API said no. */
  "provider-failed",
  /**
   * The spend switch refused before a process existed. Nothing ran, and nothing was spent.
   *
   * A separate fault from `provider-failed` because the two send a reader to opposite places: a
   * provider that failed is something to fix, and this is something that was **not allowed** — and
   * the remedy is one environment variable rather than an investigation. See `AgentSpend`.
   */
  "refused-to-spend",
]);
export type AgentInvocationFault = typeof AgentInvocationFault.Type;

/**
 * The agent was never asked, or was asked and did not answer.
 *
 * Note what is **not** here: an agent that answered with something that is not the envelope. That
 * is an `EnvelopeParseError`, and the difference decides what happens next — a bad envelope is the
 * correction loop's input, and a call that never happened is not something a better prompt fixes.
 * One error meaning both would make that distinction a string comparison.
 */
export class AgentInvocationError extends Schema.TaggedError<AgentInvocationError>()(
  "AgentInvocationError",
  {
    agent: Schema.String,
    fault: AgentInvocationFault,
    reason: Schema.String,
    cause: Schema.Defect(),
  },
) {}
