import { chmodSync, cpSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { DaemonPaths } from "../../../src/contexts/daemon/models/DaemonPaths.ts";
import { atomicPrivateFile } from "../../../src/contexts/daemon/services/secureHostPath.ts";

const makePrivate = (path: string): void => {
  const stat = lstatSync(path);
  if (stat.isDirectory()) {
    chmodSync(path, 0o700);
    for (const child of readdirSync(path)) makePrivate(join(path, child));
  } else {
    chmodSync(path, 0o600);
  }
};

export const publishConsoleRelease = (
  paths: DaemonPaths,
  options: { readonly assets?: string; readonly releaseId?: string } = {},
): void => {
  const releaseId = options.releaseId ?? "kojo-test";
  const release = join(paths.installationRoot, "releases", releaseId);
  const consoleAssets = join(release, "console");
  mkdirSync(consoleAssets, { recursive: true, mode: 0o700 });
  if (options.assets === undefined) {
    atomicPrivateFile(
      join(consoleAssets, "index.html"),
      "<!doctype html><html><body>active managed Console</body></html>\n",
    );
  } else {
    cpSync(options.assets, consoleAssets, { recursive: true });
    makePrivate(consoleAssets);
  }
  atomicPrivateFile(
    join(release, "release.json"),
    `${JSON.stringify({
      formatVersion: 1,
      releaseId,
      kojoVersion: "0.0.0-test",
      bunVersion: Bun.version,
      createdAt: new Date(0).toISOString(),
    })}\n`,
  );
  atomicPrivateFile(join(paths.installationRoot, "active-release"), `${releaseId}\n`);
};
