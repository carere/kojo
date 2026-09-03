import { join, resolve } from "node:path";
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import { Effect } from "effect";
import { Command } from "effect/unstable/cli";
import type { DaemonPaths } from "../../../src/contexts/daemon/models/DaemonPaths.ts";
import { makeGateCommand } from "../../../src/contexts/gate/adapters/GateCommand.ts";

const root = resolve(process.argv[2] ?? "");
if (!root.startsWith("/tmp/") && !root.includes("/.kojo-gate-cli-")) {
  throw new Error("an isolated Gate CLI test root is required");
}
process.argv.splice(2, 1);

const installationRoot = join(root, "installation");
const paths: DaemonPaths = {
  installationRoot,
  dataRoot: join(root, "data"),
  configurationRoot: join(root, "config"),
  cacheRoot: join(root, "cache"),
  runtimeRoot: join(root, "runtime"),
  serviceDefinition: join(root, "LaunchAgents", "dev.kojo.test.plist"),
  managedCli: join(installationRoot, "bin", "kojo"),
  managedLauncher: join(installationRoot, "bin", "kojo-launcher"),
};

makeGateCommand(() => paths).pipe(
  Command.run({ version: "test" }),
  Effect.provide(BunServices.layer),
  BunRuntime.runMain,
);
