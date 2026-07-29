import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { HostInformation, ProjectIdentity, RequestKey } from "../../src";

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

it("accepts canonical UUIDv7 Project Identities and rejects UUIDv4", () => {
  expect(Schema.decodeUnknownSync(ProjectIdentity)("019fabda-76fe-7000-a948-c929fc96b3e8")).toBe(
    "019fabda-76fe-7000-a948-c929fc96b3e8",
  );
  expect(() =>
    Schema.decodeUnknownSync(ProjectIdentity)("00000000-0000-4000-8000-000000000000"),
  ).toThrow();
});

it("accepts bounded opaque Request Keys", () => {
  expect(Schema.decodeUnknownSync(RequestKey)("settled-client-key")).toBe("settled-client-key");
  expect(() => Schema.decodeUnknownSync(RequestKey)("")).toThrow();
  expect(() => Schema.decodeUnknownSync(RequestKey)("x".repeat(257))).toThrow();
});
