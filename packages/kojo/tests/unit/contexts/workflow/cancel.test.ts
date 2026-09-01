import { expect, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import { layer } from "../../../../src/contexts/workflow/adapters/InMemoryRunRepository.ts";
import { RunRepository } from "../../../../src/contexts/workflow/ports/RunRepository.ts";

const admit = (repository: RunRepository["Service"], key: string, at: number) =>
  repository.admit({
    dataIdentity: "data",
    requestId: `admit-${key}`,
    canonicalRequest: JSON.stringify(["admit", key]),
    projectId: "project",
    workflowName: "review",
    idempotencyKey: key,
    payload: { key },
    revisionId: "revision",
    packageGraphId: "graph",
    admittedAt: new Date(at).toISOString(),
  });

it.effect("cancels queued and suspended Runs without another Workflow execution", () =>
  Effect.gen(function* () {
    const repository = yield* RunRepository;
    const queued = yield* admit(repository, "queued", 1);
    const queuedCancellation = yield* repository.requestCancellation(
      queued.run.runId,
      "cancel-queued",
      new Date(2).toISOString(),
    );
    expect(queuedCancellation.requiresExecutionStop).toBe(false);
    expect(queuedCancellation.run).toMatchObject({
      state: "cancelled",
      cancellation: { state: "confirmed", source: "run" },
      cleanup: { state: "not-required" },
    });

    const suspended = yield* admit(repository, "suspended", 3);
    const authority = yield* repository.claim(
      suspended.run.runId,
      "runner",
      new Date(4).toISOString(),
    );
    yield* repository.completePhase(authority, {
      phasePath: "recorded-effect",
      attempt: 1,
      kind: "code",
      outcome: "succeeded",
      description: "A completed external effect",
      startedAt: new Date(5).toISOString(),
      endedAt: new Date(6).toISOString(),
      encodedResult: { retained: true },
    });
    yield* repository.suspend(authority, new Date(7).toISOString());
    yield* repository.requestCancellation(
      suspended.run.runId,
      "cancel-suspended",
      new Date(8).toISOString(),
    );
    expect(yield* repository.read(suspended.run.runId)).toMatchObject({
      state: "cancelled",
      cancellation: { state: "confirmed" },
    });
    expect(yield* repository.phases(suspended.run.runId)).toHaveLength(1);
  }).pipe(Effect.provide(layer)),
);

it.effect("keeps cancellation intent distinct until the executing authority has stopped", () =>
  Effect.gen(function* () {
    const repository = yield* RunRepository;
    const admission = yield* admit(repository, "executing", 1);
    const authority = yield* repository.claim(
      admission.run.runId,
      "runner",
      new Date(2).toISOString(),
    );
    const requested = yield* repository.requestCancellation(
      admission.run.runId,
      "cancel-executing",
      new Date(3).toISOString(),
    );
    expect(requested.run).toMatchObject({
      state: "executing",
      cancellation: { state: "requested" },
      cleanup: { state: "pending" },
    });
    yield* repository.confirmProjectRunnerStopped(
      "project",
      [admission.run.runId],
      new Date(4).toISOString(),
      { state: "confirmed" },
    );
    expect(yield* repository.read(admission.run.runId)).toMatchObject({
      state: "cancelled",
      revisionId: "revision",
      cancellation: { state: "confirmed" },
      cleanup: { state: "confirmed" },
    });
    const staleWrite = yield* Effect.result(
      repository.completeRun(authority, "succeeded", new Date(5).toISOString()),
    );
    expect(Result.isFailure(staleWrite)).toBe(true);
  }).pipe(Effect.provide(layer)),
);

it.effect("freezes the forced Stop target set before a later Start", () =>
  Effect.gen(function* () {
    const repository = yield* RunRepository;
    const first = yield* admit(repository, "first", 1);
    const forced = yield* repository.forceStopWorkflow({
      dataIdentity: "data",
      requestId: "forced-stop",
      canonicalRequest: "forced-stop-review",
      projectId: "project",
      workflowName: "review",
      acceptedAt: new Date(2).toISOString(),
    });
    const later = yield* admit(repository, "later", 3);
    expect(forced.targetRunIds).toEqual([first.run.runId]);
    expect(yield* repository.read(first.run.runId)).toMatchObject({
      state: "cancelled",
      cancellation: { source: "forced-workflow-stop", targetSetId: forced.targetSetId },
    });
    expect(yield* repository.read(later.run.runId)).toMatchObject({ state: "queued" });
    expect((yield* repository.read(later.run.runId))?.cancellation).toBeUndefined();
  }).pipe(Effect.provide(layer)),
);
