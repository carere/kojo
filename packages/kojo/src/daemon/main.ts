#!/usr/bin/env bun
import { join } from "node:path";
import { Effect } from "effect";
import { startDaemon } from "../contexts/daemon/adapters/DaemonOwner.ts";
import { hostPaths } from "../contexts/daemon/services/hostPaths.ts";

const installationRoot = process.env.KOJO_MANAGED_INSTALLATION;
const dataRoot = process.env.KOJO_DAEMON_DATA;
const runtimeRoot = process.env.KOJO_DAEMON_RUNTIME;
const configurationRoot = process.env.KOJO_DAEMON_CONFIG;
const cacheRoot = process.env.KOJO_DAEMON_CACHE;
const paths = hostPaths(
  installationRoot !== undefined && dataRoot !== undefined && runtimeRoot !== undefined
    ? {
        installationRoot,
        dataRoot,
        runtimeRoot,
        ...(configurationRoot === undefined ? {} : { configurationRoot }),
        ...(cacheRoot === undefined ? {} : { cacheRoot }),
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
  void Effect.runPromise(daemon.stop);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);

await Effect.runPromise(daemon.stopped);
