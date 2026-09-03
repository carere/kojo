import { describe, expect, it, vi } from "vitest";
import {
  managedLauncherReadinessTimeoutMillis,
  observeManagedLauncherReadiness,
  waitForManagedLauncherExit,
} from "../../support/daemon/managedLauncherReadiness.ts";

describe("managed launcher readiness observation", () => {
  it("cancels forced cleanup when the managed launcher exits within the bound", async () => {
    let canceled = false;
    let expire: (() => Promise<void>) | undefined;
    const onTimeout = vi.fn(async () => undefined);

    expect(
      await waitForManagedLauncherExit({
        exited: Promise.resolve(),
        timeoutMillis: 5_000,
        onTimeout,
        startDeadline: (callback) => {
          expire = async () => {
            if (!canceled) await callback();
          };
          return { cancel: () => (canceled = true) };
        },
      }),
    ).toBe(true);
    await expire?.();

    expect(canceled).toBe(true);
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("completes forced cleanup before it reports an expired launcher exit bound", async () => {
    let expire: (() => Promise<void>) | undefined;
    let resolveExit: (() => void) | undefined;
    const events: Array<string> = [];
    const result = waitForManagedLauncherExit({
      exited: new Promise<void>((resolve) => (resolveExit = resolve)),
      timeoutMillis: 5_000,
      onTimeout: async () => {
        events.push("cleanup-started");
        resolveExit?.();
        await Promise.resolve();
        events.push("cleanup-completed");
      },
      startDeadline: (callback) => {
        expire = callback;
        return { cancel: () => events.push("deadline-canceled") };
      },
    });

    await expire?.();

    expect(await result).toBe(false);
    expect(events).toEqual(["cleanup-started", "cleanup-completed", "deadline-canceled"]);
  });

  it("allows the endpoint timing observed under concurrent suite load", async () => {
    let time = 0;

    const result = await observeManagedLauncherReadiness({
      endpointPresent: () => time >= 11_400,
      exitCode: () => null,
      now: () => time,
      sleep: async (milliseconds) => {
        time += milliseconds;
      },
    });

    expect(result).toEqual({ state: "ready" });
  });

  it("reports launcher exit before endpoint readiness", async () => {
    let time = 0;

    const result = await observeManagedLauncherReadiness({
      endpointPresent: () => false,
      exitCode: () => (time >= 5_000 ? 70 : null),
      now: () => time,
      sleep: async (milliseconds) => {
        time += milliseconds;
      },
    });

    expect(result).toEqual({ state: "exited", exitCode: 70 });
  });

  it("reports a live launcher separately when the endpoint bound expires", async () => {
    let time = 0;

    const result = await observeManagedLauncherReadiness({
      endpointPresent: () => false,
      exitCode: () => null,
      now: () => time,
      sleep: async (milliseconds) => {
        time += milliseconds;
      },
    });

    expect(result).toEqual({
      state: "timed-out",
      process: "running",
      timeoutMillis: managedLauncherReadinessTimeoutMillis,
    });
  });

  it("does not accept an endpoint from an exited launcher", async () => {
    expect(
      await observeManagedLauncherReadiness({
        endpointPresent: () => true,
        exitCode: () => 71,
      }),
    ).toEqual({ state: "exited", exitCode: 71 });
  });
});
