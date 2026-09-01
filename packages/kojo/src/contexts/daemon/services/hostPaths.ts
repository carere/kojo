import type { DaemonPaths } from "../models/DaemonPaths.ts";
import { LifecycleError } from "../models/LifecycleError.ts";
import { linuxPaths } from "./linuxPaths.ts";
import { macPaths } from "./macPaths.ts";

export const hostPaths = (overrides: Partial<DaemonPaths> = {}): DaemonPaths => {
  if (process.platform === "darwin") return macPaths(overrides);
  if (process.platform === "linux") return linuxPaths(overrides);
  throw new LifecycleError(
    "UNSUPPORTED_HOST",
    "Kojo supports macOS or Linux with a functioning systemd user manager",
  );
};
