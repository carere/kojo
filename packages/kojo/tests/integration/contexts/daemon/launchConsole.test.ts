import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  type RunningDaemon,
  startDaemon,
} from "../../../../src/contexts/daemon/adapters/DaemonOwner.ts";
import type { DaemonPaths } from "../../../../src/contexts/daemon/models/DaemonPaths.ts";
import type { BrowserService } from "../../../../src/contexts/daemon/ports/BrowserService.ts";
import { launchConsole } from "../../../../src/contexts/daemon/services/launchConsole.ts";
import { publishConsoleRelease } from "../../../support/daemon/consoleRelease.ts";

const roots: Array<string> = [];
const daemons: Array<RunningDaemon> = [];

const paths = (): DaemonPaths => {
  const root = mkdtempSync(join(tmpdir(), "kojo-console-launch-"));
  roots.push(root);
  const installationRoot = join(root, "installation");
  const value = {
    installationRoot,
    dataRoot: join(root, "data"),
    configurationRoot: join(root, "config"),
    cacheRoot: join(root, "cache"),
    runtimeRoot: join(root, "runtime"),
    serviceDefinition: join(root, "LaunchAgents", "dev.kojo.test.plist"),
    managedCli: join(installationRoot, "bin", "kojo"),
    managedLauncher: join(installationRoot, "bin", "kojo-launcher"),
  };
  publishConsoleRelease(value);
  return value;
};

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await Effect.runPromise(daemon.stop);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Console launch through the private Daemon socket", () => {
  it("opens one active-release URL without printing its authority", async () => {
    const hostPaths = paths();
    const daemon = startDaemon(hostPaths);
    daemons.push(daemon);
    const opened: Array<string> = [];
    const browser: BrowserService = { open: (url) => opened.push(url) };

    expect(await Effect.runPromise(launchConsole(hostPaths, browser, false))).toBe(
      "Opened the Console from the active Daemon.",
    );
    expect(opened).toHaveLength(1);
    const target = new URL(opened[0] ?? "");
    expect(target.origin).toBe(daemon.endpoint.consoleOrigin);
    expect(target.pathname).toBe("/daemon");
    expect(new URLSearchParams(target.hash.slice(1)).has("grant")).toBe(true);
  });

  it("prints the short-lived URL only when no-open is explicit", async () => {
    const hostPaths = paths();
    const daemon = startDaemon(hostPaths);
    daemons.push(daemon);
    const browser: BrowserService = {
      open: () => expect.unreachable("the browser must stay closed"),
    };

    const line = await Effect.runPromise(launchConsole(hostPaths, browser, true));
    const target = new URL(line);
    expect(target.origin).toBe(daemon.endpoint.consoleOrigin);
    expect(new URLSearchParams(target.hash.slice(1)).has("grant")).toBe(true);
  });

  it("does not start an unavailable Daemon", async () => {
    const hostPaths = paths();
    await expect(
      Effect.runPromise(
        launchConsole(hostPaths, { open: () => expect.unreachable("nothing can open") }, false),
      ),
    ).rejects.toThrow("not ready");
    expect(existsSync(hostPaths.dataRoot)).toBe(false);
    expect(existsSync(hostPaths.runtimeRoot)).toBe(false);
  });
});
