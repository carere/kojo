import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { managedInstallationIsPresent } from "../adapters/ManagedInstallation.ts";
import type { DaemonPaths } from "../models/DaemonPaths.ts";
import type { DaemonStatus } from "../models/DaemonStatus.ts";
import type { DaemonEndpoint } from "../models/Endpoint.ts";
import type { NativeService } from "../ports/NativeService.ts";

const privateOwned = (path: string, kind: "file" | "socket"): boolean => {
  try {
    const stat = lstatSync(path);
    if (
      stat.isSymbolicLink() ||
      stat.uid !== (process.getuid?.() ?? -1) ||
      (stat.mode & 0o077) !== 0
    ) {
      return false;
    }
    return kind === "file" ? stat.isFile() : stat.isSocket();
  } catch {
    return false;
  }
};

const privateRuntimeDirectory = (path: string): boolean => {
  try {
    const stat = lstatSync(path);
    return (
      stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      stat.uid === (process.getuid?.() ?? -1) &&
      (stat.mode & 0o077) === 0
    );
  } catch {
    return false;
  }
};

export const readDaemonEndpoint = (paths: DaemonPaths): DaemonEndpoint | undefined => {
  if (!privateRuntimeDirectory(paths.runtimeRoot)) return undefined;
  const path = join(paths.runtimeRoot, "endpoint.json");
  if (!privateOwned(path, "file")) return undefined;
  try {
    const endpoint = JSON.parse(readFileSync(path, "utf8")) as DaemonEndpoint;
    if (
      endpoint.formatVersion !== 1 ||
      endpoint.ready !== true ||
      !/^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint.consoleOrigin) ||
      endpoint.socketPath !== join(paths.runtimeRoot, "daemon.sock") ||
      !privateOwned(endpoint.socketPath, "socket")
    ) {
      return undefined;
    }
    return endpoint;
  } catch {
    return undefined;
  }
};

const probe = async (endpoint: DaemonEndpoint): Promise<boolean> => {
  try {
    const response = await fetch("http://localhost/ready", {
      unix: endpoint.socketPath,
      signal: AbortSignal.timeout(1_000),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as DaemonEndpoint;
    return (
      body.ready === true &&
      body.dataIdentity === endpoint.dataIdentity &&
      body.instanceId === endpoint.instanceId
    );
  } catch {
    return false;
  }
};

export const inspectDaemon = async (
  paths: DaemonPaths,
  nativeService: NativeService,
): Promise<DaemonStatus> => {
  const native = nativeService.inspect();
  const endpoint = readDaemonEndpoint(paths);
  const responsive = endpoint === undefined ? false : await probe(endpoint);
  return {
    installed:
      managedInstallationIsPresent(paths) &&
      existsSync(paths.launchAgent) &&
      privateOwned(paths.launchAgent, "file"),
    managedCli: paths.managedCli,
    automaticStart: native.automaticStart,
    manager: native.manager,
    process: native.process,
    responsiveness:
      native.process === "running" || endpoint !== undefined
        ? responsive
          ? "responsive"
          : "unresponsive"
        : "unknown",
    ready: responsive,
    loginLifetime: "macOS GUI login session",
    ...(native.detail === undefined ? {} : { detail: native.detail }),
  };
};
