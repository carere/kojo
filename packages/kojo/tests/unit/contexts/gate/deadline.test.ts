import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  layer,
  makeState,
} from "../../../../src/contexts/gate/adapters/InMemoryDaemonGateRepository.ts";
import { DaemonGateRepository } from "../../../../src/contexts/gate/ports/DaemonGateRepository.ts";

const deadline = "2026-09-01T12:00:00.000Z";
const authority = {
  runId: "run-1",
  runnerInstanceId: "runner-1",
  generation: 1,
  revisionId: "a".repeat(64),
};

const create = {
  identity: {
    identityVersion: 1 as const,
    runId: authority.runId,
    gatePath: "release/ship",
    askingNumber: 1,
    escalationStage: 0,
  },
  token: "opaque-token-1",
  projectId: "project-1",
  workflowName: "release",
  description: "Ship this revision?",
  actor: "release-engineer",
  choices: ["approve", "reject"],
  deadline,
  expiryBranch: "fail" as const,
  internalDeferredName: "gate/release/ship/1",
  createdAt: "2026-09-01T11:00:00.000Z",
};

const answer = (now: string) => ({
  dataIdentity: "data-1",
  requestId: "answer-1",
  canonicalRequest: "answer-1-content",
  token: create.token,
  choice: "approve",
  reason: "all checks passed",
  answerer: "operator",
  now,
});

describe("Gate Deadline precedence", () => {
  it.effect("before the Deadline: records the Verdict and keeps it valid", () => {
    const state = makeState();
    return Effect.gen(function* () {
      const repository = yield* DaemonGateRepository;
      yield* repository.createAskingAndSuspend(authority, create);
      const recorded = yield* repository.recordVerdictAndSchedule(
        answer("2026-09-01T11:59:59.999Z"),
      );
      expect(recorded.asking.state).toBe("recorded");
      expect(recorded.asking.verdict?.recordedAt).toBe("2026-09-01T11:59:59.999Z");

      const after = yield* repository.expireAndSchedule(create.token, "2026-09-01T12:05:00.000Z");
      expect(after.state).toBe("recorded");
      expect((yield* repository.deferredApplications(authority.runId))[0]?.kind).toBe("verdict");
    }).pipe(Effect.provide(layer(state)));
  });

  for (const [name, now] of [
    ["exactly at", "2026-09-01T12:00:00.000Z"],
    ["after", "2026-09-01T12:00:00.001Z"],
  ] as const) {
    it.effect(`refuses ${name} the Deadline and schedules the declared expiry`, () => {
      const state = makeState();
      return Effect.gen(function* () {
        const repository = yield* DaemonGateRepository;
        yield* repository.createAskingAndSuspend(authority, create);
        const refusal = yield* Effect.flip(repository.recordVerdictAndSchedule(answer(now)));
        expect(refusal.code).toBe("DEADLINE_PASSED");
        const asking = yield* repository.byToken(create.token);
        expect(asking?.state).toBe("expired");
        expect(asking?.verdict).toBeUndefined();
        expect((yield* repository.deferredApplications(authority.runId))[0]).toMatchObject({
          kind: "expiry",
          deferredName: "DurableClock/gate/release/ship/1/deadline",
        });
      }).pipe(Effect.provide(layer(state)));
    });
  }
});
