import { Schema } from "effect";

/**
 * One agent, as the roster defines it: one prompt, one purpose.
 *
 * This is what the `Roster` port serves, and it is deliberately the *whole* identity of an agent —
 * its system prompt, its model, and its tool allowlist. A stock agent provider drops all three
 * (typescript-effect.md §7), so an identity assembled from three places would be an identity that
 * is silently half applied. One record, read once, at load.
 *
 * `system` and `user` are separated because they are handed to different places. `system` is the
 * agent's identity and belongs to the provider that spawns it. `user` is the task template, and it
 * is what `renderPrompt` builds the call's prompt on, together with the envelope's contract.
 */
export class AgentDefinition extends Schema.Class<AgentDefinition>("AgentDefinition")({
  /** The name the workflow calls this agent by — the key it sits under in the roster. */
  name: Schema.NonEmptyString,
  /** One purpose, in one line. It is what a human reads beside this agent's phase in the trace. */
  purpose: Schema.NonEmptyString,
  model: Schema.NonEmptyString,
  /** What this agent is allowed to reach for. Empty means the provider's own default. */
  tools: Schema.Array(Schema.NonEmptyString),
  /** The agent's identity, from `system.md`. */
  system: Schema.NonEmptyString,
  /** The task template, from `user.md`. */
  user: Schema.String,
}) {}
