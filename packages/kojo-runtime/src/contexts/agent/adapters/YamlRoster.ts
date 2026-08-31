import { Effect, FileSystem, Layer, Path, type PlatformError, Schema } from "effect";
import { Yaml } from "effect/unstable/encoding";
import { decodeUnknown } from "../../shared/lib/decode.ts";
import { AgentDefinition } from "../models/AgentDefinition.ts";
import { rosterEntryFields } from "../models/RosterEntry.ts";
import { RosterError } from "../models/RosterError.ts";
import { Roster } from "../ports/Roster.ts";
import { rosterFrom } from "../services/rosterFrom.ts";

/**
 * The roster half of `kojo.config.yaml`.
 *
 * Only the roster. The same file carries the sandbox and agent defaults, and a struct that refused
 * a key it does not know would make this loader the gatekeeper of a file it does not own — so
 * everything else in the document is ignored here rather than rejected.
 */
const YamlEntry = Schema.Struct({
  ...rosterEntryFields,
  /**
   * Where this agent's `system.md` and `user.md` live, relative to the config file. Absent takes
   * the convention, `prompts/<name>`, which is what `kojo init` stamps.
   */
  prompts: Schema.optional(Schema.NonEmptyString),
});

const YamlRosterFile = Schema.Struct({
  agents: Schema.Record(Schema.NonEmptyString, YamlEntry),
});

/** The two files that are an agent's prompt. Both are required, so "half a prompt" is not a state. */
const promptFiles = { system: "system.md", user: "user.md" } as const;

const make = (options: { readonly config: string }) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const source = path.resolve(options.config);
    const root = path.dirname(source);

    const fail =
      (
        fault: "unreadable" | "no-prompt",
        details: { readonly agent?: string; readonly target: string },
      ) =>
      (cause: PlatformError.PlatformError): RosterError =>
        new RosterError({
          source,
          fault,
          agent: details.agent,
          reason: `${details.target}: ${cause.message}`,
          issues: [],
          cause,
        });

    const text = yield* fileSystem
      .readFileString(source)
      .pipe(Effect.mapError(fail("unreadable", { target: source })));

    // `Yaml.parse` throws a `SyntaxError` naming the line. It is the same class of fault as an
    // entry that does not decode — the file was read and is not a roster — so it lands on the same
    // fault, and the line survives in `reason`.
    const document = yield* Effect.try({
      try: () => Yaml.parse(text),
      catch: (cause) =>
        new RosterError({
          source,
          fault: "malformed",
          reason: cause instanceof Error ? cause.message : String(cause),
          issues: [],
          cause,
        }),
    });

    const file = yield* decodeUnknown(YamlRosterFile)(document).pipe(
      Effect.mapError((error) => RosterError.fromSchemaError({ source }, error)),
    );

    /**
     * The prompts are read here, at load, and not on the first call.
     *
     * A roster that names an agent whose prompt files are missing is a factory that cannot run, and
     * finding that out at the fourth phase of a run that has already built a sandbox and burned an
     * hour is finding it out in the worst place. So every agent's prompt is read before the layer
     * exists, which is before anything spawns.
     */
    const definitions = yield* Effect.forEach(
      Object.entries(file.agents),
      ([name, entry]) =>
        Effect.gen(function* () {
          const directory = path.resolve(root, entry.prompts ?? path.join("prompts", name));
          const read = (file: string) => {
            const target = path.join(directory, file);
            return fileSystem
              .readFileString(target)
              .pipe(Effect.mapError(fail("no-prompt", { agent: name, target })));
          };

          return new AgentDefinition({
            name,
            purpose: entry.purpose,
            model: entry.model,
            tools: entry.tools,
            system: yield* read(promptFiles.system),
            user: yield* read(promptFiles.user),
          });
        }),
      // Serial on purpose: the first missing prompt is the one to report, and a concurrent read
      // would make which agent gets named depend on disk timing.
      { concurrency: 1 },
    );

    return rosterFrom({ source, definitions });
  });

/**
 * The roster as the factory owns it: `kojo.config.yaml` plus the prompt files beside it.
 *
 * This is the reference adapter. It is a layer that can fail, and that is the design — the roster
 * is decoded, and its prompts are read, while the layers are being built. A malformed roster says
 * which key is wrong before a run exists to be confused by it.
 */
export const layer = (options: {
  readonly config: string;
}): Layer.Layer<Roster, RosterError, FileSystem.FileSystem | Path.Path> =>
  Layer.effect(Roster, make(options));
