#!/usr/bin/env bun
import { join } from "node:path";
import { startDaemon } from "../contexts/daemon/adapters/DaemonOwner.ts";
import { macPaths } from "../contexts/daemon/services/macPaths.ts";

const installationRoot = process.env.KOJO_MANAGED_INSTALLATION;
const dataRoot = process.env.KOJO_DAEMON_DATA;
const runtimeRoot = process.env.KOJO_DAEMON_RUNTIME;
const paths = macPaths(
  installationRoot !== undefined && dataRoot !== undefined && runtimeRoot !== undefined
    ? {
        installationRoot,
        dataRoot,
        runtimeRoot,
        managedCli: join(installationRoot, "bin", "kojo"),
        managedLauncher: join(installationRoot, "bin", "kojo-launcher"),
      }
    : {},
);
const daemon = startDaemon(paths);

let stopping = false;
const stop = (): void => {
  if (stopping) return;
  stopping = true;
  void daemon.stop();
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

await daemon.stopped;
