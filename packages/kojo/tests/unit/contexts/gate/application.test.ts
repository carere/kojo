import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  layer,
  makeState,
} from "../../../../src/contexts/gate/adapters/InMemoryDaemonGateRepository.ts";
import { DaemonGateRepository } from "../../../../src/contexts/gate/ports/DaemonGateRepository.ts";

const authority = {
  runId: "run-apply",
  runnerInstanceId: "runner-current",
  generation: 4,
  revisionId: "b".repeat(64),
};

const asking = {
  identity: {
    identityVersion: 1 as const,
    runId: authority.runId,
    gatePath: "ship",
    askingNumber: 2,
    escalationStage: 1,
  },
  token: "opaque-token-apply",
  projectId: "project-1",
  workflowName: "release",
  description: "Escalated release choice",
  actor: "release-lead",
  choices: ["approve", "reject"],
  deadline: "2026-09-02T00:00:00.000Z",
  expiryBranch: "escalate" as const,
  internalDeferredName: "gate/ship/2/escalated",
  createdAt: "2026-09-01T20:00:00.000Z",
};

describe("Gate application", () => {
  it.effect(
    "keeps Recorded distinct, fences Applied, and makes repeated application idempotent",
    () => {
      const state = makeState();
      return Effect.gen(function* () {
        const repository = yield* DaemonGateRepository;
        yield* repository.createAskingAndSuspend(authority, asking);
        const receipt = yield* repository.recordVerdictAndSchedule({
          dataIdentity: "data-1",
          requestId: "answer-apply",
          canonicalRequest: "answer-apply-content",
          token: asking.token,
          choice: "approve",
          reason: "approved after escalation",
          answerer: "operator",
          now: "2026-09-01T20:01:00.000Z",
        });
        expect(receipt.asking.state).toBe("recorded");
        const application = (yield* repository.deferredApplications(authority.runId))[0];
        expect(application).toBeDefined();

        const stale = yield* Effect.flip(
          repository.markApplied(
            { ...authority, generation: authority.generation - 1 },
            application?.wakeupId ?? "missing",
            "2026-09-01T20:02:00.000Z",
          ),
        );
        expect(stale.code).toBe("STALE_AUTHORITY");

        const applied = yield* repository.markApplied(
          authority,
          application?.wakeupId ?? "missing",
          "2026-09-01T20:02:00.000Z",
        );
        expect(applied.state).toBe("applied");
        expect(applied.appliedAt).toBe("2026-09-01T20:02:00.000Z");
        expect(yield* repository.deferredApplications(authority.runId)).toHaveLength(0);

        const repeated = yield* repository.markApplied(
          authority,
          application?.wakeupId ?? "missing",
          "2026-09-01T20:03:00.000Z",
        );
        expect(repeated.appliedAt).toBe("2026-09-01T20:02:00.000Z");
        expect(
          (yield* repository.list).filter((item) => item.identity.runId === authority.runId),
        ).toHaveLength(1);
      }).pipe(Effect.provide(layer(state)));
    },
  );
});
