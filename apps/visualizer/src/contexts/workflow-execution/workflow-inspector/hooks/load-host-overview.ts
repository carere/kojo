const initialOverviewRetryDelaysMs = [100, 250, 500] as const;
const overviewAttemptTimeoutMs = 5_000;
const overviewDeadlineMs = 15_000;
const overviewMaxAttempts = 2;

export type CancellableOverviewLoader<Value> = (signal: AbortSignal) => Promise<Value | undefined>;

export interface LoadWithBoundedRetryOptions {
  readonly signal?: AbortSignal;
  readonly attemptTimeoutMs?: number;
  readonly maxAttempts?: number;
  readonly maxElapsedMs?: number;
  readonly retryDelaysMs?: ReadonlyArray<number>;
}

export class HostOverviewLoadTimeoutError extends Error {
  readonly name = "HostOverviewLoadTimeoutError";

  constructor(
    readonly maxElapsedMs: number,
    readonly cause?: unknown,
  ) {
    super(`Kojo Host overview was not available within ${maxElapsedMs}ms.`);
  }
}

const isHostOverviewError = (error: unknown) => {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { readonly _tag?: unknown; readonly code?: unknown };
  return candidate._tag === "HostOverviewError" && typeof candidate.code === "string";
};

const isIncompatibleProtocolError = (error: unknown) =>
  isHostOverviewError(error) &&
  (error as { readonly code?: unknown }).code === "incompatible-protocol";

const waitForRetry = (delayMs: number, signal: AbortSignal | undefined) =>
  new Promise<boolean>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (continueRetrying: boolean) => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(continueRetrying);
    };
    const onAbort = () => finish(false);
    if (signal?.aborted) {
      finish(false);
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => finish(true), delayMs);
  });

/**
 * A first page load can race the visualizer server's Host connection becoming ready.
 * Retry only inside one finite deadline. The local Host client has its own bounded
 * transport retry, so this policy is deliberately finite and is never used as a
 * long-lived reconnect loop. Loaders must honor each attempt signal so an interrupted
 * request releases its transport; incompatible protocol errors remain fatal and reach
 * the UI.
 */
export const loadWithBoundedRetry = async <Value>(
  load: CancellableOverviewLoader<Value>,
  options: LoadWithBoundedRetryOptions = {},
): Promise<Value | undefined> => {
  const timeoutMs = options.attemptTimeoutMs ?? overviewAttemptTimeoutMs;
  const maxAttempts = options.maxAttempts ?? overviewMaxAttempts;
  const maxElapsedMs = options.maxElapsedMs ?? overviewDeadlineMs;
  const retryDelaysMs = options.retryDelaysMs ?? initialOverviewRetryDelaysMs;
  const deadline = Date.now() + maxElapsedMs;
  let attempt = 0;
  let lastError: unknown;
  let lastHostOverviewError: unknown;
  while (!options.signal?.aborted && attempt < maxAttempts && Date.now() < deadline) {
    const controller = new AbortController();
    const abortAttempt = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) return undefined;
    options.signal?.addEventListener("abort", abortAttempt, { once: true });
    const timeout = setTimeout(
      () => controller.abort(),
      Math.max(1, Math.min(timeoutMs, deadline - Date.now())),
    );
    try {
      const value = await load(controller.signal);
      if (value !== undefined) return value;
    } catch (error) {
      lastError = error;
      if (isHostOverviewError(error)) lastHostOverviewError = error;
      if (isIncompatibleProtocolError(error)) throw error;
      if (options.signal?.aborted) return undefined;
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abortAttempt);
      controller.abort();
    }

    attempt += 1;
    if (attempt >= maxAttempts || Date.now() >= deadline) break;
    const delayMs = retryDelaysMs[Math.min(attempt - 1, retryDelaysMs.length - 1)] ?? 0;
    if (
      !(await waitForRetry(Math.min(delayMs, Math.max(0, deadline - Date.now())), options.signal))
    )
      return undefined;
  }
  if (options.signal?.aborted) return undefined;
  if (lastHostOverviewError !== undefined) throw lastHostOverviewError;
  throw new HostOverviewLoadTimeoutError(maxElapsedMs, lastError);
};
