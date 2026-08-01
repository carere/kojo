import { expect, it } from "vitest";
import { HostOverviewError } from "../../../../../../src/contexts/shared/models/contracts";
import {
  HostOverviewLoadTimeoutError,
  loadWithBoundedRetry,
} from "../../../../../../src/contexts/workflow-execution/workflow-inspector/hooks/load-host-overview";

it("continues bounded-backoff bootstrap until a temporarily unavailable Host recovers", async () => {
  let attempts = 0;

  const overview = await loadWithBoundedRetry(
    async () => {
      attempts += 1;
      return attempts > 4 ? { recovered: true } : undefined;
    },
    { attemptTimeoutMs: 100, maxAttempts: 5, maxElapsedMs: 1_000, retryDelaysMs: [0] },
  );

  expect(overview).toEqual({ recovered: true });
  expect(attempts).toBe(5);
});

it("preserves an incompatible Host protocol failure for an explicit error state", async () => {
  const failure = new HostOverviewError({
    code: "incompatible-protocol",
    message: "Protocol major mismatch.",
    next: "Upgrade Kojo Host.",
  });

  await expect(
    loadWithBoundedRetry(async () => {
      throw failure;
    }),
  ).rejects.toBe(failure);
});

it("interrupts a stalled attempt before retrying the Host request", async () => {
  let attempts = 0;
  let abortedAttempts = 0;

  const overview = await loadWithBoundedRetry(
    (signal) => {
      attempts += 1;
      if (attempts > 1) return Promise.resolve({ recovered: true });
      return new Promise<undefined>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            abortedAttempts += 1;
            reject(new Error("HostOverview attempt interrupted."));
          },
          { once: true },
        );
      });
    },
    { attemptTimeoutMs: 5, retryDelaysMs: [0] },
  );

  expect(overview).toEqual({ recovered: true });
  expect(attempts).toBe(2);
  expect(abortedAttempts).toBe(1);
});

it("exhausts a finite overview policy instead of retrying until component cleanup", async () => {
  let attempts = 0;

  await expect(
    loadWithBoundedRetry(
      async () => {
        attempts += 1;
        return undefined;
      },
      { attemptTimeoutMs: 100, maxAttempts: 2, maxElapsedMs: 200, retryDelaysMs: [0] },
    ),
  ).rejects.toBeInstanceOf(HostOverviewLoadTimeoutError);

  expect(attempts).toBe(2);
});

it("keeps the last real HostOverview error when a later attempt stalls", async () => {
  const failure = new HostOverviewError({
    code: "host-unavailable",
    message: "Kojo Host is still starting.",
    next: "Retry the Host request.",
  });
  let attempts = 0;

  await expect(
    loadWithBoundedRetry(
      (signal) => {
        attempts += 1;
        if (attempts === 1) return Promise.reject(failure);
        return new Promise<undefined>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("stalled attempt")), {
            once: true,
          });
        });
      },
      { attemptTimeoutMs: 5, maxAttempts: 2, maxElapsedMs: 100, retryDelaysMs: [0] },
    ),
  ).rejects.toBe(failure);
  expect(attempts).toBe(2);
});
