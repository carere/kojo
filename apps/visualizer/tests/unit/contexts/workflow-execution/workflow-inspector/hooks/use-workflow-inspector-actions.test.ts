import { Effect } from "effect";
import { expect, it } from "vitest";
import {
  runWithCancellableRetries,
  withStableRequestKey,
} from "../../../../../../src/contexts/workflow-execution/workflow-inspector/hooks/use-workflow-inspector-actions";

const observeRetriedMutation = async (mutation: "fresh-start" | "schedule-enable") => {
  const observedKeys: Array<string> = [];
  let attempts = 0;
  const request = withStableRequestKey((key) =>
    Effect.tryPromise({
      try: async () => {
        observedKeys.push(key);
        attempts += 1;
        if (attempts < 3) throw new Error(`${mutation} transport interrupted`);
        return mutation;
      },
      catch: (cause) => cause,
    }),
  );

  await runWithCancellableRetries(request, new AbortController().signal);
  return observedKeys;
};

it("reuses one idempotency key for retried fresh-start and schedule mutations", async () => {
  const freshStartKeys = await observeRetriedMutation("fresh-start");
  const scheduleEnableKeys = await observeRetriedMutation("schedule-enable");

  expect(freshStartKeys).toHaveLength(3);
  expect(new Set(freshStartKeys).size).toBe(1);
  expect(scheduleEnableKeys).toHaveLength(3);
  expect(new Set(scheduleEnableKeys).size).toBe(1);
  expect(freshStartKeys[0]).not.toBe(scheduleEnableKeys[0]);
});
