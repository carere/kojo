import type { JsonValue } from "@carere/kojo-client-contracts/contexts/shared/codecs/json";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { layer } from "../../../../src/contexts/workflow/adapters/InMemoryRunRepository.ts";
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
});
