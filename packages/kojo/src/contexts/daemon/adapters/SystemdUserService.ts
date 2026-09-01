import { spawnSync } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { LifecycleError } from "../models/LifecycleError.ts";
import type { NativeService, NativeServiceObservation } from "../ports/NativeService.ts";
import { assertPrivateNode } from "../services/secureHostPath.ts";
import { systemdUnitDocument } from "../services/systemdUnitDocument.ts";

export interface SystemdCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export type SystemdCommand = (arguments_: ReadonlyArray<string>) => SystemdCommandResult;

const command =
  (executable: string): SystemdCommand =>
  (arguments_) => {
    const result = spawnSync(executable, arguments_, { encoding: "utf8" });
    return {
      exitCode: result.status ?? 1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? result.error?.message ?? "",
    };
  };

const reason = (result: SystemdCommandResult): string =>
  (result.stderr || result.stdout).trim() || `exit ${result.exitCode}`;

const failed = (operation: string, result: SystemdCommandResult): never => {
  throw new LifecycleError("NATIVE_SERVICE_FAILED", `${operation}: ${reason(result)}`);
};

const unavailable = (result: SystemdCommandResult): never => {
  throw new LifecycleError(
    "SYSTEMD_USER_MANAGER_UNAVAILABLE",
    `the systemd user manager is not available: ${reason(result)}. Log in through a systemd user session or use a supported Host`,
  );
};

export const systemdUserService = (
  options: {
    readonly unit?: string;
    readonly uid?: number;
    readonly home?: string;
    readonly systemctl?: SystemdCommand;
    readonly loginctl?: SystemdCommand;
  } = {},
): NativeService => {
  if (process.platform !== "linux" && options.systemctl === undefined) {
    throw new LifecycleError(
      "UNSUPPORTED_HOST",
      "systemd user services are supported only on Linux Hosts",
    );
  }
  const unit = options.unit ?? "kojo.service";
  const userId = options.uid ?? process.getuid?.();
  if (userId === undefined) {
    throw new LifecycleError("UNSUPPORTED_HOST", "the Host has no OS-user identity");
  }
  const systemctl = options.systemctl ?? command("/usr/bin/systemctl");
  const loginctl = options.loginctl ?? command("/usr/bin/loginctl");

  const managerIsAvailable = (): boolean =>
    systemctl(["--user", "show-environment"]).exitCode === 0;
  const assertManager = (): void => {
    const result = systemctl(["--user", "show-environment"]);
    if (result.exitCode !== 0) unavailable(result);
  };
  const run = (operation: string, arguments_: ReadonlyArray<string>): void => {
    assertManager();
    const result = systemctl(["--user", ...arguments_]);
    if (result.exitCode !== 0) failed(operation, result);
  };
  const linger = (): {
    readonly state: NativeServiceObservation["logoutPersistence"];
    readonly detail?: string;
  } => {
    const result = loginctl(["show-user", String(userId), "--property=Linger", "--value"]);
    if (result.exitCode !== 0) return { state: "unknown", detail: reason(result) };
    return { state: result.stdout.trim() === "yes" ? "enabled" : "disabled" };
  };

  return {
    serviceDocument: (paths) =>
      systemdUnitDocument(paths, options.home === undefined ? {} : { home: options.home }),
    assertSupported: assertManager,
    inspect: () => {
      if (!managerIsAvailable()) {
        return {
          automaticStart: "unknown",
          manager: "unavailable",
          process: "unknown",
          loginLifetime: "systemd login sessions; final logout stops the user manager",
          logoutPersistence: "unknown",
          detail: "the systemd user manager is not available",
        };
      }
      const enabled = systemctl(["--user", "is-enabled", unit]);
      const automaticStart = enabled.stdout.trim() === "enabled" ? "enabled" : "disabled";
      const shown = systemctl([
        "--user",
        "show",
        unit,
        "--property=LoadState,ActiveState",
        "--no-pager",
      ]);
      const loadState = /^LoadState=(.+)$/m.exec(shown.stdout)?.[1];
      const activeState = /^ActiveState=(.+)$/m.exec(shown.stdout)?.[1];
      const logout = linger();
      const loginLifetime =
        logout.state === "enabled"
          ? "systemd user manager from Host boot through shutdown"
          : logout.state === "disabled"
            ? "systemd login sessions; final logout stops the user manager"
            : "systemd user-manager lifetime is unknown";
      return {
        automaticStart,
        manager: shown.exitCode === 0 && loadState === "loaded" ? "loaded" : "unloaded",
        process:
          shown.exitCode === 0
            ? activeState === "active" || activeState === "activating"
              ? "running"
              : "stopped"
            : "stopped",
        loginLifetime,
        logoutPersistence: logout.state,
        ...(logout.detail === undefined ? {} : { detail: logout.detail }),
      };
    },
    installAndStart: () => {
      run("reload the systemd user manager", ["daemon-reload"]);
      run("enable and start the systemd user service", ["enable", "--now", unit]);
    },
    start: () => run("start the systemd user service", ["start", unit]),
    stop: () => {
      assertManager();
      const shown = systemctl(["--user", "show", unit, "--property=LoadState", "--no-pager"]);
      if (shown.exitCode === 0 && /^LoadState=loaded$/m.test(shown.stdout)) {
        run("stop the systemd user service", ["stop", unit]);
      }
    },
    enable: () => run("enable automatic start", ["enable", unit]),
    disable: (stopNow) =>
      run("disable automatic start", ["disable", ...(stopNow ? ["--now"] : []), unit]),
    removeRegistration: (serviceDefinition) => {
      run("disable automatic start", ["disable", unit]);
      if (existsSync(serviceDefinition)) {
        assertPrivateNode(serviceDefinition, "file");
        unlinkSync(serviceDefinition);
      }
      run("reload the systemd user manager", ["daemon-reload"]);
    },
    keepRunningAfterLogout: () => {
      const result = loginctl(["enable-linger", String(userId)]);
      if (result.exitCode === 0) return;
      const detail = reason(result);
      if (/access denied|authentication|not authorized|permission|polkit/i.test(detail)) {
        throw new LifecycleError(
          "LINGER_PERMISSION_DENIED",
          `Host policy refused logout persistence for OS user ${userId}: ${detail}`,
        );
      }
      throw new LifecycleError(
        "LINGER_ENABLE_FAILED",
        `could not enable logout persistence for OS user ${userId}: ${detail}`,
      );
    },
  };
};
