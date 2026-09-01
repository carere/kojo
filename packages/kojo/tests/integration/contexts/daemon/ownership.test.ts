import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startDaemon } from "../../../../src/contexts/daemon/adapters/DaemonOwner.ts";
import type { DaemonPaths } from "../../../../src/contexts/daemon/models/DaemonPaths.ts";
import { LifecycleError } from "../../../../src/contexts/daemon/models/LifecycleError.ts";

const roots: Array<string> = [];

const paths = (): DaemonPaths => {
  const root = mkdtempSync(join(tmpdir(), "kojo-daemon-owner-"));
  roots.push(root);
  const installationRoot = join(root, "installation");
  return {
    installationRoot,
    dataRoot: join(root, "data"),
    configurationRoot: join(root, "config"),
    cacheRoot: join(root, "cache"),
    runtimeRoot: join(root, "runtime"),
    serviceDefinition: join(root, "LaunchAgents", "dev.kojo.test.plist"),
    managedCli: join(installationRoot, "bin", "kojo"),
    managedLauncher: join(installationRoot, "bin", "kojo-launcher"),
  };
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("one idle Daemon owns one data root", () => {
  it("holds SQLite, the singleton, the Unix socket, and endpoint publication together", async () => {
    const hostPaths = paths();
    const daemon = startDaemon(hostPaths);

    try {
      expect(() => startDaemon(hostPaths)).toThrowError(LifecycleError);
      const response = await fetch("http://localhost/ready", {
        unix: daemon.endpoint.socketPath,
      });
      expect(await response.json()).toEqual(daemon.endpoint);
      expect(lstatSync(join(hostPaths.dataRoot, "kojo.db")).mode & 0o077).toBe(0);
      expect(lstatSync(join(hostPaths.runtimeRoot, "daemon.sock")).mode & 0o077).toBe(0);
      expect(lstatSync(join(hostPaths.runtimeRoot, "endpoint.json")).mode & 0o077).toBe(0);
      expect(
        JSON.parse(readFileSync(join(hostPaths.runtimeRoot, "endpoint.json"), "utf8")),
      ).toEqual(daemon.endpoint);
    } finally {
      await daemon.stop();
    }
  });

  it("refuses a symbolic-link endpoint and leaves its target unchanged", () => {
    const hostPaths = paths();
    const target = join(hostPaths.runtimeRoot, "..", "outside");
    writeFileSync(target, "evidence");
    mkdirSync(hostPaths.runtimeRoot, { mode: 0o700 });
    symlinkSync(target, join(hostPaths.runtimeRoot, "endpoint.json"));

    expect(() => startDaemon(hostPaths)).toThrow("symbolic link");
    expect(readFileSync(target, "utf8")).toBe("evidence");
  });
});
