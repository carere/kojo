import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { canonicalPackageName } from "../../shared/models/canonicalPackageName.ts";
import { RevisionCaptureError } from "../models/RevisionCaptureError.ts";
import type {
  CapturedWorkflowRevision,
  RevisionFile,
  RevisionManifest,
  RevisionPackage,
  RevisionResolution,
} from "../models/RevisionManifest.ts";
import { canonicalJson, sha256Text } from "./canonicalJson.ts";

interface RuntimeManifest {
  readonly manifestVersion: 1;
  readonly packageName: string;
  readonly packageVersion: string;
  readonly runner: string;
  readonly runnerProtocols: ReadonlyArray<number>;
  readonly requiredFeatures: ReadonlyArray<string>;
  readonly effectPeer: string;
  readonly bun: { readonly minimum: string };
  readonly hosts: ReadonlyArray<string>;
}

interface PackageNode {
  readonly root: string;
  readonly name: string;
  readonly version: string;
  readonly files: ReadonlyArray<RevisionFile & { readonly source: string }>;
  readonly dependencies: ReadonlyArray<{ readonly name: string; readonly root: string }>;
  readonly packageId: string;
}

interface ImportScan {
  readonly assets: ReadonlyArray<string>;
  readonly relatives: ReadonlyArray<string>;
  readonly packages: ReadonlyArray<string>;
}

const posix = (path: string): string => path.split(sep).join("/");
const sha256 = (bytes: Uint8Array): string =>
  new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

const captureError = (
  code: RevisionCaptureError["code"],
  message: string,
  remedy: string,
  cause?: unknown,
): RevisionCaptureError => new RevisionCaptureError({ code, message, remedy, cause });

const credentialPath = (path: string): boolean => {
  const parts = posix(path).toLowerCase().split("/");
  return parts.some(
    (part) =>
      [".ssh", ".aws", ".azure", ".gnupg", "auth.json"].includes(part) ||
      /\.(?:key|pem|p12|pfx|keystore)$/.test(part) ||
      part === ".npmrc" ||
      part === ".yarnrc" ||
      part === ".yarnrc.yml" ||
      part === "bunfig.toml" ||
      part === ".pypirc" ||
      part === ".netrc" ||
      part === "credentials" ||
      part === "credentials.json" ||
      part === ".env" ||
      part.startsWith(".env."),
  );
};

const fileEvidence = (root: string, source: string): RevisionFile => {
  const stat = statSync(source);
  if (!stat.isFile()) throw new Error(`${source} is not a regular file`);
  return {
    path: posix(relative(root, source)),
    sha256: sha256(readFileSync(source)),
    mode: stat.mode & 0o777,
  };
};

const scanImports = (source: string, path: string): ImportScan => {
  const specifiers = new Set(
    new Bun.Transpiler({ loader: "ts" }).scanImports(source).map((entry) => entry.path),
  );
  const assets: string[] = [];
  const trivia = String.raw`(?:\s|/\*[\s\S]*?\*/|//[^\n]*(?:\n|$))*`;
  const assetReference = new RegExp(
    String.raw`^new\b${trivia}URL\b${trivia}\(${trivia}(["'])([^"'\\\r\n]+)\1${trivia},${trivia}import${trivia}\.${trivia}meta${trivia}\.${trivia}url${trivia},?${trivia}\)`,
  );
  let index = 0;
  const skipQuoted = (quote: string): void => {
    index += 1;
    while (index < source.length) {
      if (quote === "`" && source[index] === "$" && source[index + 1] === "{") {
        index += 2;
        scanCode(true);
      } else if (source[index] === "\\") index += 2;
      else if (source[index] === quote) {
        index += 1;
        return;
      } else index += 1;
    }
  };
  const scanCode = (interpolation = false): void => {
    let braces = 0;
    while (index < source.length) {
      const character = source[index];
      if (interpolation && character === "}") {
        if (braces === 0) {
          index += 1;
          return;
        }
        braces -= 1;
      } else if (interpolation && character === "{") braces += 1;
      if (character === "/" && source[index + 1] === "/") {
        index = source.indexOf("\n", index + 2);
        if (index < 0) break;
        continue;
      }
      if (character === "/" && source[index + 1] === "*") {
        const end = source.indexOf("*/", index + 2);
        index = end < 0 ? source.length : end + 2;
        continue;
      }
      if (character === '"' || character === "'" || character === "`") {
        skipQuoted(character);
        continue;
      }
      const asset = /[\w$]/.test(source[index - 1] ?? "")
        ? null
        : source.slice(index).match(assetReference);
      if (asset?.[2] !== undefined) assets.push(asset[2]);
      const call = source.slice(index).match(/^(import|require)\b/);
      if (call?.[1] !== undefined) {
        let cursor = index + call[1].length;
        while (/\s/.test(source[cursor] ?? "")) cursor += 1;
        if (source[cursor] === "(") {
          cursor += 1;
          while (/\s/.test(source[cursor] ?? "")) cursor += 1;
          const quote = source[cursor];
          if (quote !== '"' && quote !== "'") {
            throw captureError(
              "WORKFLOW_INVALID",
              `${path} contains a computed ${call[1] === "import" ? "dynamic import" : "require"}`,
              "Use a literal relative or package specifier.",
            );
          }
        }
        index += call[1].length;
        continue;
      }
      index += 1;
    }
  };
  scanCode();

  const relatives: string[] = [];
  const packages: string[] = [];
  for (const specifier of [...specifiers].sort()) {
    if (/^(?:https?:|file:|data:|node:|bun:)/.test(specifier) || isAbsolute(specifier)) {
      if (specifier.startsWith("node:") || specifier.startsWith("bun:")) continue;
      throw captureError(
        "WORKFLOW_INVALID",
        `${path} imports ${specifier} outside the Factory capture boundary`,
        "Use a relative import below `.kojo` or an installed package import.",
      );
    }
    if (specifier.startsWith(".")) relatives.push(specifier);
    else packages.push(specifier);
  }
  return { relatives, packages, assets };
};

const sourceFile = (path: string): boolean => /\.[cm]?[jt]sx?$/.test(path);

const excludedFactoryPath = (path: string): boolean =>
  credentialPath(path) ||
  posix(path)
    .split("/")
    .some((part) => ["data", ".git", "node_modules"].includes(part));

/** Validate every path component before capture can read an authored input. */
const factoryFile = (factory: string, target: string): string => {
  const path = relative(factory, target);
  if (path === ".." || path.startsWith(`..${sep}`) || excludedFactoryPath(path)) {
    throw captureError(
      "WORKFLOW_INVALID",
      `${target} is excluded or outside the Factory`,
      "Reference a regular non-credential file below .kojo.",
    );
  }
  try {
    let current = factory;
    for (const part of path.split(sep)) {
      current = join(current, part);
      if (lstatSync(current).isSymbolicLink()) {
        throw captureError(
          "WORKFLOW_INVALID",
          `${target} is linked`,
          "Replace symbolic links with regular Factory files.",
        );
      }
    }
    if (!statSync(target).isFile()) throw new Error("not a regular file");
    return realpathSync(target);
  } catch (cause) {
    if (cause instanceof RevisionCaptureError) throw cause;
    throw captureError(
      "WORKFLOW_INVALID",
      `${target} is not a readable Factory file`,
      "Restore the referenced file or remove its code reference.",
      cause,
    );
  }
};

const sourceClosure = (
  factory: string,
  entry: string,
): {
  readonly files: ReadonlyArray<string>;
  readonly assets: ReadonlyArray<string>;
  readonly packages: ReadonlyArray<{ readonly specifier: string; readonly from: string }>;
} => {
  const factoryReal = realpathSync(factory);
  const pending = [entry];
  const files = new Set<string>();
  const assets = new Set<string>();
  const packages: Array<{ readonly specifier: string; readonly from: string }> = [];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) continue;
    const selected = factoryFile(factoryReal, current);
    const pathFromFactory = relative(factoryReal, selected);
    if (files.has(selected)) continue;
    files.add(selected);
    if (!sourceFile(selected)) {
      assets.add(selected);
      continue;
    }
    const scanned = scanImports(readFileSync(selected, "utf8"), posix(pathFromFactory));
    for (const reference of scanned.assets) {
      if (!(reference.startsWith("./") || reference.startsWith("../"))) {
        throw captureError(
          "WORKFLOW_INVALID",
          `${pathFromFactory} references a non-relative Factory asset`,
          "Use a literal relative URL below .kojo.",
        );
      }
      assets.add(factoryFile(factoryReal, resolve(dirname(selected), reference)));
    }
    for (const specifier of scanned.relatives) {
      let resolved: string;
      try {
        resolved = Bun.resolveSync(specifier, dirname(selected));
      } catch (cause) {
        throw captureError(
          "WORKFLOW_INVALID",
          `${pathFromFactory} cannot resolve ${specifier}`,
          "Fix the relative import and its TypeScript resolution configuration.",
          cause,
        );
      }
      pending.push(resolved);
    }
    for (const specifier of scanned.packages) packages.push({ specifier, from: selected });
  }
  return {
    files: [...files].sort(),
    assets: [...assets].sort(),
    packages: packages.sort((left, right) =>
      `${left.specifier}\0${left.from}`.localeCompare(`${right.specifier}\0${right.from}`),
    ),
  };
};

const packageNameOf = (specifier: string): string => {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? specifier);
};

const packageRootFor = (specifier: string, from: string): string => {
  const expected = packageNameOf(specifier);
  let search = dirname(from);
  let installed: string | undefined;
  while (true) {
    const candidate = join(search, "node_modules", ...expected.split("/"));
    if (existsSync(join(candidate, "package.json"))) {
      installed = realpathSync(candidate);
      break;
    }
    const parent = dirname(search);
    if (parent === search) break;
    search = parent;
  }
  if (specifier === expected && installed !== undefined) return installed;
  let resolved: string;
  try {
    resolved = Bun.resolveSync(specifier, dirname(from));
  } catch (cause) {
    if (expected !== "@carere/kojo-runtime") throw cause;
    resolved = Bun.resolveSync("@carere/kojo-runtime/runtime-manifest.json", dirname(from));
  }
  const entry = realpathSync(resolved);
  let cursor = statSync(entry).isDirectory() ? entry : dirname(entry);
  while (true) {
    const manifest = join(cursor, "package.json");
    if (existsSync(manifest)) {
      const value = JSON.parse(readFileSync(manifest, "utf8")) as { readonly name?: string };
      if (
        value.name !== undefined &&
        canonicalPackageName(value.name) === canonicalPackageName(expected)
      )
        return realpathSync(cursor);
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  throw new Error(`cannot find the installed ${expected} package root for ${specifier}`);
};

const packageFiles = (root: string): ReadonlyArray<RevisionFile & { readonly source: string }> => {
  const found: Array<RevisionFile & { readonly source: string }> = [];
  const visit = (directory: string, relativeDirectory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const path = join(directory, entry.name);
      const relativePath = posix(join(relativeDirectory, entry.name));
      if (credentialPath(relativePath)) continue;
      const link = lstatSync(path);
      if (link.isSymbolicLink()) {
        const material = realpathSync(path);
        if (statSync(material).isDirectory()) visit(material, relativePath);
        else
          found.push({
            ...fileEvidence(dirname(material), material),
            path: relativePath,
            source: material,
          });
      } else if (entry.isDirectory()) visit(path, relativePath);
      else if (entry.isFile()) found.push({ ...fileEvidence(root, path), source: path });
    }
  };
  visit(root, "");
  return found.sort((left, right) => left.path.localeCompare(right.path));
};

const packageGraph = (
  imports: ReadonlyArray<{ readonly specifier: string; readonly from: string }>,
  runtimeSource: string,
): {
  readonly nodes: ReadonlyArray<PackageNode>;
  readonly resolution: ReadonlyArray<RevisionResolution>;
  readonly roots: ReadonlyMap<string, PackageNode>;
} => {
  const rootImports = [...imports];
  for (const required of ["@carere/kojo-runtime", "effect"]) {
    rootImports.push({ specifier: required, from: runtimeSource });
  }
  const roots = new Map<
    string,
    {
      readonly name: string;
      readonly version: string;
      readonly dependencies: ReadonlyArray<{ readonly name: string; readonly optional: boolean }>;
    }
  >();
  const queue: string[] = [];
  const add = (specifier: string, from: string): string => {
    const root = packageRootFor(specifier, from);
    if (roots.has(root)) return root;
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      readonly name?: string;
      readonly version?: string;
      readonly dependencies?: Record<string, string>;
      readonly optionalDependencies?: Record<string, string>;
      readonly peerDependencies?: Record<string, string>;
      readonly peerDependenciesMeta?: Record<string, { readonly optional?: boolean }>;
    };
    if (typeof manifest.name !== "string" || typeof manifest.version !== "string") {
      throw new Error(`${join(root, "package.json")} has no package name or version`);
    }
    if (manifest.name === "@carere/kojo") {
      throw captureError(
        "WORKFLOW_INVALID",
        `the retained package graph includes the legacy @carere/kojo execution package through ${specifier}`,
        "Import all retained Workflow models and execution services from @carere/kojo-runtime. Keep @carere/kojo only in the host CLI installation.",
      );
    }
    const required = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}).filter(
        (name) => manifest.peerDependenciesMeta?.[name]?.optional !== true,
      ),
    ]);
    const optional = new Set([
      ...Object.keys(manifest.optionalDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}).filter(
        (name) => manifest.peerDependenciesMeta?.[name]?.optional === true,
      ),
    ]);
    const dependencies = [...new Set([...required, ...optional])]
      .sort()
      .map((name) => ({ name, optional: optional.has(name) && !required.has(name) }));
    roots.set(root, {
      name: canonicalPackageName(manifest.name),
      version: manifest.version,
      dependencies,
    });
    queue.push(root);
    return root;
  };

  const rootEdges = rootImports.map((entry) => ({
    specifier: entry.specifier,
    target: add(entry.specifier, entry.from),
  }));
  const dependencyRoots = new Map<
    string,
    Array<{ readonly name: string; readonly root: string }>
  >();
  while (queue.length > 0) {
    const root = queue.shift();
    if (root === undefined) continue;
    const metadata = roots.get(root);
    if (metadata === undefined) continue;
    const resolved: Array<{ readonly name: string; readonly root: string }> = [];
    for (const dependency of metadata.dependencies) {
      try {
        resolved.push({
          name: dependency.name,
          root: add(dependency.name, join(root, "package.json")),
        });
      } catch (cause) {
        if (dependency.optional) continue;
        if (cause instanceof RevisionCaptureError) throw cause;
        throw new Error(
          `${metadata.name} cannot resolve required package ${dependency.name}: ${String(cause)}`,
        );
      }
    }
    dependencyRoots.set(root, resolved);
  }

  const nodes = [...roots.entries()].map(([root, metadata], occurrence): PackageNode => {
    const files = packageFiles(root);
    const identity = {
      name: metadata.name,
      version: metadata.version,
      occurrence,
      files: files.map(({ source: _source, ...file }) => file),
    };
    return {
      root,
      name: metadata.name,
      version: metadata.version,
      files,
      dependencies: dependencyRoots.get(root) ?? [],
      packageId: sha256Text(canonicalJson(identity)),
    };
  });
  const byRoot = new Map(nodes.map((node) => [node.root, node] as const));
  const resolution: RevisionResolution[] = rootEdges.map((edge) => {
    const target = byRoot.get(edge.target);
    if (target === undefined) throw new Error("the root package resolution is incomplete");
    const name = packageNameOf(edge.specifier);
    return {
      fromPackageId: "factory",
      specifier: edge.specifier,
      targetPackageId: target.packageId,
      subpath: edge.specifier === name ? "." : `./${edge.specifier.slice(name.length + 1)}`,
    };
  });
  for (const node of nodes) {
    for (const dependency of node.dependencies) {
      const target = byRoot.get(dependency.root);
      if (target === undefined) throw new Error("the dependency package resolution is incomplete");
      resolution.push({
        fromPackageId: node.packageId,
        specifier: dependency.name,
        targetPackageId: target.packageId,
        subpath: ".",
      });
    }
  }
  return {
    nodes: nodes.sort((left, right) => left.packageId.localeCompare(right.packageId)),
    resolution: resolution.sort((left, right) =>
      `${left.fromPackageId}\0${left.specifier}\0${left.targetPackageId}`.localeCompare(
        `${right.fromPackageId}\0${right.specifier}\0${right.targetPackageId}`,
      ),
    ),
    roots: byRoot,
  };
};

const copyCapturedFile = (source: string, destination: string): void => {
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  copyFileSync(source, destination);
  // The manifest retains the authored executable mode. The Daemon store retains the same bytes
  // privately, and `materializeRevision` restores that authored mode in the Runner cache.
  chmodSync(destination, 0o600);
  const descriptor = openSync(destination, "r");
  fsyncSync(descriptor);
  closeSync(descriptor);
};

const fsyncDirectory = (directory: string): void => {
  const descriptor = openSync(directory, "r");
  fsyncSync(descriptor);
  closeSync(descriptor);
};

const publishObject = (source: string, hash: string, objects: string): void => {
  const destination = join(objects, hash);
  if (existsSync(destination)) {
    if (sha256(readFileSync(destination)) !== hash) {
      throw new Error(`existing object ${hash} is corrupt`);
    }
    return;
  }
  mkdirSync(objects, { recursive: true, mode: 0o700 });
  const temporary = join(objects, `.${hash}.${crypto.randomUUID()}.tmp`);
  copyFileSync(source, temporary);
  chmodSync(temporary, 0o600);
  const descriptor = openSync(temporary, "r");
  fsyncSync(descriptor);
  closeSync(descriptor);
  if (sha256(readFileSync(temporary)) !== hash)
    throw new Error(`object ${hash} failed verification`);
  renameSync(temporary, destination);
};

const lockEvidence = (project: string): ReadonlyArray<RevisionFile> =>
  ["bun.lock", "bun.lockb", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"]
    .map((name) => join(project, name))
    .filter(existsSync)
    .map((path) => fileEvidence(project, path))
    .sort((left, right) => left.path.localeCompare(right.path));

const sharedConfiguration = (factory: string): ReadonlyArray<string> =>
  ["tsconfig.json"]
    .map((name) => join(factory, name))
    .filter(existsSync)
    .sort();

const validateCopied = (root: string, files: ReadonlyArray<RevisionFile>): void => {
  for (const file of files) {
    const selected = join(root, file.path);
    if (sha256(readFileSync(selected)) !== file.sha256) {
      throw new Error(`${file.path} changed during retained-content validation`);
    }
  }
};

/** Capture and atomically publish one exact Project Workflow without executing it. */
export const captureWorkflowRevision = (options: {
  readonly project: string;
  readonly dataRoot: string;
  readonly workflowName: string;
}): CapturedWorkflowRevision => {
  const project = realpathSync(options.project);
  const factory = join(project, ".kojo");
  const entry = join(factory, "workflows", `${options.workflowName}.ts`);
  if (!existsSync(entry)) {
    throw captureError(
      "WORKFLOW_INVALID",
      `${entry} does not exist`,
      "Restore the top-level Workflow source or refresh it as Removed.",
    );
  }

  let lastCause: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const stageOwner = crypto.randomUUID();
    const stage = join(options.dataRoot, "staging", stageOwner);
    try {
      mkdirSync(stage, { recursive: true, mode: 0o700 });
      const closure = sourceClosure(factory, entry);
      const sourcePaths = closure.files.filter(sourceFile);
      const sources = sourcePaths.map((path) => fileEvidence(factory, path));
      const assetPaths = closure.assets;
      const assets = assetPaths.map((path) => fileEvidence(factory, path));
      const sharedPaths = sharedConfiguration(factory).map((path) =>
        factoryFile(realpathSync(factory), path),
      );
      const shared = sharedPaths.map((path) => fileEvidence(factory, path));
      const runtimeManifestPath = Bun.resolveSync(
        "@carere/kojo-runtime/runtime-manifest.json",
        project,
      );
      const runtimeManifest = JSON.parse(
        readFileSync(runtimeManifestPath, "utf8"),
      ) as RuntimeManifest;
      if (
        runtimeManifest.manifestVersion !== 1 ||
        runtimeManifest.packageName !== "@carere/kojo-runtime" ||
        !runtimeManifest.hosts.includes(process.platform)
      ) {
        throw new Error("the Project runtime manifest is incompatible with this Host");
      }
      const graph = packageGraph(closure.packages, runtimeManifestPath);
      const runtimeNode = [...graph.roots.values()].find(
        (node) => node.name === "@carere/kojo-runtime",
      );
      const effectNode = [...graph.roots.values()].find((node) => node.name === "effect");
      if (runtimeNode === undefined || effectNode === undefined) {
        throw new Error("the exact Project runtime and Effect packages were not captured");
      }
      const runtimeEffectRoot = packageRootFor("effect", join(runtimeNode.root, "package.json"));
      if (runtimeEffectRoot !== effectNode.root) {
        throw new Error(
          "the Project runtime and authored Factory do not resolve one Effect instance",
        );
      }
      const effectEntry = realpathSync(Bun.resolveSync("effect", project));
      const lockfiles = lockEvidence(project);
      const resolutionInputs = [
        fileEvidence(project, join(project, "package.json")),
        ...graph.nodes.map((node) => fileEvidence(node.root, join(node.root, "package.json"))),
      ].sort((left, right) =>
        `${left.path}\0${left.sha256}`.localeCompare(`${right.path}\0${right.sha256}`),
      );
      const packages: RevisionPackage[] = graph.nodes.map((node) => ({
        packageId: node.packageId,
        name: node.name,
        version: node.version,
        files: node.files.map(({ source: _source, ...file }) => file),
      }));
      const packageGraphId = sha256Text(canonicalJson({ packages, resolution: graph.resolution }));
      const manifest: RevisionManifest = {
        formatVersion: 1,
        workflowName: options.workflowName,
        entrySource: posix(relative(factory, entry)),
        sources,
        assets,
        sharedConfiguration: shared,
        packages,
        resolution: graph.resolution,
        runtime: {
          packageId: runtimeNode.packageId,
          manifestHash: sha256(readFileSync(runtimeManifestPath)),
          runner: runtimeManifest.runner,
          protocols: [...runtimeManifest.runnerProtocols],
          requiredFeatures: [...runtimeManifest.requiredFeatures],
        },
        sharedEffect: {
          packageId: effectNode.packageId,
          resolvedEntryHash: sha256(readFileSync(effectEntry)),
        },
        compatibility: {
          bun: Bun.version,
          os: process.platform,
          arch: process.arch,
          nativeContent: packages.some((entryPackage) =>
            entryPackage.files.some((file) =>
              [".node", ".so", ".dylib"].includes(extname(file.path)),
            ),
          ),
        },
        dependencyEvidence: {
          lockfileHashes: lockfiles,
          resolutionInputHashes: resolutionInputs,
        },
      };
      const revisionId = sha256Text(canonicalJson(manifest));
      const stagedRevision = join(stage, revisionId);
      for (const [path, evidence] of sourcePaths.map(
        (path, index) => [path, sources[index]] as const,
      )) {
        if (evidence !== undefined)
          copyCapturedFile(path, join(stagedRevision, "factory", "sources", evidence.path));
      }
      for (const [path, evidence] of assetPaths.map(
        (path, index) => [path, assets[index]] as const,
      )) {
        if (evidence !== undefined)
          copyCapturedFile(path, join(stagedRevision, "factory", "assets", evidence.path));
      }
      for (const [path, evidence] of sharedPaths.map(
        (path, index) => [path, shared[index]] as const,
      )) {
        if (evidence !== undefined)
          copyCapturedFile(path, join(stagedRevision, "factory", "shared", evidence.path));
      }
      for (const node of graph.nodes) {
        for (const file of node.files) {
          copyCapturedFile(
            file.source,
            join(stagedRevision, "packages", node.packageId, file.path),
          );
        }
      }
      validateCopied(join(stagedRevision, "factory", "sources"), sources);
      validateCopied(join(stagedRevision, "factory", "assets"), assets);
      validateCopied(join(stagedRevision, "factory", "shared"), shared);
      for (const node of graph.nodes) {
        validateCopied(
          join(stagedRevision, "packages", node.packageId),
          node.files.map(({ source: _source, ...file }) => file),
        );
        for (const file of node.files) {
          const current = fileEvidence(dirname(file.source), file.source);
          if (current.sha256 !== file.sha256 || current.mode !== file.mode) {
            throw new Error(`${node.name}/${file.path} changed during capture`);
          }
        }
      }
      const secondSources = sourceClosure(factory, entry)
        .files.filter(sourceFile)
        .map((path) => fileEvidence(factory, path));
      const secondAssets = sourceClosure(factory, entry).assets.map((path) =>
        fileEvidence(factory, path),
      );
      const secondShared = sharedPaths.map((path) => fileEvidence(factory, path));
      if (
        canonicalJson([sources, assets, shared]) !==
        canonicalJson([secondSources, secondAssets, secondShared])
      ) {
        throw new Error("Factory inputs changed during capture");
      }
      const objects = join(options.dataRoot, "objects");
      for (const [directory, files] of [
        [join(stagedRevision, "factory", "sources"), sources],
        [join(stagedRevision, "factory", "assets"), assets],
        [join(stagedRevision, "factory", "shared"), shared],
      ] as const) {
        for (const file of files) publishObject(join(directory, file.path), file.sha256, objects);
      }
      for (const node of graph.nodes) {
        for (const file of node.files) {
          publishObject(
            join(stagedRevision, "packages", node.packageId, file.path),
            file.sha256,
            objects,
          );
        }
      }
      fsyncDirectory(objects);
      const manifestPath = join(stagedRevision, "manifest.json");
      mkdirSync(stagedRevision, { recursive: true, mode: 0o700 });
      writeFileSync(manifestPath, `${canonicalJson(manifest)}\n`, { mode: 0o600 });
      const descriptor = openSync(manifestPath, "r");
      fsyncSync(descriptor);
      closeSync(descriptor);
      fsyncDirectory(stagedRevision);
      const revisions = join(options.dataRoot, "revisions");
      mkdirSync(revisions, { recursive: true, mode: 0o700 });
      const publishedPath = join(revisions, revisionId);
      if (!existsSync(publishedPath)) renameSync(stagedRevision, publishedPath);
      fsyncDirectory(revisions);
      rmSync(stage, { recursive: true, force: true });
      return { revisionId, packageGraphId, manifest, publishedPath };
    } catch (cause) {
      lastCause = cause;
      rmSync(stage, { recursive: true, force: true });
      if (cause instanceof RevisionCaptureError && cause.code !== "REFRESH_UNSTABLE") throw cause;
    }
  }
  throw captureError(
    "REFRESH_UNSTABLE",
    `Factory inputs did not stay stable for ${options.workflowName}`,
    "Finish the Factory edit. Kojo will retry after the next settled refresh interval.",
    lastCause,
  );
};
