import { describe, expect, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import * as InMemoryRoster from "../../../../../src/contexts/agent/adapters/InMemoryRoster.ts";
import { RosterError } from "../../../../../src/contexts/agent/models/RosterError.ts";
import { Roster } from "../../../../../src/contexts/agent/ports/Roster.ts";

const router = {
  purpose: "Classify the ticket into the lane that fits it",
  model: "claude-sonnet-4-5",
  tools: ["Read", "Grep"],
  system: "You are the router.",
  user: "Read the ticket and pick a lane.",
};

/** The layer builds the roster, so a load fault is the error of whatever the layer is given to. */
const loading = <A, E>(
  agents: InMemoryRoster.ObjectRoster,
  use: Effect.Effect<A, E, Roster>,
): Effect.Effect<Result.Result<A, E | RosterError>> =>
  Effect.result(use.pipe(Effect.provide(InMemoryRoster.layer(agents))));

const failure = <A, E>(outcome: Result.Result<A, E>): E => {
  if (Result.isSuccess(outcome)) throw new Error("expected the roster to refuse");
  return outcome.failure;
};

describe("the object roster", () => {
  it.effect("serves the agent it was given, tools and prompts and all", () =>
    Effect.gen(function* () {
      const outcome = yield* loading(
        { router },
        Effect.gen(function* () {
          const roster = yield* Roster;
          return { names: roster.names, definition: yield* roster.definition("router") };
        }),
      );

      expect(Result.isSuccess(outcome)).toBe(true);
      if (!Result.isSuccess(outcome)) return;
      expect(outcome.success.names).toEqual(["router"]);
      expect(outcome.success.definition.name).toBe("router");
      expect(outcome.success.definition.tools).toEqual(["Read", "Grep"]);
      expect(outcome.success.definition.system).toBe("You are the router.");
    }),
  );

  it.effect("takes the decode-side default for an agent that names no tools", () =>
    Effect.gen(function* () {
      const outcome = yield* loading(
        { scout: { purpose: "Find the fault", model: "m", system: "You are the scout." } },
        Effect.flatMap(Roster, (roster) => roster.definition("scout")),
      );

      expect(Result.isSuccess(outcome)).toBe(true);
      if (!Result.isSuccess(outcome)) return;
      expect(outcome.success.tools).toEqual([]);
      // `user` has a decode-side default too, so a fixture may leave the task template out.
      expect(outcome.success.user).toBe("");
    }),
  );

  it.effect("names the path that is wrong, and names every one of them", () =>
    Effect.gen(function* () {
      const outcome = yield* loading(
        // `purpose` is missing and `model` is a number. A roster that reported one of the two would
        // cost a second load to find the other.
        { router, scout: { model: 12, system: "You are the scout." } } as never,
        Effect.flatMap(Roster, (roster) => roster.definition("scout")),
      );

      const error = failure(outcome);
      expect(error).toBeInstanceOf(RosterError);
      if (!(error instanceof RosterError)) return;
      expect(error.fault).toBe("malformed");
      expect(error.issues.map((issue) => issue.path)).toEqual([
        ["scout", "purpose"],
        ["scout", "model"],
      ]);
      // And the rendered reason leads with the path, because the path is the answer.
      expect(error.reason).toContain("scout.purpose");
      expect(error.reason).toContain("scout.model");
    }),
  );

  it.effect("refuses an agent whose system prompt is empty, at load", () =>
    Effect.gen(function* () {
      const outcome = yield* loading(
        { router, scout: { purpose: "Find the fault", model: "m", system: "" } },
        // Nothing is asked of the roster: the failure has to come from building it, not from a call.
        Effect.map(Roster, (roster) => roster.names),
      );

      const error = failure(outcome);
      expect(error).toBeInstanceOf(RosterError);
      if (!(error instanceof RosterError)) return;
      expect(error.fault).toBe("malformed");
      expect(error.issues.map((issue) => issue.path)).toEqual([["scout", "system"]]);
    }),
  );

  it.effect("refuses a name it does not define, and says what it does define", () =>
    Effect.gen(function* () {
      const outcome = yield* loading(
        { router },
        Effect.flatMap(Roster, (roster) => roster.definition("hotfixer")),
      );

      const error = failure(outcome);
      expect(error).toBeInstanceOf(RosterError);
      if (!(error instanceof RosterError)) return;
      expect(error.fault).toBe("unknown-agent");
      expect(error.agent).toBe("hotfixer");
      expect(error.reason).toContain("router");
    }),
  );
});
