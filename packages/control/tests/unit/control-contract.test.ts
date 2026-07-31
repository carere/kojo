import { expect, it } from "@effect/vitest";
import { defineConfig, defineWorkflow } from "@kojo/workflow";
import { executeWorkflow } from "@kojo/workflow/testing";
import { Effect, Schema } from "effect";
import {
  EXECUTION_EVENT_KINDS_V1,
  ExecutionEventKindV1,
  HostInformation,
  ProjectIdentity,
  RequestKey,
} from "../../src";

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

it("publishes one closed v1 Execution Event catalog", () => {
  expect(EXECUTION_EVENT_KINDS_V1).toEqual([
    "run.accepted",
    "run.engine-confirmed",
    "run.suspended",
    "run.resumed",
    "run.stop-requested",
    "run.stopped",
    "run.completed",
    "run.failed",
    "run.late-engine-outcome",
    "child.requested",
    "child.linked",
    "child.finished",
    "activity.attempt-started",
    "activity.result-observed",
    "activity.result-confirmed",
    "activity.result-reused",
    "deferred.created",
    "deferred.completed",
    "clock.scheduled",
    "clock.fired",
    "boundary.started",
    "boundary.completed",
    "artifact.recorded",
    "artifact.unavailable",
    "reconciliation.observation-restored",
  ]);
  expect(Schema.decodeUnknownSync(ExecutionEventKindV1)("activity.result-observed")).toBe(
    "activity.result-observed",
  );
  expect(() => Schema.decodeUnknownSync(ExecutionEventKindV1)("activity.unversioned")).toThrow();
  expect(() => Schema.decodeUnknownSync(ExecutionEventKindV1)("child.started")).toThrow();
});

it.effect(
  "executes complete public Workflow Definitions through the in-memory testing surface",
  () => {
    const Input = Schema.Struct({ message: Schema.String });
    const definition = defineWorkflow({
      workflowKey: "echo",
      revision: "1",
      inputSchema: Input,
      successSchema: Schema.String,
      failureSchema: Schema.Never,
      handler: (input) => Effect.succeed(input.message),
    });
    const configuration = defineConfig({ workflows: [definition] });

    return Effect.gen(function* () {
      expect(configuration.workflows).toEqual([definition]);
      expect(yield* executeWorkflow(definition, { message: "hello" })).toBe("hello");
    });
  },
);
