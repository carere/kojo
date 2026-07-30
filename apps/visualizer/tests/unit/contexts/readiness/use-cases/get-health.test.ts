import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { getHealth } from "../../../../../src/contexts/readiness/use-cases/get-health";

it.effect("reports that the visualizer API is ready", () =>
  Effect.gen(function* () {
    const health = yield* getHealth;

    expect(health).toEqual({
      service: "visualizer",
      status: "ok",
    });
  }),
);
