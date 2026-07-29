import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { HostInformation, ProjectIdentity, RequestKey } from "../../src";

const LegacyHostInformation = Schema.Struct({
  protocol: Schema.Struct({ major: Schema.Number, minor: Schema.Number }),
  hostVersion: Schema.String,
  capabilities: Schema.Array(Schema.Literal("projects:list")),
});

it("keeps the first 1.1 handshake decodable by a 1.0 client", () => {
  expect(
    Schema.decodeUnknownSync(LegacyHostInformation)({
      protocol: { major: 1, minor: 1 },
      hostVersion: "0.1.0",
      capabilities: ["projects:list"],
    }),
  ).toEqual({
    protocol: { major: 1, minor: 1 },
    hostVersion: "0.1.0",
    capabilities: ["projects:list"],
  });
});

it.effect("preserves unknown capabilities for forward-compatible negotiation", () =>
  Effect.gen(function* () {
    const decoded = yield* Schema.decodeUnknownEffect(HostInformation)({
      protocol: { major: 1, minor: 0 },
      hostVersion: "0.1.0",
      capabilities: ["projects:delete-everything"],
    });

    expect(decoded.capabilities).toEqual(["projects:delete-everything"]);
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
