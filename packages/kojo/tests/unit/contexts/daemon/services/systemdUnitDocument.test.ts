import { describe, expect, it } from "vitest";
import type { DaemonPaths } from "../../../../../src/contexts/daemon/models/DaemonPaths.ts";
import { systemdUnitDocument } from "../../../../../src/contexts/daemon/services/systemdUnitDocument.ts";

const paths: DaemonPaths = {
  installationRoot: "/home/example/.local/share/kojo",
  dataRoot: "/home/example/.local/state/kojo",
  configurationRoot: "/home/example/.config/kojo",
  cacheRoot: "/home/example/.cache/kojo",
  runtimeRoot: "/run/user/1000/kojo",
  serviceDefinition: "/home/example/.config/systemd/user/kojo.service",
  managedCli: "/home/example/.local/share/kojo/bin/kojo",
  managedLauncher: "/home/example/.local/share/kojo/bin/kojo-launcher",
};

describe("the managed Kojo systemd user service", () => {
  it("uses Type=exec, private managed paths, a small environment, and bounded cleanup", () => {
    const document = systemdUnitDocument(paths, { home: "/home/example" });

    expect(document).toContain("Type=exec");
    expect(document).toContain(`ExecStart="${paths.managedLauncher}"`);
    expect(document).toContain('Environment="PATH=/usr/local/bin:/usr/bin:/bin"');
    expect(document).toContain("RuntimeDirectoryMode=0700");
    expect(document).toContain("StateDirectoryMode=0700");
    expect(document).toContain("CacheDirectoryMode=0700");
    expect(document).toContain("ConfigurationDirectoryMode=0700");
    expect(document).toContain("RuntimeDirectoryPreserve=no");
    expect(document).toContain("TimeoutStopSec=30s");
    expect(document).toContain("KillMode=control-group");
    expect(document).toContain("Restart=on-failure");
    expect(document).toContain("StartLimitIntervalSec=30s");
    expect(document).toContain("StartLimitBurst=5");
    expect(document).not.toContain("KOJO_AGENT_SPEND");
  });
});
