import { Effect, Layer, Schema } from "effect";
import { decodeUnknown } from "../../shared/lib/decode.ts";
import { AgentDefinition } from "../models/AgentDefinition.ts";
import { rosterEntryFields } from "../models/RosterEntry.ts";
import { RosterError } from "../models/RosterError.ts";
import { Roster } from "../ports/Roster.ts";
import { rosterFrom } from "../services/rosterFrom.ts";

/**
 * One agent, written where a test can read it.
 *
 * The prompt text sits on the entry rather than in files, because that is the only difference
 * between an object roster and a YAML one. Everything else — the fields, the decoder, the faults —
 * is shared, so a fixture roster is graded by the rules a real roster is graded by.
 */
const ObjectEntry = Schema.Struct({
  ...rosterEntryFields,
  /** The agent's identity, which `prompts/<name>/system.md` holds in a real factory. */
  system: Schema.NonEmptyString,
  /** The task template, which `prompts/<name>/user.md` holds. Empty is a fair fixture. */
  user: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed(""))),
});

const ObjectRoster = Schema.Record(Schema.NonEmptyString, ObjectEntry);

/** What `layer` accepts, stated for a test that wants to build one up before handing it over. */
export type ObjectRoster = typeof ObjectRoster.Encoded;

/**
 * A roster written as a plain object — the adapter every unit test uses.
 *
 * It decodes, and it decodes through the same helper the YAML adapter uses, so a fixture with a
 * missing `purpose` fails at load with the same path-precise message a real `kojo.config.yaml`
 * would. A fake that accepted anything would let a test pass against a roster that no factory could
 * actually run.
 */
export const layer = (
  agents: ObjectRoster,
  options?: { readonly source?: string },
): Layer.Layer<Roster, RosterError> =>
  Layer.effect(
    Roster,
    Effect.gen(function* () {
      const source = options?.source ?? "<object roster>";
      const decoded = yield* decodeUnknown(ObjectRoster)(agents).pipe(
        Effect.mapError((error) => RosterError.fromSchemaError({ source }, error)),
      );

      return rosterFrom({
        source,
        definitions: Object.entries(decoded).map(
          ([name, entry]) => new AgentDefinition({ name, ...entry }),
        ),
      });
    }),
  );
