import { join, resolve } from "node:path";
import type { DaemonPaths } from "../../../src/contexts/daemon/models/DaemonPaths.ts";
import { launchConsole } from "../../../src/contexts/daemon/services/launchConsole.ts";

const root = resolve(process.argv[2] ?? "");
if (!root.startsWith("/tmp/")) throw new Error("a private test root is required");
const installationRoot = join(root, "installation");
const paths: DaemonPaths = {
  installationRoot,
  dataRoot: join(root, "data"),
  runtimeRoot: join(root, "runtime"),
  launchAgent: join(root, "LaunchAgents", "dev.kojo.test.plist"),
  managedCli: join(installationRoot, "bin", "kojo"),
  managedLauncher: join(installationRoot, "bin", "kojo-launcher"),
};
const url = await launchConsole(paths, { open: () => undefined }, true);
process.stdout.write(url);
