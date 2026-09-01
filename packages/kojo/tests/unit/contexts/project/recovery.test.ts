import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { InMemoryProjectRecoveryRepository } from "../../../../src/contexts/project/adapters/InMemoryProjectRecoveryRepository.ts";
import { runnerFaultLocality } from "../../../../src/contexts/project/models/ProjectRecovery.ts";
import { ProjectRecoveryRepository } from "../../../../src/contexts/project/ports/ProjectRecoveryRepository.ts";

describe("Project Runner recovery", () => {
  it.effect(
    "exhausts one bounded cycle and lets explicit repair start exactly one new cycle",
    () => {
      const adapter = new InMemoryProjectRecoveryRepository({
        replacementDelaysMillis: [1, 2],
        healthyResetMillis: 10,
      });
      return Effect.gen(function* () {
        const repository = yield* ProjectRecoveryRepository;
        const first = yield* repository.recordFailure({
          projectId: "project-a",
          runnerInstanceId: "runner-1",
          failedAt: "2026-09-01T00:00:00.000Z",
          fault: "the Runner crashed",
          operationFailed: true,
        });
        expect(first).toMatchObject({
          cycle: 1,
          attempts: 1,
          state: "recovering",
          safety: "pending",
          nextAttemptAt: "2026-09-01T00:00:00.001Z",
        });
        yield* repository.confirmTermination("project-a", "runner-1", "2026-09-01T00:00:00.001Z");
        yield* repository.confirmSafety("project-a", "runner-1", "2026-09-01T00:00:00.001Z");
        yield* repository.recordFailure({
          projectId: "project-a",
          runnerInstanceId: "runner-2",
          failedAt: "2026-09-01T00:00:01.000Z",
          fault: "the replacement crashed",
          operationFailed: true,
        });
        const exhausted = yield* repository.recordFailure({
          projectId: "project-a",
          runnerInstanceId: "runner-3",
          failedAt: "2026-09-01T00:00:02.000Z",
          fault: "the final replacement crashed",
          operationFailed: true,
        });
        expect(exhausted).toMatchObject({ attempts: 2, state: "held", safety: "pending" });
        yield* repository.confirmTermination("project-a", "runner-3", "2026-09-01T00:00:02.001Z");
        yield* repository.confirmSafety("project-a", "runner-3", "2026-09-01T00:00:02.001Z");

        const repaired = yield* repository.repair("project-a", "2026-09-01T00:01:00.000Z");
        expect(repaired).toMatchObject({ cycle: 2, attempts: 0, state: "recovering" });
      }).pipe(Effect.provide(adapter.layer));
    },
  );

  it.effect("resets only after healthy time and a previously failed operation succeeds", () => {
    const adapter = new InMemoryProjectRecoveryRepository({ healthyResetMillis: 10 });
    return Effect.gen(function* () {
      const repository = yield* ProjectRecoveryRepository;
      yield* repository.recordFailure({
        projectId: "project-b",
        runnerInstanceId: "runner-1",
        failedAt: "2026-09-01T00:00:00.000Z",
        fault: "operation lost its reply",
        operationFailed: true,
      });
      yield* repository.confirmTermination("project-b", "runner-1", "2026-09-01T00:00:00.001Z");
      yield* repository.confirmSafety("project-b", "runner-1", "2026-09-01T00:00:00.001Z");
      yield* repository.observeHealthy("project-b", "2026-09-01T00:00:00.002Z", false);
      const heartbeatOnly = yield* repository.observeHealthy(
        "project-b",
        "2026-09-01T00:00:00.020Z",
        false,
      );
      expect(heartbeatOnly).toMatchObject({ attempts: 1, failedOperationPending: true });
      const operationSucceeded = yield* repository.observeHealthy(
        "project-b",
        "2026-09-01T00:00:00.021Z",
        true,
      );
      expect(operationSucceeded).toMatchObject({
        attempts: 0,
        state: "healthy",
        failedOperationPending: false,
      });
    }).pipe(Effect.provide(adapter.layer));
  });

  it("retires unsafe connections but keeps stale authority local to its request", () => {
    expect(runnerFaultLocality("malformed-frame")).toBe("connection");
    expect(runnerFaultLocality("oversized-frame")).toBe("connection");
    expect(runnerFaultLocality("wrong-scope")).toBe("connection");
    expect(runnerFaultLocality("stale-authority")).toBe("request");
  });

  it.effect("does not let repair convert uncertain termination into safe evidence", () => {
    const adapter = new InMemoryProjectRecoveryRepository();
    return Effect.gen(function* () {
      const repository = yield* ProjectRecoveryRepository;
      yield* repository.recordFailure({
        projectId: "project-c",
        runnerInstanceId: "runner-uncertain",
        failedAt: "2026-09-01T00:00:00.000Z",
        fault: "the process group could not be inspected",
        operationFailed: true,
      });
      yield* repository.holdUncertain("project-c", "runner-uncertain", "termination is uncertain");
      const repaired = yield* repository.repair("project-c", "2026-09-01T00:01:00.000Z");
      expect(repaired).toMatchObject({ cycle: 1, state: "held", safety: "uncertain" });
    }).pipe(Effect.provide(adapter.layer));
  });
});
