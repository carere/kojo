import { describe, expect, it } from "vitest";
import type { DaemonPaths } from "../../../../../src/contexts/daemon/models/DaemonPaths.ts";
import { launchAgentDocument } from "../../../../../src/contexts/daemon/services/launchAgentDocument.ts";

const paths: DaemonPaths = {
  installationRoot: "/Users/example/Library/Application Support/Kojo",
  dataRoot: "/Users/example/Library/Application Support/Kojo/data",
  configurationRoot: "/Users/example/Library/Application Support/Kojo/config",
  cacheRoot: "/Users/example/Library/Caches/Kojo",
  runtimeRoot: "/private/var/folders/example/T/Kojo",
  serviceDefinition: "/Users/example/Library/LaunchAgents/dev.kojo.daemon.plist",
  managedCli: "/Users/example/Library/Application Support/Kojo/bin/kojo",
  managedLauncher: "/Users/example/Library/Application Support/Kojo/bin/kojo-launcher",
};

describe("the managed Kojo LaunchAgent", () => {
  it("uses stable absolute paths, an explicit environment, and finite shutdown", () => {
    const document = launchAgentDocument(paths, { home: "/Users/example" });

    expect(document).toContain(`<string>${paths.managedLauncher}</string>`);
    expect(document).toContain("<key>KOJO_DAEMON_DATA</key>");
    expect(document).toContain("<string>/usr/bin:/bin:/usr/sbin:/sbin</string>");
    expect(document).toContain("<key>KeepAlive</key>");
    expect(document).toContain("<key>ExitTimeOut</key>\n    <integer>30</integer>");
    expect(document).not.toContain("KOJO_AGENT_SPEND");
  });
});
