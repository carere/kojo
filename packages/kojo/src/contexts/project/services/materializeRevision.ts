import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import { RetainedContentFault } from "../../workflow/models/RetainedContentFault.ts";
import type {
  RevisionFile,
  RevisionManifest,
  RevisionPackage,
} from "../../workflow/models/RevisionManifest.ts";
import { canonicalJson } from "../../workflow/services/canonicalJson.ts";

export interface MaterializedRevision {
  readonly root: string;
  readonly runner: string;
  readonly manifest: RevisionManifest;
  readonly dispose: () => void;
}

const inside = (root: string, path: string): boolean => {
  const child = relative(root, path);
  return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
};

const hash = (bytes: Uint8Array | string): string =>
  new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

const fault = (
  code: RetainedContentFault["code"],
  message: string,
  remedy: string,
  cause?: unknown,
): RetainedContentFault => new RetainedContentFault({ code, message, remedy, cause });

const readManifest = (retainedRoot: string): RevisionManifest => {
  const path = join(retainedRoot, "manifest.json");
  if (!existsSync(path)) {
    throw fault(
      "RETAINED_CONTENT_MISSING",
      "the pinned Workflow Revision manifest is missing",
      "Restore the exact retained bytes, then run `kojo revision repair`.",
    );
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as RevisionManifest;
  } catch (cause) {
    throw fault(
      "RETAINED_CONTENT_CORRUPT",
      "the pinned Workflow Revision manifest is not valid JSON",
      "Restore the exact retained manifest bytes, then run `kojo revision repair`.",
      cause,
    );
  }
};

const sourceOf = (
  retainedRoot: string,
  category: "sources" | "assets" | "shared",
  file: RevisionFile,
): string => {
  const selected = join(retainedRoot, "factory", category, file.path);
  if (!inside(retainedRoot, selected) || !existsSync(selected)) {
    throw fault(
      "RETAINED_CONTENT_MISSING",
      `the pinned file ${file.path} is missing`,
      "Restore the exact retained bytes, then run `kojo revision repair`.",
    );
  }
  if (!lstatSync(selected).isFile() || hash(readFileSync(selected)) !== file.sha256) {
    throw fault(
      "RETAINED_CONTENT_CORRUPT",
      `the pinned file ${file.path} does not match its retained hash`,
      "Restore the exact retained bytes. Current Factory content cannot repair this Run.",
    );
  }
  return selected;
};

const packageSource = (
  retainedRoot: string,
  entry: RevisionPackage,
  file: RevisionFile,
): string => {
  const selected = join(retainedRoot, "packages", entry.packageId, file.path);
  if (!inside(retainedRoot, selected) || !existsSync(selected)) {
    throw fault(
      "RETAINED_CONTENT_MISSING",
      `the pinned package file ${entry.name}/${file.path} is missing`,
      "Restore the exact retained package bytes, then run `kojo revision repair`.",
    );
  }
  if (!lstatSync(selected).isFile() || hash(readFileSync(selected)) !== file.sha256) {
    throw fault(
      "RETAINED_CONTENT_CORRUPT",
      `the pinned package file ${entry.name}/${file.path} does not match its retained hash`,
      "Restore the exact retained package bytes. Kojo will not install or rebuild it.",
    );
  }
  return selected;
};

const copyFile = (source: string, target: string, mode: number): void => {
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  cpSync(source, target, { errorOnExist: true });
  chmodSync(target, mode);
  if (
    (lstatSync(target).mode & 0o777) !== mode ||
    hash(readFileSync(target)) !== hash(readFileSync(source))
  ) {
    throw fault(
      "RETAINED_CONTENT_CORRUPT",
      `the materialized file ${target} does not match its retained bytes or mode`,
      "Restore the exact retained bytes. Kojo will not rebuild the file.",
    );
  }
};

const packagePath = (nodeModules: string, name: string): string => {
  const target = join(nodeModules, ...name.split("/"));
  if (!inside(nodeModules, target)) {
    throw fault(
      "RETAINED_CONTENT_CORRUPT",
      `the retained package name ${name} escapes node_modules`,
      "Restore an exact valid retained manifest.",
    );
  }
  return target;
};

const linkPackage = (target: string, packageRoot: string): void => {
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  if (existsSync(target)) {
    if (realpathSync(target) !== realpathSync(packageRoot)) {
      throw fault(
        "RETAINED_CONTENT_CORRUPT",
        `two retained package identities resolve to ${target}`,
        "Restore an exact retained graph with one target for each package resolution.",
      );
    }
    return;
  }
  symlinkSync(relative(dirname(target), packageRoot), target, "dir");
};

/** Materialize one exact retained graph without a registry, install script, or live package link. */
export const materializeRevision = (options: {
  readonly retainedRoot: string;
  readonly executionRoot: string;
  readonly revisionId: string;
  readonly packageGraphId: string;
}): MaterializedRevision => {
  const manifest = readManifest(options.retainedRoot);
  if (
    manifest.formatVersion !== 1 ||
    hash(canonicalJson(manifest)) !== options.revisionId ||
    hash(canonicalJson({ packages: manifest.packages, resolution: manifest.resolution })) !==
      options.packageGraphId
  ) {
    throw fault(
      "RETAINED_CONTENT_CORRUPT",
      "the pinned Workflow Revision identity does not match its manifest",
      "Restore the exact retained manifest. Kojo will not substitute current content.",
    );
  }
  if (
    manifest.compatibility.os !== process.platform ||
    manifest.compatibility.arch !== process.arch
  ) {
    throw fault(
      "RETAINED_HOST_INCOMPATIBLE",
      `the pinned Workflow Revision needs ${manifest.compatibility.os}/${manifest.compatibility.arch}`,
      "Use the recorded Host and architecture. Kojo cannot rebuild a retained revision.",
    );
  }
  if (!manifest.runtime.protocols.includes(1)) {
    throw fault(
      "RETAINED_PROTOCOL_INCOMPATIBLE",
      "the pinned Project runtime has no protocol in common with this Daemon",
      "Activate a compatible managed Kojo release. Do not replace the pinned runtime.",
    );
  }
  const root = join(options.executionRoot, `${options.revisionId}-${crypto.randomUUID()}`);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  try {
    for (const [category, files] of [
      ["sources", manifest.sources],
      ["assets", manifest.assets],
      ["shared", manifest.sharedConfiguration],
    ] as const) {
      for (const file of files) {
        copyFile(
          sourceOf(options.retainedRoot, category, file),
          join(root, ".kojo", file.path),
          file.mode,
        );
      }
    }

    const packageById = new Map(
      manifest.packages.map((entry) => [entry.packageId, entry] as const),
    );
    const retainedPackages = join(root, ".kojo-retained", "packages");
    for (const entry of manifest.packages) {
      const target = join(retainedPackages, entry.packageId);
      for (const file of entry.files) {
        copyFile(
          packageSource(options.retainedRoot, entry, file),
          join(target, file.path),
          file.mode,
        );
      }
    }
    for (const resolution of manifest.resolution) {
      const targetPackage = packageById.get(resolution.targetPackageId);
      if (targetPackage === undefined) {
        throw fault(
          "RETAINED_CONTENT_CORRUPT",
          `the retained resolution ${resolution.specifier} has no target package`,
          "Restore an exact valid retained manifest.",
        );
      }
      const parentModules =
        resolution.fromPackageId === "factory"
          ? join(root, "node_modules")
          : join(retainedPackages, resolution.fromPackageId, "node_modules");
      if (resolution.fromPackageId !== "factory" && !packageById.has(resolution.fromPackageId)) {
        throw fault(
          "RETAINED_CONTENT_CORRUPT",
          `the retained resolution source ${resolution.fromPackageId} is missing`,
          "Restore an exact valid retained manifest.",
        );
      }
      linkPackage(
        packagePath(parentModules, targetPackage.name),
        join(retainedPackages, targetPackage.packageId),
      );
    }
    const runtimePackage = manifest.packages.find(
      (entry) => entry.packageId === manifest.runtime.packageId,
    );
    if (runtimePackage === undefined) {
      throw fault(
        "RETAINED_CONTENT_CORRUPT",
        "the exact Project runtime is not retained",
        "Restore the exact retained package graph.",
      );
    }
    const runtimeRoot = join(retainedPackages, runtimePackage.packageId);
    const runtimeManifestBytes = readFileSync(join(runtimeRoot, "runtime-manifest.json"));
    if (hash(runtimeManifestBytes) !== manifest.runtime.manifestHash) {
      throw fault(
        "RETAINED_CONTENT_CORRUPT",
        "the retained Project runtime manifest does not match the pinned revision",
        "Restore the exact retained Project runtime bytes.",
      );
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
      !runtimeManifest.hosts?.includes(process.platform)
    ) {
      throw fault(
        "RETAINED_PROTOCOL_INCOMPATIBLE",
        "the static Project runtime contract is incompatible before Runner start",
        "Activate a compatible managed Kojo release.",
      );
    }
    if (
      typeof runtimeManifest.bun?.minimum !== "string" ||
      !Bun.semver.satisfies(Bun.version, `>=${runtimeManifest.bun.minimum}`)
    ) {
      throw fault(
        "RETAINED_HOST_INCOMPATIBLE",
        `the pinned Project runtime needs Bun ${runtimeManifest.bun?.minimum ?? "unknown"}`,
        "Use a compatible managed Bun. Kojo will not provision another Bun for this Run.",
      );
    }
    const runner = normalize(join(runtimeRoot, manifest.runtime.runner));
    if (!inside(root, runner) || !existsSync(runner) || isAbsolute(manifest.runtime.runner)) {
      throw fault(
        "RETAINED_CONTENT_CORRUPT",
        "the retained Runner entry escapes its exact package",
        "Restore an exact valid retained runtime manifest.",
      );
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
