import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { systemdUserService } from "../../../src/contexts/daemon/adapters/SystemdUserService.ts";
import type { DaemonPaths } from "../../../src/contexts/daemon/models/DaemonPaths.ts";
import { systemdUnitDocument } from "../../../src/contexts/daemon/services/systemdUnitDocument.ts";
import { writeNativeManagedRelease } from "./nativeManagedRelease.ts";

const identity = "kojo-native-logout-evidence";
const unit = `${identity}.service`;
const home = homedir();
const runtimeHome = process.env.XDG_RUNTIME_DIR;

if (runtimeHome === undefined) {
  throw new Error("XDG_RUNTIME_DIR is missing; the fixture must run in a PAM login session");
}

const paths: DaemonPaths = {
  installationRoot: join(home, ".local", "share", identity),
  dataRoot: join(home, ".local", "state", identity),
  configurationRoot: join(home, ".config", identity),
  cacheRoot: join(home, ".cache", identity),
  runtimeRoot: join(runtimeHome, identity),
  serviceDefinition: join(home, ".config", "systemd", "user", unit),
  managedCli: join(home, ".local", "share", identity, "bin", "kojo"),
  managedLauncher: join(home, ".local", "share", identity, "bin", "kojo-launcher"),
};
const childProcessIdPath = join(paths.dataRoot, "child.pid");
const daemonMain = new URL("../../../src/daemon/main.ts", import.meta.url).pathname;
const service = systemdUserService({ unit });

const waitFor = async (predicate: () => boolean, detail: string): Promise<void> => {
  const deadline = Date.now() + 20_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out while waiting for ${detail}`);
    await Bun.sleep(100);
  }
};

const mode = (path: string): string => (lstatSync(path).mode & 0o777).toString(8).padStart(3, "0");

const privateNode = (path: string, expectedMode: string): string => {
  const stat = lstatSync(path);
  if (stat.uid !== process.getuid?.()) throw new Error(`${path} has the wrong owner`);
  const actualMode = mode(path);
  if (actualMode !== expectedMode) {
    throw new Error(`${path} has mode ${actualMode}; expected ${expectedMode}`);
  }
  return actualMode;
};

const inspect = (): Record<string, unknown> => {
  const endpointPath = join(paths.runtimeRoot, "endpoint.json");
  const socketPath = join(paths.runtimeRoot, "daemon.sock");
  const lockPath = join(paths.dataRoot, "daemon.lock");
  const databasePath = join(paths.dataRoot, "kojo.db");
  const observation = service.inspect();
  if (observation.manager !== "loaded" || observation.process !== "running") {
    throw new Error(`the fixture service is not running: ${JSON.stringify(observation)}`);
  }
  const endpoint = JSON.parse(readFileSync(endpointPath, "utf8")) as { readonly ready?: boolean };
  if (endpoint.ready !== true) throw new Error("the Daemon endpoint is not ready");
  const childProcessId = Number(readFileSync(childProcessIdPath, "utf8").trim());
  if (!Number.isSafeInteger(childProcessId) || childProcessId <= 1) {
    throw new Error("the child process identity is invalid");
  }
  return {
    unit,
    observation,
    endpointReady: endpoint.ready,
    childProcessId,
    modes: {
      installationRoot: privateNode(paths.installationRoot, "700"),
      dataRoot: privateNode(paths.dataRoot, "700"),
      configurationRoot: privateNode(paths.configurationRoot, "700"),
      cacheRoot: privateNode(paths.cacheRoot, "700"),
      runtimeRoot: privateNode(paths.runtimeRoot, "700"),
      serviceDefinition: privateNode(paths.serviceDefinition, "600"),
      launcher: privateNode(paths.managedLauncher, "700"),
      lock: privateNode(lockPath, "600"),
      database: privateNode(databasePath, "600"),
      endpoint: privateNode(endpointPath, "600"),
      socket: privateNode(socketPath, "600"),
    },
  };
};

const operation = process.argv[2];

if (operation === "install") {
  mkdirSync(dirname(paths.serviceDefinition), { recursive: true, mode: 0o700 });
  writeNativeManagedRelease(paths, daemonMain, { childProcessIdPath });
  writeFileSync(
    paths.serviceDefinition,
    systemdUnitDocument(paths, { home, managedDirectoryName: identity }),
    { mode: 0o600 },
  );
  service.installAndStart(paths.serviceDefinition);
  await waitFor(() => service.inspect().process === "running", "the service process");
  await waitFor(() => existsSync(join(paths.runtimeRoot, "endpoint.json")), "Daemon readiness");
  await waitFor(() => existsSync(childProcessIdPath), "the child process");
  console.log(JSON.stringify(inspect()));
} else if (operation === "inspect") {
  console.log(JSON.stringify(inspect()));
} else if (operation === "remove") {
  service.disable(true);
  rmSync(paths.serviceDefinition, { force: true });
  const reload = Bun.spawnSync(["/usr/bin/systemctl", "--user", "daemon-reload"]);
  if (reload.exitCode !== 0) throw new Error("could not reload the systemd user manager");
  for (const path of [
    paths.installationRoot,
    paths.dataRoot,
    paths.configurationRoot,
    paths.cacheRoot,
  ]) {
    rmSync(path, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ removed: true, unit }));
} else {
  throw new Error("usage: systemdLogoutFixture.ts <install|inspect|remove>");
}
