import { mock } from "bun:test";
import { join, resolve } from "node:path";
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import { Effect } from "effect";
import { Command } from "effect/unstable/cli";
import type { DaemonPaths } from "../../../src/contexts/daemon/models/DaemonPaths.ts";

const root = resolve(process.argv[2] ?? "");
if (!root.startsWith("/tmp/") && !root.includes("/.kojo-cli-contract-")) {
  throw new Error("an isolated CLI contract test root is required");
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

const macPaths = new URL("../../../src/contexts/daemon/services/macPaths.ts", import.meta.url).href;
const linuxPaths = new URL("../../../src/contexts/daemon/services/linuxPaths.ts", import.meta.url)
  .href;
mock.module(macPaths, () => ({ macPaths: () => paths }));
mock.module(linuxPaths, () => ({ linuxPaths: () => paths }));

const { kojo, version } = await import("../../../src/cli/kojo.ts");

kojo.pipe(Command.run({ version }), Effect.provide(BunServices.layer), BunRuntime.runMain);
