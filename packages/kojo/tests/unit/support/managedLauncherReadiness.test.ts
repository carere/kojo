import { describe, expect, it } from "vitest";
import {
  managedLauncherReadinessTimeoutMillis,
  observeManagedLauncherReadiness,
} from "../../support/daemon/managedLauncherReadiness.ts";

describe("managed launcher readiness observation", () => {
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
