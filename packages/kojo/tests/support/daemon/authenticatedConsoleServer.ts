import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { startDaemon } from "../../../src/contexts/daemon/adapters/DaemonOwner.ts";
import type { DaemonPaths } from "../../../src/contexts/daemon/models/DaemonPaths.ts";
import { publishConsoleRelease } from "./consoleRelease.ts";

const root = resolve(process.argv[2] ?? "");
const port = Number(process.argv[3]);
const assets = resolve(process.argv[4] ?? "");
if (!root.startsWith("/tmp/") || !Number.isInteger(port) || port < 1) {
  throw new Error("usage: authenticatedConsoleServer.ts /tmp/ROOT PORT ASSETS");
}
rmSync(root, { recursive: true, force: true });
const installationRoot = join(root, "installation");
const paths: DaemonPaths = {
  installationRoot,
  dataRoot: join(root, "data"),
  configurationRoot: join(root, "configuration"),
  cacheRoot: join(root, "cache"),
  runtimeRoot: join(root, "runtime"),
  serviceDefinition: join(root, "LaunchAgents", "dev.kojo.test.plist"),
  managedCli: join(installationRoot, "bin", "kojo"),
  managedLauncher: join(installationRoot, "bin", "kojo-launcher"),
};
publishConsoleRelease(paths, { assets, releaseId: "kojo-browser-test" });
const daemon = startDaemon(paths, { consolePort: port });

const stop = (): void => {
  void daemon.stop().finally(() => rmSync(root, { recursive: true, force: true }));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await daemon.stopped;
