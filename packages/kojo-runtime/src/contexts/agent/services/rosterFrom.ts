import { Effect } from "effect";
import type { AgentDefinition } from "../models/AgentDefinition.ts";
import { RosterError } from "../models/RosterError.ts";
import type { Roster } from "../ports/Roster.ts";

/**
 * The `Roster` service over a set of definitions that are already loaded and already valid.
 *
 * Both adapters end here, and that is the point: a YAML roster and an object roster differ in where
 * the text came from, never in what the port then does with it. Sharing the tail means the two
 * cannot drift on the one thing a workflow observes — how a name that is not in the roster is
 * refused.
 */
export const rosterFrom = (options: {
  readonly source: string;
  readonly definitions: ReadonlyArray<AgentDefinition>;
}): Roster["Service"] => {
  const byName = new Map(options.definitions.map((definition) => [definition.name, definition]));
  return {
    names: options.definitions.map((definition) => definition.name),
    definition: (name: string) => {
      const found = byName.get(name);
      return found === undefined
        ? Effect.fail(
            new RosterError({
              source: options.source,
              fault: "unknown-agent",
              agent: name,
              reason: `the roster defines ${[...byName.keys()].join(", ") || "no agents"}`,
              issues: [],
              cause: undefined,
            }),
          )
        : Effect.succeed(found);
    },
  };
};
