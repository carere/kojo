export const TRIGGER_RETRY_DELAYS_MILLIS = [1_000, 2_000, 4_000, 8_000, 16_000] as const;

export const triggerRetryDelay = (failureCount: number): number | undefined =>
  failureCount < 1 ? undefined : TRIGGER_RETRY_DELAYS_MILLIS[failureCount - 1];
