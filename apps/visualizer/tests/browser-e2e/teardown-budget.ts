export interface TeardownBudget {
  readonly run: <Value>(
    label: string,
    operation: () => Promise<Value>,
    limitMs?: number,
  ) => Promise<Value>;
  readonly remainingMs: () => number;
  readonly sleep: (label: string, delayMs: number) => Promise<void>;
}

export const makeTeardownBudget = (budgetMs = 15_000): TeardownBudget => {
  const deadline = Date.now() + budgetMs;
  const remainingMs = () => Math.max(0, deadline - Date.now());
  const run = async <Value>(label: string, operation: () => Promise<Value>, limitMs?: number) => {
    const remaining = Math.min(remainingMs(), limitMs ?? Number.POSITIVE_INFINITY);
    if (remaining <= 0) throw new Error(`${label} exceeded the shared teardown deadline.`);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error(`${label} exceeded the shared teardown deadline.`)),
            remaining,
          );
        }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  };
  return {
    run,
    remainingMs,
    sleep: async (label, delayMs) => {
      const delay = Math.min(delayMs, remainingMs());
      if (delay <= 0) throw new Error(`${label} exceeded the shared teardown deadline.`);
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    },
  };
};
