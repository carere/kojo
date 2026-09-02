import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import type { BrowserService } from "../../../../src/contexts/daemon/ports/BrowserService.ts";
import type { ConsoleAccessService } from "../../../../src/contexts/daemon/ports/ConsoleAccessService.ts";
import { launchConsole } from "../../../../src/contexts/daemon/services/launchConsole.ts";

const endpoint = {
  formatVersion: 1 as const,
  consoleOrigin: "http://127.0.0.1:47242",
  dataIdentity: "data-one",
  instanceId: "daemon-one",
  socketPath: "/tmp/kojo-test.sock",
  ready: true as const,
};

const access = (available = true): ConsoleAccessService => ({
  endpoint: () => (available ? endpoint : undefined),
  requestGrant: async () => ({
    expiresAt: "2026-09-02T00:01:00.000Z",
    launchUrl: `${endpoint.consoleOrigin}/daemon#grant=short-lived`,
  }),
});

describe("Console launch", () => {
  it("opens one granted URL without printing its authority", async () => {
    const opened: Array<string> = [];
    const browser: BrowserService = { open: (url) => opened.push(url) };

    expect(await Effect.runPromise(launchConsole(access(), browser, false))).toBe(
      "Opened the Console from the active Daemon.",
    );
    expect(opened).toEqual([`${endpoint.consoleOrigin}/daemon#grant=short-lived`]);
  });

  it("prints the short-lived URL only when no-open is explicit", async () => {
    const browser: BrowserService = {
      open: () => expect.unreachable("the browser must stay closed"),
    };

    expect(await Effect.runPromise(launchConsole(access(), browser, true))).toBe(
      `${endpoint.consoleOrigin}/daemon#grant=short-lived`,
    );
  });

  it("does not open an unavailable Daemon", async () => {
    await expect(
      Effect.runPromise(
        launchConsole(access(false), { open: () => expect.unreachable("nothing can open") }, false),
      ),
    ).rejects.toThrow("not ready");
  });
});
