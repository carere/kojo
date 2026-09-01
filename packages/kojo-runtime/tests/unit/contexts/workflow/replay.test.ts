import type { JsonValue } from "@carere/kojo-runner-contracts/contexts/shared/codecs/json";
import { Context, Effect, Layer, Schema } from "effect";
import { Activity, Workflow, WorkflowEngine } from "effect/unstable/workflow";
import { describe, expect, it } from "vitest";
import { ResourceLeaseClient } from "../../../../src/contexts/project/ports/ResourceLeaseClient.ts";
import { layer as daemonEngine } from "../../../../src/contexts/workflow/adapters/DaemonWorkflowEngine.ts";
import { DaemonExecutionRepository } from "../../../../src/contexts/workflow/ports/DaemonExecutionRepository.ts";

describe("Daemon Workflow engine replay", () => {
  it("provides Daemon execution services inside the registered Workflow fiber", async () => {
    let acquisitionCount = 0;
    const resources = Layer.succeedContext(
      Context.make(ResourceLeaseClient, {
        beginAcquisition: (resource) =>
          Effect.sync(() => {
            acquisitionCount += 1;
            return {
              acquisitionKey: resource.acquisitionKey,
              providerIdentity: `kojo-resource:${resource.leaseId}`,
              inspectionLocator: `/fixture/${resource.leaseId}.json`,
            };
          }),
        confirmAcquired: () => Effect.void,
        beginRelease: () => Effect.void,
        confirmReleased: () => Effect.void,
        preserve: () => Effect.void,
        unresolved: () => Effect.void,
      }),
    );
    const repository = Layer.succeed(DaemonExecutionRepository, {
      beginAction: () => Effect.succeed({ kind: "perform", actionId: "action-fixture" }),
      readResult: () => Effect.as(Effect.void, undefined as JsonValue | undefined),
      commitResult: () => Effect.void,
      readDeferred: () => Effect.as(Effect.void, undefined as JsonValue | undefined),
      commitDeferred: () => Effect.void,
      scheduleWakeup: () => Effect.void,
    });
    const definition = Workflow.make("leased", {
      payload: {},
      success: Schema.Void,
      error: Schema.Never,
      idempotencyKey: () => "leased",
    });
    const registration = definition.toLayer(() =>
      Effect.gen(function* () {
        const leases = yield* ResourceLeaseClient;
        yield* leases.beginAcquisition({
          leaseId: "lease-runner",
          kind: "sandbox",
          acquisitionKey: "run/sandbox",
          detail: {},
        });
      }),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const engine = yield* WorkflowEngine.WorkflowEngine;
        yield* engine.execute(definition, {
          executionId: "run-leased",
          payload: {},
          discard: true,
        });
      }).pipe(
        Effect.provide(
          registration.pipe(
            Layer.provide(resources),
            Layer.provideMerge(
              daemonEngine("a".repeat(64), resources).pipe(Layer.provide(repository)),
            ),
          ),
        ),
      ),
    );
    expect(acquisitionCount).toBe(1);
  });

  it("uses a completed code Phase result in a fresh engine without repeating its body", async () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const results = new Map<string, JsonValue>();
        let effectCount = 0;
        const repository = Layer.succeed(DaemonExecutionRepository, {
          beginAction: () => Effect.succeed({ kind: "perform", actionId: "action-fixture" }),
          readResult: (runId, revisionId, phasePath, attempt) =>
            Effect.sync(() => results.get(JSON.stringify([runId, revisionId, phasePath, attempt]))),
          commitResult: (runId, revisionId, phasePath, attempt, result) =>
            Effect.sync(() => {
              results.set(
                JSON.stringify([runId, revisionId, phasePath, attempt]),
                JSON.parse(JSON.stringify(result)) as JsonValue,
              );
            }),
          readDeferred: () => Effect.as(Effect.void, undefined as JsonValue | undefined),
          commitDeferred: () => Effect.void,
          scheduleWakeup: () => Effect.void,
        });
        const definition = Workflow.make("one-phase", {
          payload: { value: Schema.String },
          success: Schema.String,
          error: Schema.Never,
          idempotencyKey: ({ value }) => value,
        });
        const registration = definition.toLayer(({ value }) =>
          Activity.make({
            name: "compile",
            success: Schema.String,
            error: Schema.Never,
            execute: Effect.sync(() => {
              effectCount += 1;
              return value.toUpperCase();
            }),
          }),
        );
        const run = (runner: string) =>
          Effect.gen(function* () {
            const engine = yield* WorkflowEngine.WorkflowEngine;
            return yield* engine.execute(definition, {
              executionId: "daemon-assigned-run",
              payload: { value: "kojo" },
              discard: false,
            });
          }).pipe(
            Effect.provide(
              registration.pipe(
                Layer.provideMerge(daemonEngine("a".repeat(64)).pipe(Layer.provide(repository))),
              ),
            ),
            Effect.withSpan(runner),
          );

        const first = yield* run("runner-1");
        const replayed = yield* run("runner-2");
        expect(first).toBe("KOJO");
        expect(replayed).toBe("KOJO");
        expect(effectCount).toBe(1);
        expect(results.size).toBe(1);
      }),
    ));
});
