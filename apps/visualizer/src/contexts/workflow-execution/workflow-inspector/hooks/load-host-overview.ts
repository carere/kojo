const initialOverviewRetryDelaysMs = [100, 250, 500] as const;
const overviewAttemptTimeoutMs = 1_000;

export type CancellableOverviewLoader<Value> = (signal: AbortSignal) => Promise<Value | undefined>;

/**
 * A first page load can race the visualizer server's Host connection becoming ready.
 * Retry only that bounded bootstrap window; live reconnect/resync owns later updates.
 * Loaders must honor the signal so an interrupted attempt releases its transport.
 */
export const loadWithBoundedRetry = async <Value>(
  load: CancellableOverviewLoader<Value>,
): Promise<Value | undefined> => {
  for (let attempt = 0; ; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), overviewAttemptTimeoutMs);
    try {
      const value = await load(controller.signal);
      if (value !== undefined) return value;
    } catch {
      // A transient bootstrap failure is retried below. The resource remains in its
      // connecting state until the Host-authoritative overview is available.
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }

    const delayMs = initialOverviewRetryDelaysMs[attempt];
    if (delayMs === undefined) return undefined;
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  }
};
