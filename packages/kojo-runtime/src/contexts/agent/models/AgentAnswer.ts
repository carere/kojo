import { Schema } from "effect";
import { AgentSessionId } from "./AgentSessionId.ts";

/**
 * What one agent call left behind.
 *
 * `output` is **text**, not a decoded envelope, and that is the whole point. The agent provider
 * never receives the schema — an invoker hands back what the agent said, and Kojo decodes it. Put
 * the decode behind the port and `EnvelopeParseError` belongs to the provider, which is exactly the
 * error the correction loop has to own.
 *
 * Everything else here is what the phase row needs and nothing more: which agent, on which model,
 * in which session, whether that session was re-entered or opened cold, and what the turn cost.
 */
export class AgentAnswer extends Schema.Class<AgentAnswer>("AgentAnswer")({
  agent: Schema.String,
  model: Schema.String,
  /** The session the call ran in — the one it resumed, or the one it opened. */
  session: AgentSessionId,
  /** True when the call re-entered an existing session, false when it started cold. */
  resumed: Schema.Boolean,
  tokensIn: Schema.Finite,
  tokensOut: Schema.Finite,
  /**
   * How much of the context window the session held after the turn, in tokens.
   *
   * Optional because only some providers report it. It travels to the phase row unchanged, where it
   * is what says whether the next correction turn has room — see `AgentCallRecord`.
   */
  contextTokens: Schema.optional(Schema.Finite),
  /** The agent's tagged output, verbatim. Narrowed to the tagged block, never decoded. */
  output: Schema.String,
}) {}
