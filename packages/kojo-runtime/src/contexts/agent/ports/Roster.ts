import { Context, type Effect } from "effect";
import type { AgentDefinition } from "../models/AgentDefinition.ts";
import type { RosterError } from "../models/RosterError.ts";

/**
 * Who the agents are.
 *
 * The port answers one question and holds no state a run can change: a roster is read once, at
 * load, and every fault in it is found there. So `names` is a value rather than an effect — by the
 * time this service exists, the roster has already been decoded, and its prompt files have already
 * been read. A roster that could still fail on the tenth phase would put a configuration mistake in
 * the middle of a two-day run.
 *
 * `definition` stays an `Effect` for one reason only: a workflow can name an agent the roster does
 * not define, and that is a real failure at a real call site rather than something the loader could
 * have caught.
 */
export class Roster extends Context.Service<
  Roster,
  {
    /** Every agent this roster defines, in the order the roster declares them. */
    readonly names: ReadonlyArray<string>;
    readonly definition: (name: string) => Effect.Effect<AgentDefinition, RosterError>;
  }
>()("kojo/agent/Roster") {}
