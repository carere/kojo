import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ConsoleRelease } from "../models/ConsoleRelease.ts";
import type { DaemonPaths } from "../models/DaemonPaths.ts";
import { LifecycleError } from "../models/LifecycleError.ts";
import { assertPrivateNode } from "./secureHostPath.ts";

interface ReleaseManifest {
  readonly formatVersion?: number;
  readonly releaseId?: string;
  readonly kojoVersion?: string;
  readonly bunVersion?: string;
}

export const activeConsoleRelease = (paths: DaemonPaths): ConsoleRelease => {
  const activePath = join(paths.installationRoot, "active-release");
  assertPrivateNode(activePath, "file");
  const releaseId = readFileSync(activePath, "utf8").trim();
  if (
    releaseId.length === 0 ||
    releaseId === "." ||
    releaseId === ".." ||
    !/^[A-Za-z0-9._-]+$/.test(releaseId)
  ) {
    throw new LifecycleError("ACTIVE_RELEASE_INVALID", "the active release identity is invalid");
  }

  const release = join(paths.installationRoot, "releases", releaseId);
  const manifestPath = join(release, "release.json");
  const assets = join(release, "console");
  assertPrivateNode(release, "directory");
  assertPrivateNode(manifestPath, "file");
  assertPrivateNode(assets, "directory");

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ReleaseManifest;
  if (
    (manifest.formatVersion !== 1 && manifest.formatVersion !== 2) ||
    manifest.releaseId !== releaseId ||
    typeof manifest.kojoVersion !== "string" ||
    manifest.kojoVersion.length === 0 ||
    typeof manifest.bunVersion !== "string" ||
    manifest.bunVersion.length === 0
  ) {
    throw new LifecycleError("ACTIVE_RELEASE_INVALID", "the active release manifest is invalid");
  }
  assertPrivateNode(join(assets, "index.html"), "file");

  return {
    assets,
    bunVersion: manifest.bunVersion,
    packageVersion: manifest.kojoVersion,
    releaseId,
  };
};
