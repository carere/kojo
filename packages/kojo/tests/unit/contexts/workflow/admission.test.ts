import type { MutationEnvelope } from "@carere/kojo-client-contracts/contexts/client/contracts/mutation";
import type { JsonValue } from "@carere/kojo-client-contracts/contexts/shared/codecs/json";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  InMemoryRunRepository,
  layer,
} from "../../../../src/contexts/workflow/adapters/InMemoryRunRepository.ts";
import { RunRepository } from "../../../../src/contexts/workflow/ports/RunRepository.ts";

const request = (payload: JsonValue) => ({
  dataIdentity: "data-1",
  requestId: crypto.randomUUID(),
  canonicalRequest: JSON.stringify(payload),
  projectId: "project-1",
  workflowName: "example",
  idempotencyKey: JSON.stringify(payload),
  payload,
  revisionId: "a".repeat(64),
  packageGraphId: "b".repeat(64),
  admittedAt: "2026-09-01T10:00:00.000Z",
});

const atomicRequest = () => {
  const mutation: MutationEnvelope = {
    mutationVersion: 1,
    requestId: "atomic-start",
    dataIdentity: "data-1",
    operation: "startWorkflow",
    target: { identityVersion: 1, kind: "workflow", parts: ["project-1", "example"] },
    arguments: { payload: { change: "reviewed" } },
    preconditions: { mode: "no-trigger", revisionId: "revision-1" },
  };
  return {
    dataIdentity: mutation.dataIdentity,
    requestId: mutation.requestId,
    canonicalRequest: JSON.stringify(mutation),
    projectId: "project-1",
    workflowName: "example",
    idempotencyKey: "atomic-start",
    payload: mutation.arguments,
    revisionId: "revision-1",
    packageGraphId: "graph-1",
    admittedAt: "2026-09-01T10:00:00.000Z",
    mutation,
    reviewedMode: "no-trigger" as const,
    reviewedRevisionId: "revision-1",
  };
};

describe("Run admission", () => {
  it.effect("keeps every JSON shape and deduplicates across revisions", () =>
    Effect.gen(function* () {
      const repository = yield* RunRepository;
      for (const payload of [null, 7, "seven", [7, null]] as const) {
        const first = yield* repository.admit(request(payload));
        expect(first.run.payload).toEqual(payload);
        expect(first.run.revisionId).toBe("a".repeat(64));

        const duplicate = yield* repository.admit({
          ...request(payload),
          revisionId: "c".repeat(64),
        });
        expect(duplicate.duplicate).toBe(true);
        expect(duplicate.run.runId).toBe(first.run.runId);
        expect(duplicate.run.revisionId).toBe("a".repeat(64));
      }
    }).pipe(Effect.provide(layer)),
  );

  it.effect("refuses changed content under one request identity", () =>
    Effect.gen(function* () {
      const repository = yield* RunRepository;
      const first = request("first");
      yield* repository.admit(first);
      const failure = yield* Effect.flip(
        repository.admit({ ...first, canonicalRequest: '"changed"', payload: "changed" }),
      );
      expect(failure.code).toBe("REQUEST_CONFLICT");
      expect((yield* repository.list).length).toBe(1);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("rolls back Run, Activity, and Operation state before the in-memory commit", () => {
    const adapter = new InMemoryRunRepository();
    adapter.reviewWorkflow("project-1", "example", "no-trigger", "revision-1");
    adapter.failNextAtomicCommit();
    return Effect.gen(function* () {
      const repository = yield* RunRepository;
      const failure = yield* Effect.flip(repository.admitAndActivateWorkflow(atomicRequest()));
      expect(failure.code).toBe("STORE_FAILED");
      expect(yield* repository.list).toEqual([]);
      expect(adapter.workflow("project-1", "example")?.activity).toBe("inactive");
      expect(adapter.operationReceipt("data-1", "atomic-start")).toBeUndefined();
    }).pipe(Effect.provide(adapter.layer));
  });

  it.effect("refuses stale reviewed Workflow mode and Revision without partial state", () => {
    const adapter = new InMemoryRunRepository();
    return Effect.gen(function* () {
      const repository = yield* RunRepository;
      adapter.reviewWorkflow("project-1", "example", "trigger", "revision-1");
      expect((yield* Effect.flip(repository.admitAndActivateWorkflow(atomicRequest()))).code).toBe(
        "WORKFLOW_REVIEW_STALE",
      );
      adapter.reviewWorkflow("project-1", "example", "no-trigger", "revision-2");
      expect((yield* Effect.flip(repository.admitAndActivateWorkflow(atomicRequest()))).code).toBe(
        "WORKFLOW_REVIEW_STALE",
      );
      expect(yield* repository.list).toEqual([]);
      expect(adapter.operationReceipt("data-1", "atomic-start")).toBeUndefined();
    }).pipe(Effect.provide(adapter.layer));
  });

  it.effect("activates once, replays exactly, and refuses changed canonical content", () => {
    const adapter = new InMemoryRunRepository();
    adapter.reviewWorkflow("project-1", "example", "no-trigger", "revision-1");
    return Effect.gen(function* () {
      const repository = yield* RunRepository;
      const first = yield* repository.admitAndActivateWorkflow(atomicRequest());
      const replay = yield* repository.admitAndActivateWorkflow(atomicRequest());
      expect(replay).toEqual(first);
      expect(yield* repository.list).toHaveLength(1);
      expect(adapter.workflow("project-1", "example")?.activity).toBe("active");
      expect(adapter.operationReceipt("data-1", "atomic-start")).toMatchObject({
        status: "committed",
        result: { kind: "run", runId: first.run.runId },
      });
      const failure = yield* Effect.flip(
        repository.admitAndActivateWorkflow({
          ...atomicRequest(),
          canonicalRequest: "changed",
        }),
      );
      expect(failure.code).toBe("REQUEST_CONFLICT");
      expect(yield* repository.list).toHaveLength(1);
    }).pipe(Effect.provide(adapter.layer));
  });
});
