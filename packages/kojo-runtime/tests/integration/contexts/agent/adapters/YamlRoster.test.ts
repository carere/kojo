// Deep path, not the package barrel. The barrel re-exports BunRedis, which drags a Redis client in
// behind it, and AGENTS.md forbids barrel imports repo-wide.
import { dirname } from "node:path";
import * as BunServices from "@effect/platform-bun/BunServices";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Result } from "effect";
import * as YamlRoster from "../../../../../src/contexts/agent/adapters/YamlRoster.ts";
import type { RosterError } from "../../../../../src/contexts/agent/models/RosterError.ts";
import { Roster } from "../../../../../src/contexts/agent/ports/Roster.ts";

const config = `
# The roster half of a factory's own config. The sandbox half is deliberately here too, because
# this loader does not own the whole file and must not refuse a key that is not its business.
agents:
  router:
    purpose: Classify the ticket into the lane that fits it
    model: claude-sonnet-4-5
    tools: [Read, Grep]
  scout:
    purpose: Find the fault
    model: claude-sonnet-4-5
    prompts: prompts/investigator

sandbox:
  image: ./sandbox/Dockerfile
`;

const wholeFactory: Record<string, string> = {
  "kojo.config.yaml": config,
  "prompts/router/system.md": "You are the router.",
  "prompts/router/user.md": "Read the ticket and pick a lane.",
  "prompts/investigator/system.md": "You are the scout.",
  "prompts/investigator/user.md": "Read the repository and report what you find.",
};

/**
 * A factory on a real disk: the config file, and the prompt files beside it.
 *
 * Written through the platform file system into a scoped temporary directory, so a test says what a
 * factory holds in one literal and leaves nothing behind when the scope closes.
 */
const factory = <A, E>(
  files: Record<string, string>,
  use: (config: string) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "kojo-roster-" });

    for (const [name, content] of Object.entries(files)) {
      const target = path.join(root, name);
      yield* fileSystem.makeDirectory(path.dirname(target), { recursive: true });
      yield* fileSystem.writeFileString(target, content);
    }
    return yield* use(path.join(root, "kojo.config.yaml"));
  }).pipe(Effect.scoped, Effect.provide(BunServices.layer));

/**
 * Build the roster, and take what building it did.
 *
 * `names` is asked for rather than a definition, on purpose: every fault below has to be the
 * layer's, so a test that reached into the roster would not prove the fault arrived at load.
 */
const load = (files: Record<string, string>) =>
  factory(files, (config) =>
    Effect.result(
      Effect.map(Roster, (roster) => roster.names).pipe(
        Effect.provide(YamlRoster.layer({ config, factoryRoot: dirname(config) })),
      ),
    ),
  );

const refusal = (outcome: Result.Result<unknown, RosterError>): RosterError => {
  if (Result.isSuccess(outcome)) throw new Error("expected the roster to refuse");
  return outcome.failure;
};

/** The whole factory, minus one file. */
const without = (name: string): Record<string, string> =>
  Object.fromEntries(Object.entries(wholeFactory).filter(([key]) => key !== name));

describe("the yaml roster", () => {
  it.effect("loads the agents the config declares, with the prompts beside it", () =>
    Effect.gen(function* () {
      const loaded = yield* factory(wholeFactory, (config) =>
        Effect.gen(function* () {
          const roster = yield* Roster;
          return { names: roster.names, scout: yield* roster.definition("scout") };
        }).pipe(Effect.provide(YamlRoster.layer({ config, factoryRoot: dirname(config) }))),
      );

      expect(loaded.names).toEqual(["router", "scout"]);
      // `prompts` named somewhere other than the convention, and was followed.
      expect(loaded.scout.system).toBe("You are the scout.");
      expect(loaded.scout.user).toBe("Read the repository and report what you find.");
      // No `tools` key, so the decode-side default applied rather than the entry being refused.
      expect(loaded.scout.tools).toEqual([]);
      // And `sandbox:` was ignored rather than rejected.
    }),
  );

  it.effect("takes the prompt directory from the agent's name when the entry does not say", () =>
    Effect.gen(function* () {
      const router = yield* factory(wholeFactory, (config) =>
        Effect.flatMap(Roster, (roster) => roster.definition("router")).pipe(
          Effect.provide(YamlRoster.layer({ config, factoryRoot: dirname(config) })),
        ),
      );

      expect(router.system).toBe("You are the router.");
      expect(router.tools).toEqual(["Read", "Grep"]);
    }),
  );

  it.effect("names the path that is wrong, at load, before anything spawns", () =>
    Effect.gen(function* () {
      const error = refusal(
        yield* load({
          ...wholeFactory,
          "kojo.config.yaml": "agents:\n  scout:\n    model: 12\n",
        }),
      );

      expect(error.fault).toBe("malformed");
      expect(error.issues.map((issue) => issue.path)).toEqual([
        ["agents", "scout", "purpose"],
        ["agents", "scout", "model"],
      ]);
      expect(error.reason).toContain("agents.scout.purpose");
      expect(error.reason).toContain("agents.scout.model");
    }),
  );

  it.effect("refuses yaml that is not yaml, and keeps the line the parser named", () =>
    Effect.gen(function* () {
      const error = refusal(
        yield* load({ ...wholeFactory, "kojo.config.yaml": "agents:\n  router:\n\tpurpose: x\n" }),
      );

      expect(error.fault).toBe("malformed");
      expect(error.reason).toContain("line 3");
    }),
  );

  it.effect("refuses an agent with no prompt files, at load rather than at the first call", () =>
    Effect.gen(function* () {
      const error = refusal(yield* load(without("prompts/investigator/system.md")));

      expect(error.fault).toBe("no-prompt");
      expect(error.agent).toBe("scout");
      expect(error.reason).toContain("system.md");
    }),
  );

  it.effect("counts half a prompt as no prompt", () =>
    Effect.gen(function* () {
      const error = refusal(yield* load(without("prompts/router/user.md")));

      expect(error.fault).toBe("no-prompt");
      expect(error.agent).toBe("router");
      expect(error.reason).toContain("user.md");
    }),
  );

  it.effect("says the roster itself is unreadable rather than calling it malformed", () =>
    Effect.gen(function* () {
      const error = refusal(yield* load(without("kojo.config.yaml")));

      expect(error.fault).toBe("unreadable");
      expect(error.reason).toContain("kojo.config.yaml");
    }),
  );
});
