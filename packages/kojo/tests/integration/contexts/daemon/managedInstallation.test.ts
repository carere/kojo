import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import type { DaemonPaths } from "../../../../src/contexts/daemon/models/DaemonPaths.ts";
import type {
  NativeService,
  NativeServiceObservation,
} from "../../../../src/contexts/daemon/ports/NativeService.ts";
import { manageDaemon } from "../../../../src/contexts/daemon/services/manageDaemon.ts";

const roots: Array<string> = [];

const removeTree = (path: string): void => {
  const stat = lstatSync(path);
  if (stat.isDirectory()) {
    chmodSync(path, 0o700);
    for (const child of readdirSync(path)) removeTree(join(path, child));
  } else {
    chmodSync(path, 0o600);
  }
  rmSync(path, { recursive: true, force: true });
};

afterEach(() => {
  for (const root of roots.splice(0)) removeTree(root);
});

describe("the managed Daemon installation", () => {
  it("retains Kojo, Bun, Console, a stable CLI, and a stable launcher without reinstall side effects", async () => {
    const root = mkdtempSync(join(tmpdir(), "kojo-managed-install-"));
    roots.push(root);
    const installationRoot = join(root, "installation");
    const paths: DaemonPaths = {
      installationRoot,
      dataRoot: join(root, "data"),
      configurationRoot: join(root, "config"),
      cacheRoot: join(root, "cache"),
      runtimeRoot: join(root, "runtime"),
      serviceDefinition: join(root, "LaunchAgents", "dev.kojo.test.plist"),
      managedCli: join(installationRoot, "bin", "kojo"),
      managedLauncher: join(installationRoot, "bin", "kojo-launcher"),
    };
    const calls: Array<string> = [];
    let observation: NativeServiceObservation = {
      automaticStart: "enabled",
      manager: "loaded",
      process: "running",
      loginLifetime: "test login lifetime",
      logoutPersistence: "disabled",
    };
    const native: NativeService = {
      serviceDocument: () => "test service definition\n",
      assertSupported: () => {},
      inspect: () => observation,
      installAndStart: () => calls.push("install-and-start"),
      start: () => calls.push("start"),
      stop: () => calls.push("stop"),
      enable: () => calls.push("enable"),
      disable: () => calls.push("disable"),
      keepRunningAfterLogout: () => calls.push("linger"),
    };
    const sourceRoot = new URL("../../../../", import.meta.url).pathname;
    const lifecycle = manageDaemon(paths, native, {
      sourceRoot,
      bunExecutable: process.execPath,
    });

    const first = await lifecycle.install();
    observation = {
      automaticStart: "disabled",
      manager: "unloaded",
      process: "stopped",
      loginLifetime: "test login lifetime",
      logoutPersistence: "disabled",
    };
    const second = await lifecycle.install();
    await Effect.runPromise(lifecycle.keepRunningAfterLogout);

    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(second.status).toMatchObject({
      automaticStart: "disabled",
      manager: "unloaded",
      process: "stopped",
    });
    expect(calls).toEqual(["install-and-start", "linger"]);
    expect(readFileSync(paths.managedCli, "utf8")).toContain("active-release");
    expect(readFileSync(paths.managedLauncher, "utf8")).toContain("launcher.js");
    const releaseId = readFileSync(join(installationRoot, "active-release"), "utf8").trim();
    const release = join(installationRoot, "releases", releaseId);
    expect(lstatSync(release).mode & 0o222).toBe(0);
    expect(lstatSync(join(release, "runtime", "bun")).mode & 0o222).toBe(0);
    expect(readFileSync(join(release, "console", "index.html"), "utf8")).toContain("<html");
    for (const privateDirectory of [
      paths.installationRoot,
      paths.dataRoot,
      paths.configurationRoot,
      paths.cacheRoot,
      paths.runtimeRoot,
    ]) {
      expect(lstatSync(privateDirectory).mode & 0o077).toBe(0);
    }
    expect(lstatSync(paths.serviceDefinition).mode & 0o077).toBe(0);

    const command = Bun.spawnSync([paths.managedCli, "--version"], {
      env: { ...process.env, HOME: root },
    });
    expect(command.exitCode).toBe(0);
    expect(command.stdout.toString().trim()).not.toBe("");
  }, 60_000);

  it("refuses an unsupported Host before it writes managed content", async () => {
    const root = mkdtempSync(join(tmpdir(), "kojo-unsupported-install-"));
    roots.push(root);
    const installationRoot = join(root, "installation");
    const paths: DaemonPaths = {
      installationRoot,
      dataRoot: join(root, "data"),
      configurationRoot: join(root, "config"),
      cacheRoot: join(root, "cache"),
      runtimeRoot: join(root, "runtime"),
      serviceDefinition: join(root, "service", "kojo.service"),
      managedCli: join(installationRoot, "bin", "kojo"),
      managedLauncher: join(installationRoot, "bin", "kojo-launcher"),
    };
    const native: NativeService = {
      serviceDocument: () => "must not be written",
      assertSupported: () => {
        throw new Error("unsupported Host");
      },
      inspect: () => ({
        automaticStart: "unknown",
        manager: "unavailable",
        process: "unknown",
        loginLifetime: "unsupported",
        logoutPersistence: "unknown",
      }),
      installAndStart: () => {},
      start: () => {},
      stop: () => {},
      enable: () => {},
      disable: () => {},
      keepRunningAfterLogout: () => {},
    };

    await expect(manageDaemon(paths, native).install()).rejects.toThrow("unsupported Host");
    expect(existsSync(installationRoot)).toBe(false);
  });
});
