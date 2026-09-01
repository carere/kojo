import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { layer } from "../../../../src/contexts/workflow/adapters/InMemoryRunRepository.ts";
import { RunRepository } from "../../../../src/contexts/workflow/ports/RunRepository.ts";

describe("Run Claims", () => {
  it.effect("allocates a Claim and Project slot together and fences stale writers", () =>
    Effect.gen(function* () {
      const repository = yield* RunRepository;
      const admitted = yield* repository.admit({
        dataIdentity: "data-1",
        requestId: "request-1",
        canonicalRequest: "one",
        projectId: "project-1",
        workflowName: "example",
        idempotencyKey: "one",
        payload: null,
        revisionId: "a".repeat(64),
        packageGraphId: "b".repeat(64),
        admittedAt: "2026-09-01T10:00:00.000Z",
      });
      const authority = yield* repository.claim(
        admitted.run.runId,
        "runner-1",
        "2026-09-01T10:00:01.000Z",
      );
      expect(authority.generation).toBe(1);

      const stale = yield* Effect.flip(
        repository.completePhase(
          { ...authority, runnerInstanceId: "runner-retired" },
          {
            phasePath: "compile",
            attempt: 1,
            kind: "code",
            outcome: "succeeded",
            description: "Compile",
            startedAt: "2026-09-01T10:00:01.000Z",
            endedAt: "2026-09-01T10:00:02.000Z",
            encodedResult: { ok: true },
          },
        ),
      );
      expect(stale.code).toBe("STALE_AUTHORITY");
      expect(yield* repository.phases(admitted.run.runId)).toEqual([]);
    }).pipe(Effect.provide(layer)),
  );
});
