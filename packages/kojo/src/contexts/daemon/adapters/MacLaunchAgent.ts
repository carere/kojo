import { spawnSync } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { LifecycleError } from "../models/LifecycleError.ts";
import type { NativeService, NativeServiceObservation } from "../ports/NativeService.ts";
import { launchAgentDocument } from "../services/launchAgentDocument.ts";
import { assertPrivateNode } from "../services/secureHostPath.ts";

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type Launchctl = (arguments_: ReadonlyArray<string>) => CommandResult;

const nativeLaunchctl: Launchctl = (arguments_) => {
  const result = spawnSync("/bin/launchctl", arguments_, { encoding: "utf8" });
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? "",
  };
};

const failed = (operation: string, result: CommandResult): never => {
  const reason = (result.stderr || result.stdout).trim() || `exit ${result.exitCode}`;
  throw new LifecycleError("NATIVE_SERVICE_FAILED", `${operation}: ${reason}`);
};

export const macLaunchAgent = (
  options: { readonly label?: string; readonly uid?: number; readonly launchctl?: Launchctl } = {},
): NativeService => {
  const label = options.label ?? "dev.kojo.daemon";
  const userId = options.uid ?? process.getuid?.();
  if (userId === undefined) {
    throw new LifecycleError("UNSUPPORTED_HOST", "the Host has no OS-user identity");
  }
  const launchctl = options.launchctl ?? nativeLaunchctl;
  const domain = `gui/${userId}`;
  const target = `${domain}/${label}`;

  const inspect = (): NativeServiceObservation => {
    const printed = launchctl(["print", target]);
    const disabled = launchctl(["print-disabled", domain]);
    const escapedLabel = label.replaceAll(".", "\\.");
    const disabledPattern = new RegExp(`"${escapedLabel}"\\s*=>\\s*(?:true|disabled)`);
    const enabledPattern = new RegExp(`"${escapedLabel}"\\s*=>\\s*(?:false|enabled)`);
    const automaticStart = disabledPattern.test(disabled.stdout)
      ? "disabled"
      : enabledPattern.test(disabled.stdout) || disabled.exitCode === 0
        ? "enabled"
        : "unknown";

    if (printed.exitCode !== 0) {
      const detail = (printed.stderr || disabled.stderr).trim();
      return {
        automaticStart,
        manager: disabled.exitCode === 0 ? "unloaded" : "unavailable",
        process: disabled.exitCode === 0 ? "stopped" : "unknown",
        loginLifetime: "macOS GUI login session",
        logoutPersistence: "unsupported",
        ...(detail.length === 0 ? {} : { detail }),
      };
    }

    const state = /\bstate\s*=\s*running\b/.test(printed.stdout) ? "running" : "stopped";
    return {
      automaticStart,
      manager: "loaded",
      process: state,
      loginLifetime: "macOS GUI login session",
      logoutPersistence: "unsupported",
    };
  };

  const run = (operation: string, arguments_: ReadonlyArray<string>): void => {
    const result = launchctl(arguments_);
    if (result.exitCode !== 0) failed(operation, result);
  };

  return {
    serviceDocument: (paths) =>
      launchAgentDocument(paths, {
        label,
        home: process.env.HOME ?? "",
      }),
    assertSupported: () => {},
    inspect,
    installAndStart: (launchAgent) => {
      run("enable automatic start", ["enable", target]);
      run("load and start the LaunchAgent", ["bootstrap", domain, launchAgent]);
    },
    start: (launchAgent) => {
      const current = inspect();
      if (current.manager === "loaded") {
        run("start the LaunchAgent", ["kickstart", target]);
      } else if (current.automaticStart === "disabled") {
        run("permit one explicit LaunchAgent start", ["enable", target]);
        try {
          run("load and start the LaunchAgent", ["bootstrap", domain, launchAgent]);
        } finally {
          run("restore disabled automatic start", ["disable", target]);
        }
      } else {
        run("load and start the LaunchAgent", ["bootstrap", domain, launchAgent]);
      }
    },
    stop: () => {
      if (inspect().manager === "loaded") run("stop the LaunchAgent", ["bootout", target]);
    },
    enable: () => run("enable automatic start", ["enable", target]),
    disable: (stopNow) => {
      run("disable automatic start", ["disable", target]);
      if (stopNow && inspect().manager === "loaded") {
        run("stop the disabled LaunchAgent", ["bootout", target]);
      }
    },
    removeRegistration: (launchAgent) => {
      const current = inspect();
      if (current.manager === "loaded") run("stop the LaunchAgent", ["bootout", target]);
      if (current.automaticStart !== "disabled") {
        run("disable automatic start", ["disable", target]);
      }
      if (existsSync(launchAgent)) {
        assertPrivateNode(launchAgent, "file");
        unlinkSync(launchAgent);
      }
    },
    keepRunningAfterLogout: () => {
      throw new LifecycleError(
        "LOGOUT_PERSISTENCE_UNSUPPORTED",
        "a macOS LaunchAgent stops at final GUI logout; Kojo cannot enable logout persistence",
      );
    },
  };
};
