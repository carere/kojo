import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Effect } from "effect";
import { startDaemon } from "../../../src/contexts/daemon/adapters/DaemonOwner.ts";
import type { DaemonPaths } from "../../../src/contexts/daemon/models/DaemonPaths.ts";
import { publishConsoleRelease } from "./consoleRelease.ts";

const root = resolve(process.argv[2] ?? "");
const port = Number(process.argv[3]);
const assets = resolve(process.argv[4] ?? "");
const fixture = process.argv[5];
if (!root.startsWith("/tmp/") || !Number.isInteger(port) || port < 1) {
  throw new Error("usage: authenticatedConsoleServer.ts /tmp/ROOT PORT ASSETS");
}
rmSync(root, { recursive: true, force: true });
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
publishConsoleRelease(paths, { assets, releaseId: "kojo-browser-test" });
const daemon = startDaemon(paths, { consolePort: port });

if (fixture === "projects") {
  for (const [index, state] of ["missing", "invalid"].entries()) {
    const projectPath = join(root, `project-${state}`);
    mkdirSync(projectPath);
    const project = realpathSync(projectPath);
    execFileSync("git", ["init", "--initial-branch=main", project]);
    execFileSync("git", ["-C", project, "config", "user.email", "test@kojo.local"]);
    execFileSync("git", ["-C", project, "config", "user.name", "Kojo Test"]);
    writeFileSync(join(project, "README.md"), `${state}\n`);
    execFileSync("git", ["-C", project, "add", "README.md"]);
    execFileSync("git", ["-C", project, "commit", "-m", "test: initial"]);
    if (state === "invalid") mkdirSync(join(project, ".kojo"));
    const requestId = `browser-project-${index}`;
    const mutation = {
      mutationVersion: 1,
      requestId,
      dataIdentity: daemon.endpoint.dataIdentity,
      operation: "registerProject",
      target: {
        identityVersion: 1,
        kind: "daemonData",
        parts: [daemon.endpoint.dataIdentity],
      },
      arguments: { location: project },
      preconditions: {},
    };
    const prepared = await fetch(`http://localhost/api/v1/client-requests/${requestId}`, {
      unix: daemon.endpoint.socketPath,
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(mutation),
    });
    if (!prepared.ok) throw new Error(`fixture preparation failed: ${await prepared.text()}`);
    const committed = await fetch(`http://localhost/api/v1/client-requests/${requestId}/retry`, {
      unix: daemon.endpoint.socketPath,
      method: "POST",
    });
    if (!committed.ok) throw new Error(`fixture registration failed: ${await committed.text()}`);
  }
}

const stop = (): void => {
  void Effect.runPromise(daemon.stop).finally(() => rmSync(root, { recursive: true, force: true }));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await Effect.runPromise(daemon.stopped);
