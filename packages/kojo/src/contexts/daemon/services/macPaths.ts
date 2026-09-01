import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DaemonPaths } from "../models/DaemonPaths.ts";
import { LifecycleError } from "../models/LifecycleError.ts";

const darwinTemporaryDirectory = (): string => {
  try {
    const value = execFileSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (value.length > 0 && value.startsWith("/")) return value;
  } catch (cause) {
    throw new LifecycleError(
      "DARWIN_TEMPORARY_DIRECTORY_UNAVAILABLE",
      "macOS did not supply the current user's temporary directory",
      cause,
    );
  }
  throw new LifecycleError(
    "DARWIN_TEMPORARY_DIRECTORY_UNAVAILABLE",
    "macOS supplied an invalid current-user temporary directory",
  );
};

export const macPaths = (overrides: Partial<DaemonPaths> = {}): DaemonPaths => {
  if (process.platform !== "darwin" && Object.keys(overrides).length === 0) {
    throw new LifecycleError("UNSUPPORTED_HOST", "this ticket supports macOS only");
  }

  const home = homedir();
  const installationRoot =
    overrides.installationRoot ?? join(home, "Library", "Application Support", "Kojo");
  return {
    installationRoot,
    dataRoot: overrides.dataRoot ?? join(installationRoot, "data"),
    runtimeRoot: overrides.runtimeRoot ?? join(darwinTemporaryDirectory(), "Kojo"),
    launchAgent:
      overrides.launchAgent ?? join(home, "Library", "LaunchAgents", "dev.kojo.daemon.plist"),
    managedCli: overrides.managedCli ?? join(installationRoot, "bin", "kojo"),
    managedLauncher: overrides.managedLauncher ?? join(installationRoot, "bin", "kojo-launcher"),
  };
};
