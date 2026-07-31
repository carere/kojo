import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  decideWorkflowActivityReplay,
  workflowActivityIdempotencyKey,
} from "../../../../../../src/contexts/workflow-execution/runs/models/workflow-activity";

const activity = {
  activityName: "Send message",
  definitionFingerprint: "send-message-v1",
  durableOperationKey: "send-message",
};

it.effect("keeps the default external identity stable and makes per-retry work distinct", () =>
  Effect.sync(() => {
    expect(workflowActivityIdempotencyKey("run", "send-message", "stable", 1)).toBe(
      workflowActivityIdempotencyKey("run", "send-message", "stable", 2),
    );
    expect(workflowActivityIdempotencyKey("run", "send-message", "per-retry", 1)).not.toBe(
      workflowActivityIdempotencyKey("run", "send-message", "per-retry", 2),
    );
    expect(workflowActivityIdempotencyKey("parent-run", "send-message", "stable", 1)).not.toBe(
      workflowActivityIdempotencyKey("child-run", "send-message", "stable", 1),
    );
  }),
);

it.effect("rejects incompatible key reuse and retries an unobserved external completion", () =>
  Effect.sync(() => {
    const stored = {
      ...activity,
      confirmedAttemptId: null,
      executionGeneration: 1,
      resultJson: null,
    };
    expect(
      decideWorkflowActivityReplay(
        { ...activity, definitionFingerprint: "send-message-v2" },
        stored,
        { executionGeneration: 1, state: "engine-confirmed" },
      ),
    ).toEqual({ _tag: "conflict" });
    expect(
      decideWorkflowActivityReplay(activity, stored, {
        executionGeneration: 1,
        state: "started",
      }),
    ).toEqual({
      _tag: "awaiting-confirmation",
    });
    expect(
      decideWorkflowActivityReplay(activity, stored, {
        executionGeneration: 1,
        state: "result-observed",
      }),
    ).toEqual({
      _tag: "awaiting-confirmation",
    });
  }),
);

it.effect("allows a recovery generation while another replay waits for its attempt", () =>
  Effect.sync(() => {
    const stored = {
      ...activity,
      confirmedAttemptId: null,
      executionGeneration: 2,
      resultJson: null,
    };
    expect(
      decideWorkflowActivityReplay(activity, stored, {
        executionGeneration: 1,
        state: "started",
      }),
    ).toEqual({ _tag: "ready", executionGeneration: 2 });
    expect(
      decideWorkflowActivityReplay(activity, stored, { executionGeneration: 2, state: "started" }),
    ).toEqual({ _tag: "awaiting-confirmation" });
  }),
);

it.effect("reuses exactly the stored result after durable confirmation", () =>
  Effect.sync(() => {
    expect(
      decideWorkflowActivityReplay(
        activity,
        {
          ...activity,
          confirmedAttemptId: "attempt-1",
          executionGeneration: 2,
          resultJson: '{"sent":true}',
        },
        { executionGeneration: 2, state: "engine-confirmed" },
      ),
    ).toEqual({
      _tag: "completed",
      confirmedAttemptId: "attempt-1",
      executionGeneration: 2,
      resultJson: '{"sent":true}',
    });
  }),
);
