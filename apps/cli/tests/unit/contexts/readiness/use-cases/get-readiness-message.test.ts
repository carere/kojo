import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { getReadinessMessage } from "../../../../../src/contexts/readiness/use-cases/get-readiness-message";

it.effect("starts from a known state", () =>
  Effect.gen(function* () {
    const result = yield* getReadinessMessage;

    expect(result).toBe("Kojo is ready.");
  }),
);
