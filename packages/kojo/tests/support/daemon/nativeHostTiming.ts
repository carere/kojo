/** One native service-state observation keeps its original fail-closed bound. */
export const NATIVE_HOST_TRANSITION_TIMEOUT_MILLIS = 60_000;

/**
 * The complete scenario includes four real Daemon starts, three health windows, and restart delay.
 * Its runner budget must cover several separately bounded transitions without changing those bounds.
 */
export const NATIVE_HOST_TEST_TIMEOUT_MILLIS = 180_000;
