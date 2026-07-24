import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { program } from "../src/program";

it.effect("starts from a known state", () =>
  Effect.gen(function* () {
    const result = yield* program;

    expect(result).toBe("Kojo is ready.");
  }),
);
