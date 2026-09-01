import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  type SystemdCommand,
  systemdUserService,
} from "../../../../../src/contexts/daemon/adapters/SystemdUserService.ts";
import { LifecycleError } from "../../../../../src/contexts/daemon/models/LifecycleError.ts";

const result = (stdout = "", exitCode = 0, stderr = "") => ({ exitCode, stdout, stderr });

describe("the systemd user service adapter", () => {
  it("reports enablement, manager, process, and logout persistence separately", () => {
    const systemctl: SystemdCommand = (arguments_) => {
      if (arguments_.includes("show-environment")) return result("PATH=/usr/bin\n");
      if (arguments_.includes("is-enabled")) return result("enabled\n");
      return result("LoadState=loaded\nActiveState=active\n");
    };
    const loginctl: SystemdCommand = () => result("no\n");

    expect(
      systemdUserService({ unit: "kojo-test.service", uid: 1200, systemctl, loginctl }).inspect(),
    ).toEqual({
      automaticStart: "enabled",
      manager: "loaded",
      process: "running",
      loginLifetime: "systemd login sessions; final logout stops the user manager",
      logoutPersistence: "disabled",
    });
  });

  it("keeps start, stop, enable, and disable as separate manager operations", () => {
    const calls: Array<ReadonlyArray<string>> = [];
    const systemctl: SystemdCommand = (arguments_) => {
      calls.push(arguments_);
      if (arguments_.includes("show") && arguments_.includes("--property=LoadState")) {
        return result("LoadState=loaded\n");
      }
      return result();
    };
    const service = systemdUserService({
      unit: "kojo-test.service",
      uid: 1200,
      systemctl,
      loginctl: () => result("no\n"),
    });

    service.start("/ignored/kojo-test.service");
    service.stop();
    service.enable();
    service.disable(false);
    service.disable(true);

    expect(
      calls.filter(
        (call) => !call.includes("show-environment") && !call.includes("--property=LoadState"),
      ),
    ).toEqual([
      ["--user", "start", "kojo-test.service"],
      ["--user", "stop", "kojo-test.service"],
      ["--user", "enable", "kojo-test.service"],
      ["--user", "disable", "kojo-test.service"],
      ["--user", "disable", "--now", "kojo-test.service"],
    ]);
  });

  it("reloads registration before it enables and starts an installed service", () => {
    const calls: Array<ReadonlyArray<string>> = [];
    const systemctl: SystemdCommand = (arguments_) => {
      calls.push(arguments_);
      return result();
    };
    systemdUserService({
      unit: "kojo-test.service",
      uid: 1200,
      systemctl,
      loginctl: () => result("no\n"),
    }).installAndStart("/ignored/kojo-test.service");

    expect(calls.filter((call) => !call.includes("show-environment"))).toEqual([
      ["--user", "daemon-reload"],
      ["--user", "enable", "--now", "kojo-test.service"],
    ]);
  });

  it("requests linger only when the explicit operation is used and reports policy refusal", () => {
    const loginCalls: Array<ReadonlyArray<string>> = [];
    const loginctl: SystemdCommand = (arguments_) => {
      loginCalls.push(arguments_);
      return result("", 1, "Access denied by policy");
    };
    const service = systemdUserService({
      unit: "kojo-test.service",
      uid: 1200,
      systemctl: () => result(),
      loginctl,
    });

    service.disable(true);
    expect(loginCalls).toEqual([]);
    expect(() => service.keepRunningAfterLogout()).toThrowError(LifecycleError);
    try {
      service.keepRunningAfterLogout();
    } catch (error) {
      expect(error).toMatchObject({ code: "LINGER_PERMISSION_DENIED" });
    }
    expect(loginCalls).toEqual([
      ["enable-linger", "1200"],
      ["enable-linger", "1200"],
    ]);
    expect(loginCalls).not.toContainEqual(["disable-linger", "1200"]);
  });

  it("refuses operations when no systemd user manager is available", () => {
    const service = systemdUserService({
      unit: "kojo-test.service",
      uid: 1200,
      systemctl: () => result("", 1, "Failed to connect to bus"),
      loginctl: () => result("no\n"),
    });

    expect(() => service.start("/ignored/kojo-test.service")).toThrow(
      "Log in through a systemd user session",
    );
  });

  it("removes native registration without changing Linux linger", () => {
    const root = mkdtempSync(join(tmpdir(), "kojo-systemd-remove-"));
    chmodSync(root, 0o700);
    const definition = join(root, "kojo.service");
    writeFileSync(definition, "service\n", { mode: 0o600 });
    const calls: Array<ReadonlyArray<string>> = [];
    const loginCalls: Array<ReadonlyArray<string>> = [];
    let enabled = true;
    const service = systemdUserService({
      unit: "kojo-test.service",
      uid: 1200,
      systemctl: (arguments_) => {
        calls.push(arguments_);
        if (arguments_.includes("is-enabled")) {
          return result(enabled ? "enabled\n" : "disabled\n", enabled ? 0 : 1);
        }
        if (arguments_.includes("disable")) enabled = false;
        return result();
      },
      loginctl: (arguments_) => {
        loginCalls.push(arguments_);
        return result("yes\n");
      },
    });
    try {
      service.removeRegistration?.(definition);
      service.removeRegistration?.(definition);

      expect(existsSync(definition)).toBe(false);
      expect(calls.filter((call) => !call.includes("show-environment"))).toEqual([
        ["--user", "is-enabled", "kojo-test.service"],
        ["--user", "disable", "kojo-test.service"],
        ["--user", "daemon-reload"],
        ["--user", "is-enabled", "kojo-test.service"],
        ["--user", "daemon-reload"],
      ]);
      expect(loginCalls).toEqual([]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
