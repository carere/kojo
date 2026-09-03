import { Schema } from "effect";
import { AgentSessionId } from "../../agent/models/AgentSessionId.ts";

/**
 * The agent half of a phase row.
 *
 * A nested block rather than six loose columns on `PhaseRecord`, because the six are present
 * together or not at all: a code phase has none of them, and an agent phase that got an answer has
 * all of them. Making that "all or nothing" a shape means nobody has to read a row where the model
 * is set and the session is null and guess what happened.
 *
 * `resumed` is on the row rather than derived from the session id, because after the fact the two
 * are not the same question. A session id says *which* conversation; `resumed` says whether this
 * turn cost a cold start — which is what someone reading a slow run wants to know.
 */
export class AgentCallRecord extends Schema.Class<AgentCallRecord>("AgentCallRecord")({
  /** The roster name — who was asked, not which binary answered. */
  agent: Schema.String,
  model: Schema.String,
  session: AgentSessionId,
  resumed: Schema.Boolean,
  tokensIn: Schema.Finite,
  tokensOut: Schema.Finite,
  /**
   * How much of the context window the conversation occupied **after** the turn, in tokens.
   *
   * Not the same number as `tokensIn`, and the difference is the point: tokens in and out are what
   * this turn cost, occupancy is how much room the *next* turn has. A correction loop that keeps
   * re-entering one session fails in a way nothing else here predicts — it runs out of window — and
   * this is the only column that sees it coming.
   *
   * Absent when the invoker does not report it, which is most of them. A zero would read as an
   * empty context, which is the one thing it never is.
   */
  contextTokens: Schema.optionalKey(Schema.Finite),
}) {}
