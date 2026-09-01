import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { isAbsolute, join, normalize, relative } from "node:path";
import { RevisionCaptureError } from "../../workflow/models/RevisionCaptureError.ts";
import type { RevisionManifest } from "../../workflow/models/RevisionManifest.ts";
import { canonicalJson } from "../../workflow/services/canonicalJson.ts";

export interface MaterializedRevision {
  readonly root: string;
  readonly runner: string;
  readonly manifest: RevisionManifest;
  readonly dispose: () => void;
}

const inside = (root: string, path: string): boolean => {
  const child = relative(root, path);
  return child !== ".." && !child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`);
};

/** Materialize one exact retained graph without a registry, install script, or live package link. */
export const materializeRevision = (options: {
  readonly retainedRoot: string;
  readonly executionRoot: string;
  readonly revisionId: string;
  readonly packageGraphId: string;
}): MaterializedRevision => {
  const manifest = JSON.parse(
    readFileSync(join(options.retainedRoot, "manifest.json"), "utf8"),
  ) as RevisionManifest;
  const sha256 = (value: string): string =>
    new Bun.CryptoHasher("sha256").update(value).digest("hex");
  if (
    manifest.formatVersion !== 1 ||
    sha256(canonicalJson(manifest)) !== options.revisionId ||
    sha256(canonicalJson({ packages: manifest.packages, resolution: manifest.resolution })) !==
      options.packageGraphId ||
    manifest.compatibility.os !== process.platform ||
    manifest.compatibility.arch !== process.arch ||
    !manifest.runtime.protocols.includes(1)
  ) {
    throw new RevisionCaptureError({
      code: "CAPTURE_FAILED",
      message: "the retained Workflow Revision is not compatible with this Runner Host",
      remedy: "Use the exact supported Host and Project runtime recorded by this revision.",
    });
  }
  const root = join(options.executionRoot, `${options.revisionId}-${crypto.randomUUID()}`);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  try {
    const source = join(options.retainedRoot, "factory", "sources");
    if (!existsSync(source)) throw new Error("the retained Factory source is missing");
    cpSync(source, join(root, ".kojo"), { recursive: true, errorOnExist: true });
    for (const entry of manifest.packages) {
      const target = join(root, "node_modules", ...entry.name.split("/"));
      const retainedPackage = join(options.retainedRoot, "packages", entry.packageId);
      if (!inside(options.retainedRoot, retainedPackage))
        throw new Error("a package escaped retention");
      mkdirSync(join(target, ".."), { recursive: true, mode: 0o700 });
      cpSync(retainedPackage, target, { recursive: true, errorOnExist: true });
    }
    const runtimePackage = manifest.packages.find(
      (entry) => entry.packageId === manifest.runtime.packageId,
    );
    if (runtimePackage === undefined) throw new Error("the exact Project runtime is not retained");
    const runtimeRoot = join(root, "node_modules", ...runtimePackage.name.split("/"));
    const runtimeManifestBytes = readFileSync(join(runtimeRoot, "runtime-manifest.json"));
    if (
      new Bun.CryptoHasher("sha256").update(runtimeManifestBytes).digest("hex") !==
      manifest.runtime.manifestHash
    ) {
      throw new Error("the retained Project runtime manifest does not match the pinned revision");
    }
    const runtimeManifest = JSON.parse(runtimeManifestBytes.toString("utf8")) as {
      readonly runnerProtocols?: ReadonlyArray<number>;
      readonly requiredFeatures?: ReadonlyArray<string>;
      readonly bun?: { readonly minimum?: string };
      readonly hosts?: ReadonlyArray<string>;
    };
    if (
      !runtimeManifest.runnerProtocols?.includes(1) ||
      (runtimeManifest.requiredFeatures?.length ?? 0) > 0 ||
      !runtimeManifest.hosts?.includes(process.platform) ||
      typeof runtimeManifest.bun?.minimum !== "string" ||
      !Bun.semver.satisfies(Bun.version, `>=${runtimeManifest.bun.minimum}`)
    ) {
      throw new Error("the static Project runtime contract is incompatible before Runner start");
    }
    const runner = normalize(join(runtimeRoot, manifest.runtime.runner));
    if (!inside(root, runner) || !existsSync(runner) || isAbsolute(manifest.runtime.runner)) {
      throw new Error("the retained Runner entry escapes its exact package");
    }
    return {
      root,
      runner,
      manifest,
      dispose: () => rmSync(root, { recursive: true, force: true }),
    };
  } catch (cause) {
    rmSync(root, { recursive: true, force: true });
    throw cause;
  }
};
