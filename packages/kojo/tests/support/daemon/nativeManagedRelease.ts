import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DaemonPaths } from "../../../src/contexts/daemon/models/DaemonPaths.ts";

const releaseId = "native-host-evidence";

export const writeNativeManagedRelease = (
  paths: DaemonPaths,
  daemonMain: string,
  options: { readonly childProcessIdPath?: string } = {},
): void => {
  const releaseRoot = join(paths.installationRoot, "releases", releaseId);
  const consoleRoot = join(releaseRoot, "console");
  mkdirSync(join(paths.installationRoot, "bin"), { recursive: true, mode: 0o700 });
  mkdirSync(consoleRoot, { recursive: true, mode: 0o700 });
  writeFileSync(join(consoleRoot, "index.html"), "<!doctype html><title>Kojo evidence</title>\n", {
    mode: 0o600,
  });
  writeFileSync(
    join(releaseRoot, "release.json"),
    `${JSON.stringify({
      formatVersion: 1,
      releaseId,
      kojoVersion: "native-host-evidence",
      bunVersion: Bun.version,
    })}\n`,
    { mode: 0o600 },
  );
  writeFileSync(join(paths.installationRoot, "active-release"), `${releaseId}\n`, { mode: 0o600 });
  const child =
    options.childProcessIdPath === undefined
      ? ""
      : (() => {
          mkdirSync(paths.dataRoot, { recursive: true, mode: 0o700 });
          return `sleep 300 &\nprintf '%s\\n' "$!" > ${JSON.stringify(options.childProcessIdPath)}\n`;
        })();
  writeFileSync(
    paths.managedLauncher,
    `#!/bin/sh\n${child}exec ${JSON.stringify(process.execPath)} ${JSON.stringify(daemonMain)}\n`,
    { mode: 0o700 },
  );
  chmodSync(paths.managedLauncher, 0o700);
};
