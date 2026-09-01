import { describe, expect, it } from "vitest";
import { daemonStatusLines } from "../../../src/cli/daemon.ts";

describe("daemon status text", () => {
  it("keeps installation, automatic start, process, responsiveness, and readiness separate", () => {
    const lines = daemonStatusLines({
      installed: true,
      managedCli: "/managed/bin/kojo",
      automaticStart: "disabled",
      manager: "loaded",
      process: "running",
      responsiveness: "unresponsive",
      ready: false,
      loginLifetime: "macOS GUI login session",
    });

    expect(lines).toEqual([
      "Installed: yes.",
      "Managed CLI: /managed/bin/kojo.",
      "Automatic start: disabled.",
      "Manager: loaded.",
      "Process: running.",
      "Responsive: unresponsive.",
      "Ready: no.",
      "Supported lifetime: macOS GUI login session.",
    ]);
  });
});
