import { Schema } from "effect";

/**
 * Identifies one agent conversation.
 *
 * Sandcastle's word, kept: a *session* is an agent's transcript, and it is one of the three things
 * the branch-as-durable-state design carries across a suspension. Branded like a run id, because a
 * session id sits beside run and phase ids in the same rows and the same signatures.
 */
export const AgentSessionId = Schema.String.pipe(Schema.brand("AgentSessionId"));

export type AgentSessionId = typeof AgentSessionId.Type;
