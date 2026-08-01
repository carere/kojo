import { expect, it } from "vitest";
import { withStableRequestKey } from "../../../../../../src/contexts/workflow-execution/workflow-inspector/hooks/use-workflow-inspector-actions";

const retry = async <Value>(operation: () => Promise<Value>) => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= 2) throw error;
    }
  }
};

const observeRetriedMutation = async (mutation: "fresh-start" | "schedule-enable") => {
  const observedKeys: Array<string> = [];
  let attempts = 0;
  const request = withStableRequestKey((key) => async () => {
    observedKeys.push(key);
    attempts += 1;
    if (attempts < 3) throw new Error(`${mutation} transport interrupted`);
    return mutation;
  });

  await retry(request);
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
