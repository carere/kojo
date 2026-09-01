import { describe, expect, it } from "vitest";
import {
  type Launchctl,
  macLaunchAgent,
} from "../../../../../src/contexts/daemon/adapters/MacLaunchAgent.ts";

const result = (stdout = "", exitCode = 0, stderr = "") => ({ exitCode, stdout, stderr });

describe("the macOS LaunchAgent adapter", () => {
  it("reports automatic start, manager state, and process state separately", () => {
    const launchctl: Launchctl = (arguments_) =>
      arguments_[0] === "print-disabled"
        ? result('{ "dev.kojo.test" => disabled }')
        : result("state = running");

    expect(macLaunchAgent({ label: "dev.kojo.test", uid: 501, launchctl }).inspect()).toEqual({
      automaticStart: "disabled",
      manager: "loaded",
      process: "running",
      loginLifetime: "macOS GUI login session",
      logoutPersistence: "unsupported",
    });
  });

  it("does not start when enable is the requested operation", () => {
    const calls: Array<ReadonlyArray<string>> = [];
    const launchctl: Launchctl = (arguments_) => {
      calls.push(arguments_);
      return result();
    };

    macLaunchAgent({ label: "dev.kojo.test", uid: 501, launchctl }).enable();

    expect(calls).toEqual([["enable", "gui/501/dev.kojo.test"]]);
  });

  it("disables a running service without stopping it unless now is explicit", () => {
    const calls: Array<ReadonlyArray<string>> = [];
    const launchctl: Launchctl = (arguments_) => {
      calls.push(arguments_);
      if (arguments_[0] === "print") return result("state = running");
      if (arguments_[0] === "print-disabled") return result("{}");
      return result();
    };
    const service = macLaunchAgent({ label: "dev.kojo.test", uid: 501, launchctl });

    service.disable(false);
    expect(calls).toEqual([["disable", "gui/501/dev.kojo.test"]]);

    calls.length = 0;
    service.disable(true);
    expect(calls).toContainEqual(["bootout", "gui/501/dev.kojo.test"]);
  });

  it("starts an unloaded disabled service and restores its disabled state", () => {
    const calls: Array<ReadonlyArray<string>> = [];
    const launchctl: Launchctl = (arguments_) => {
      calls.push(arguments_);
      if (arguments_[0] === "print") return result("", 1, "not loaded");
      if (arguments_[0] === "print-disabled") {
        return result('{ "dev.kojo.test" => disabled }');
      }
      return result();
    };

    macLaunchAgent({ label: "dev.kojo.test", uid: 501, launchctl }).start("/private/test.plist");

    expect(calls).toEqual([
      ["print", "gui/501/dev.kojo.test"],
      ["print-disabled", "gui/501"],
      ["enable", "gui/501/dev.kojo.test"],
      ["bootstrap", "gui/501", "/private/test.plist"],
      ["disable", "gui/501/dev.kojo.test"],
    ]);
  });
});
