import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { macLaunchAgent } from "../../../../src/contexts/daemon/adapters/MacLaunchAgent.ts";
import type { DaemonPaths } from "../../../../src/contexts/daemon/models/DaemonPaths.ts";
import { launchAgentDocument } from "../../../../src/contexts/daemon/services/launchAgentDocument.ts";

const waitFor = async (predicate: () => boolean, timeout = 10_000): Promise<void> => {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error("native LaunchAgent did not reach the expected state");
    await Bun.sleep(50);
  }
};

describe.skipIf(process.platform !== "darwin")("the native macOS Daemon lifecycle", () => {
  it("starts one isolated idle LaunchAgent and preserves stop and enablement as separate states", async () => {
    const root = mkdtempSync(join(tmpdir(), "kojo-native-service-"));
    const label = `dev.kojo.test.${crypto.randomUUID()}`;
    const installationRoot = join(root, "installation");
    const paths: DaemonPaths = {
      installationRoot,
      dataRoot: join(root, "data"),
      runtimeRoot: join(root, "runtime"),
      launchAgent: join(root, `${label}.plist`),
      managedCli: join(installationRoot, "bin", "kojo"),
      managedLauncher: join(installationRoot, "bin", "kojo-launcher"),
    };
    mkdirSync(join(installationRoot, "bin"), { recursive: true, mode: 0o700 });
    const daemonMain = new URL("../../../../src/daemon/main.ts", import.meta.url).pathname;
    writeFileSync(
      paths.managedLauncher,
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(daemonMain)}\n`,
      { mode: 0o700 },
    );
    chmodSync(paths.managedLauncher, 0o700);
    writeFileSync(paths.launchAgent, launchAgentDocument(paths, { label, home: root }), {
      mode: 0o600,
    });
    const service = macLaunchAgent({ label });

    try {
      service.installAndStart(paths.launchAgent);
      await waitFor(() => service.inspect().process === "running");
      await waitFor(() => existsSync(join(paths.runtimeRoot, "endpoint.json")));

      const duplicate = Bun.spawnSync([process.execPath, daemonMain], {
        env: {
          ...process.env,
          KOJO_MANAGED_INSTALLATION: installationRoot,
          KOJO_DAEMON_DATA: paths.dataRoot,
          KOJO_DAEMON_RUNTIME: paths.runtimeRoot,
        },
      });
      expect(duplicate.exitCode).not.toBe(0);

      service.disable(false);
      expect(service.inspect()).toMatchObject({
        automaticStart: "disabled",
        manager: "loaded",
        process: "running",
      });
      service.disable(true);
      await waitFor(() => service.inspect().manager === "unloaded");
      service.start(paths.launchAgent);
      await waitFor(() => service.inspect().process === "running");
      expect(service.inspect().automaticStart).toBe("disabled");
      service.enable();
      service.stop();
      await waitFor(() => service.inspect().manager === "unloaded");
      expect(existsSync(join(paths.runtimeRoot, "endpoint.json"))).toBe(false);
    } finally {
      try {
        service.enable();
        service.stop();
      } catch {
        // The unique test service can already be absent. The private root is still removed below.
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});
