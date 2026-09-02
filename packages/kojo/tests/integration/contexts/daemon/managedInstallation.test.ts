import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { removeManagedInstallation } from "../../../../src/contexts/daemon/adapters/ManagedInstallation.ts";
import type { DaemonPaths } from "../../../../src/contexts/daemon/models/DaemonPaths.ts";
import type {
  NativeService,
  NativeServiceObservation,
} from "../../../../src/contexts/daemon/ports/NativeService.ts";
import { manageDaemon } from "../../../../src/contexts/daemon/services/manageDaemon.ts";
import { observeManagedLauncherReadiness } from "../../../support/daemon/managedLauncherReadiness.ts";

const roots: Array<string> = [];

const waitFor = async (predicate: () => boolean, timeout = 10_000): Promise<void> => {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("the managed Daemon did not become ready");
    await Bun.sleep(25);
  }
};

const removeTree = (path: string): void => {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    rmSync(path, { force: true });
    return;
  }
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
      installAndStart: () => {
        const data = lstatSync(paths.dataRoot);
        const configuration = lstatSync(paths.configurationRoot);
        expect(data.isDirectory()).toBe(true);
        expect(configuration.isDirectory()).toBe(true);
        expect(data.mode & 0o777).toBe(0o700);
        expect(configuration.mode & 0o777).toBe(0o700);
        expect([data.dev, data.ino]).not.toEqual([configuration.dev, configuration.ino]);
        calls.push("install-and-start");
      },
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

    const first = await Effect.runPromise(lifecycle.install);
    observation = {
      automaticStart: "disabled",
      manager: "unloaded",
      process: "stopped",
      loginLifetime: "test login lifetime",
      logoutPersistence: "disabled",
    };
    const second = await Effect.runPromise(lifecycle.install);
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

    const launcher = Bun.spawn([paths.managedLauncher], {
      env: {
        ...process.env,
        HOME: root,
        KOJO_MANAGED_INSTALLATION: paths.installationRoot,
        KOJO_DAEMON_DATA: paths.dataRoot,
        KOJO_DAEMON_RUNTIME: paths.runtimeRoot,
        KOJO_DAEMON_CONFIG: paths.configurationRoot,
        KOJO_DAEMON_CACHE: paths.cacheRoot,
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      detached: true,
    });
    const output = new Response(launcher.stdout).text();
    const error = new Response(launcher.stderr).text();
    const endpointPath = join(paths.runtimeRoot, "endpoint.json");
    let readinessFailure: { readonly cause: unknown } | undefined;
    try {
      const readiness = await observeManagedLauncherReadiness({
        endpointPresent: () => existsSync(endpointPath),
        exitCode: () => launcher.exitCode,
      });
      if (readiness.state === "exited") {
        throw new Error(
          `the installed managed launcher exited ${readiness.exitCode} before it published ${endpointPath}: ${await error}${await output}`,
        );
      }
      if (readiness.state === "timed-out") {
        throw new Error(
          `the installed managed launcher did not publish ${endpointPath} within ${readiness.timeoutMillis}ms; launcher process is still ${readiness.process} at pid ${launcher.pid}`,
        );
      }
    } catch (cause) {
      readinessFailure = { cause };
    }
    let signalFailure: { readonly cause: unknown } | undefined;
    try {
      process.kill(-launcher.pid, "SIGTERM");
    } catch (cause) {
      if (launcher.exitCode === null) signalFailure = { cause };
    }
    await Promise.race([
      launcher.exited,
      Bun.sleep(5_000).then(async () => {
        try {
          process.kill(-launcher.pid, "SIGKILL");
        } catch {
          // The managed process group completed its planned stop before the forced bound.
        }
        await launcher.exited;
      }),
    ]);
    if (readinessFailure !== undefined) throw readinessFailure.cause;
    if (signalFailure !== undefined) throw signalFailure.cause;
    await waitFor(() => !existsSync(endpointPath));
  }, 60_000);

  it.each([
    ["systemd compatibility", "configuration"],
    ["arbitrary", "outside"],
  ] as const)(
    "refuses the %s state link before native service start",
    async (_name, targetName) => {
      const root = mkdtempSync(join(tmpdir(), "kojo-linked-state-install-"));
      roots.push(root);
      const installationRoot = join(root, "installation");
      const paths: DaemonPaths = {
        installationRoot,
        dataRoot: join(root, "state", "kojo"),
        configurationRoot: join(root, "config", "kojo"),
        cacheRoot: join(root, "cache", "kojo"),
        runtimeRoot: join(root, "runtime", "kojo"),
        serviceDefinition: join(root, "service", "kojo.service"),
        managedCli: join(installationRoot, "bin", "kojo"),
        managedLauncher: join(installationRoot, "bin", "kojo-launcher"),
      };
      const target =
        targetName === "configuration" ? paths.configurationRoot : join(root, "outside");
      mkdirSync(target, { mode: 0o700, recursive: true });
      mkdirSync(join(paths.dataRoot, ".."), { mode: 0o700, recursive: true });
      symlinkSync(target, paths.dataRoot);
      let serviceStarted = false;
      const native: NativeService = {
        serviceDocument: () => "test service definition\n",
        assertSupported: () => undefined,
        inspect: () => ({
          automaticStart: "disabled",
          manager: "unloaded",
          process: "stopped",
          loginLifetime: "test login lifetime",
          logoutPersistence: "disabled",
        }),
        installAndStart: () => {
          serviceStarted = true;
        },
        start: () => undefined,
        stop: () => undefined,
        enable: () => undefined,
        disable: () => undefined,
        keepRunningAfterLogout: () => undefined,
      };
      const sourceRoot = new URL("../../../../", import.meta.url).pathname;

      await expect(
        Effect.runPromise(
          manageDaemon(paths, native, { sourceRoot, bunExecutable: process.execPath }).install,
        ),
      ).rejects.toThrow("symbolic link");
      expect(serviceStarted).toBe(false);
      expect(lstatSync(paths.dataRoot).isSymbolicLink()).toBe(true);
    },
  );

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

    await expect(Effect.runPromise(manageDaemon(paths, native).install)).rejects.toThrow(
      "unsupported Host",
    );
    expect(existsSync(installationRoot)).toBe(false);
  });

  it("removes only managed installation nodes and preserves Daemon data and configuration", () => {
    const root = mkdtempSync(join(tmpdir(), "kojo-managed-remove-"));
    roots.push(root);
    chmodSync(root, 0o700);
    const installationRoot = join(root, "installation");
    const paths: DaemonPaths = {
      installationRoot,
      dataRoot: join(installationRoot, "data"),
      configurationRoot: join(installationRoot, "config"),
      cacheRoot: join(root, "cache"),
      runtimeRoot: join(root, "runtime"),
      serviceDefinition: join(root, "LaunchAgents", "dev.kojo.test.plist"),
      managedCli: join(installationRoot, "bin", "kojo"),
      managedLauncher: join(installationRoot, "bin", "kojo-launcher"),
    };
    for (const directory of [
      join(installationRoot, "bin"),
      join(installationRoot, "releases", "release-1"),
      paths.dataRoot,
      paths.configurationRoot,
      paths.cacheRoot,
    ]) {
      mkdirSync(directory, { mode: 0o700, recursive: true });
      chmodSync(directory, 0o700);
    }
    for (const [path, content, mode] of [
      [paths.managedCli, "cli\n", 0o700],
      [paths.managedLauncher, "launcher\n", 0o700],
      [join(installationRoot, "active-release"), "release-1\n", 0o600],
      [join(installationRoot, "releases", "release-1", "release.json"), "{}\n", 0o600],
      [join(paths.dataRoot, "kojo.db"), "correctness\n", 0o600],
      [join(paths.configurationRoot, "credential"), "secret\n", 0o600],
      [join(paths.cacheRoot, "observation"), "cache\n", 0o600],
    ] as const) {
      writeFileSync(path, content, { mode });
    }

    removeManagedInstallation(paths);

    expect(existsSync(paths.managedCli)).toBe(false);
    expect(existsSync(paths.managedLauncher)).toBe(false);
    expect(existsSync(join(installationRoot, "active-release"))).toBe(false);
    expect(existsSync(join(installationRoot, "releases"))).toBe(false);
    expect(readFileSync(join(paths.dataRoot, "kojo.db"), "utf8")).toBe("correctness\n");
    expect(readFileSync(join(paths.configurationRoot, "credential"), "utf8")).toBe("secret\n");
    expect(readFileSync(join(paths.cacheRoot, "observation"), "utf8")).toBe("cache\n");
  });
});
