import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { HostInformation } from "../../src";

it.effect("rejects capabilities outside the versioned control contract", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      Schema.decodeUnknownEffect(HostInformation)({
        protocol: { major: 1, minor: 0 },
        hostVersion: "0.1.0",
        capabilities: ["projects:delete-everything"],
      }),
    );

    expect(String(error)).toContain("projects:list");
  }),
);
