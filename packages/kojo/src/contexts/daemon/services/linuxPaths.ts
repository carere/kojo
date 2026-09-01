import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { DaemonPaths } from "../models/DaemonPaths.ts";
import { LifecycleError } from "../models/LifecycleError.ts";
import { assertPrivateNode } from "./secureHostPath.ts";

export interface LinuxPathEnvironment {
  readonly HOME?: string;
  readonly XDG_CACHE_HOME?: string;
  readonly XDG_CONFIG_HOME?: string;
  readonly XDG_DATA_HOME?: string;
  readonly XDG_RUNTIME_DIR?: string;
  readonly XDG_STATE_HOME?: string;
}

const absolute = (name: string, value: string): string => {
  if (!isAbsolute(value)) {
    throw new LifecycleError("INVALID_XDG_PATH", `${name} must be an absolute path`);
  }
  return value;
};

export const linuxPaths = (
  overrides: Partial<DaemonPaths> = {},
  environment: LinuxPathEnvironment = {
    ...(process.env.HOME === undefined ? {} : { HOME: process.env.HOME }),
    ...(process.env.XDG_CACHE_HOME === undefined
      ? {}
      : { XDG_CACHE_HOME: process.env.XDG_CACHE_HOME }),
    ...(process.env.XDG_CONFIG_HOME === undefined
      ? {}
      : { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME }),
    ...(process.env.XDG_DATA_HOME === undefined
      ? {}
      : { XDG_DATA_HOME: process.env.XDG_DATA_HOME }),
    ...(process.env.XDG_RUNTIME_DIR === undefined
      ? {}
      : { XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR }),
    ...(process.env.XDG_STATE_HOME === undefined
      ? {}
      : { XDG_STATE_HOME: process.env.XDG_STATE_HOME }),
  },
): DaemonPaths => {
  if (process.platform !== "linux" && Object.keys(overrides).length === 0) {
    throw new LifecycleError("UNSUPPORTED_HOST", "this Host is not Linux");
  }

  const home = absolute("HOME", environment.HOME ?? homedir());
  const runtimeHome = environment.XDG_RUNTIME_DIR;
  if (overrides.runtimeRoot === undefined && runtimeHome === undefined) {
    throw new LifecycleError(
      "SYSTEMD_USER_MANAGER_UNAVAILABLE",
      "XDG_RUNTIME_DIR is not set; log in through a systemd user session and try again",
    );
  }
  if (overrides.runtimeRoot === undefined) {
    const path = absolute("XDG_RUNTIME_DIR", runtimeHome ?? "");
    try {
      assertPrivateNode(path, "directory");
    } catch (cause) {
      throw new LifecycleError(
        "UNSAFE_XDG_RUNTIME_DIRECTORY",
        `${path} must be a private directory owned by the current OS user`,
        cause,
      );
    }
  }
  const configHome = absolute(
    "XDG_CONFIG_HOME",
    environment.XDG_CONFIG_HOME ?? join(home, ".config"),
  );
  const dataHome = absolute(
    "XDG_DATA_HOME",
    environment.XDG_DATA_HOME ?? join(home, ".local", "share"),
  );
  const stateHome = absolute(
    "XDG_STATE_HOME",
    environment.XDG_STATE_HOME ?? join(home, ".local", "state"),
  );
  const cacheHome = absolute("XDG_CACHE_HOME", environment.XDG_CACHE_HOME ?? join(home, ".cache"));
  const installationRoot = overrides.installationRoot ?? join(dataHome, "kojo");

  return {
    installationRoot,
    dataRoot: overrides.dataRoot ?? join(stateHome, "kojo"),
    configurationRoot: overrides.configurationRoot ?? join(configHome, "kojo"),
    cacheRoot: overrides.cacheRoot ?? join(cacheHome, "kojo"),
    runtimeRoot:
      overrides.runtimeRoot ?? join(absolute("XDG_RUNTIME_DIR", runtimeHome ?? ""), "kojo"),
    serviceDefinition:
      overrides.serviceDefinition ?? join(configHome, "systemd", "user", "kojo.service"),
    managedCli: overrides.managedCli ?? join(installationRoot, "bin", "kojo"),
    managedLauncher: overrides.managedLauncher ?? join(installationRoot, "bin", "kojo-launcher"),
  };
};
