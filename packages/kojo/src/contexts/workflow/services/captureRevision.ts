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
  let index = 0;
  const skipQuoted = (quote: string): void => {
    index += 1;
    while (index < source.length) {
      if (source[index] === "\\") index += 2;
      else if (source[index] === quote) {
        index += 1;
        return;
      } else index += 1;
    }
  };
  while (index < source.length) {
    const character = source[index];
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
  return { relatives, packages };
};

const sourceClosure = (
  factory: string,
  entry: string,
): {
  readonly files: ReadonlyArray<string>;
  readonly packages: ReadonlyArray<{ readonly specifier: string; readonly from: string }>;
} => {
  const factoryReal = realpathSync(factory);
  const pending = [entry];
  const files = new Set<string>();
  const packages: Array<{ readonly specifier: string; readonly from: string }> = [];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) continue;
    const selected = realpathSync(current);
    const pathFromFactory = relative(factoryReal, selected);
    if (pathFromFactory === ".." || pathFromFactory.startsWith(`..${sep}`)) {
      throw captureError(
        "WORKFLOW_INVALID",
        `${current} resolves outside .kojo`,
        "Keep every relative Factory source import below `.kojo`.",
      );
    }
    if (lstatSync(current).isSymbolicLink()) {
      throw captureError(
        "WORKFLOW_INVALID",
        `${current} is a symbolic link`,
        "Replace Factory source links with regular files below `.kojo`.",
      );
    }
    if (files.has(selected)) continue;
    files.add(selected);
    const scanned = scanImports(readFileSync(selected, "utf8"), posix(pathFromFactory));
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
      if (value.name === expected) return realpathSync(cursor);
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
    roots.set(root, { name: manifest.name, version: manifest.version, dependencies });
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
        throw new Error(
          `${metadata.name} cannot resolve required package ${dependency.name}: ${String(cause)}`,
        );
      }
    }
    dependencyRoots.set(root, resolved);
  }

  const nodes = [...roots.entries()].map(([root, metadata]): PackageNode => {
    const files = packageFiles(root);
    const identity = {
      name: metadata.name,
      version: metadata.version,
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

const copyCapturedFile = (source: string, destination: string, mode: number): void => {
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  copyFileSync(source, destination);
  chmodSync(destination, mode);
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
  ["factory.json", "tsconfig.json"]
    .map((name) => join(factory, name))
    .filter(existsSync)
    .sort();

const declaredAssets = (factory: string): ReadonlyArray<string> => {
  const manifestPath = join(factory, "factory.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    readonly formatVersion?: number;
    readonly assets?: ReadonlyArray<unknown>;
  };
  if (manifest.formatVersion !== 1 || !Array.isArray(manifest.assets)) {
    throw captureError(
      "FACTORY_INVALID",
      `${manifestPath} is not a format-version 1 Factory asset declaration`,
      "Set `formatVersion` to 1 and declare an `assets` array.",
    );
  }
  return manifest.assets.map((value) => {
    if (typeof value !== "string" || value === "" || isAbsolute(value) || credentialPath(value)) {
      throw captureError(
        "FACTORY_INVALID",
        `${String(value)} cannot be captured as a Factory asset`,
        "Declare only credential-free relative asset paths below `.kojo`.",
      );
    }
    const target = resolve(factory, value);
    const real = realpathSync(target);
    const boundary = relative(realpathSync(factory), real);
    if (
      boundary === ".." ||
      boundary.startsWith(`..${sep}`) ||
      lstatSync(target).isSymbolicLink()
    ) {
      throw captureError(
        "FACTORY_INVALID",
        `${value} leaves the Factory asset boundary or is linked`,
        "Use a regular file below `.kojo` for each Factory asset.",
      );
    }
    return real;
  });
};

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
      const sources = closure.files.map((path) => fileEvidence(factory, path));
      const assetPaths = declaredAssets(factory);
      const assets = assetPaths.map((path) => fileEvidence(factory, path));
      const sharedPaths = sharedConfiguration(factory);
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
      for (const [path, evidence] of closure.files.map(
        (path, index) => [path, sources[index]] as const,
      )) {
        if (evidence !== undefined)
          copyCapturedFile(
            path,
            join(stagedRevision, "factory", "sources", evidence.path),
            evidence.mode,
          );
      }
      for (const [path, evidence] of assetPaths.map(
        (path, index) => [path, assets[index]] as const,
      )) {
        if (evidence !== undefined)
          copyCapturedFile(
            path,
            join(stagedRevision, "factory", "assets", evidence.path),
            evidence.mode,
          );
      }
      for (const [path, evidence] of sharedPaths.map(
        (path, index) => [path, shared[index]] as const,
      )) {
        if (evidence !== undefined)
          copyCapturedFile(
            path,
            join(stagedRevision, "factory", "shared", evidence.path),
            evidence.mode,
          );
      }
      for (const node of graph.nodes) {
        for (const file of node.files) {
          copyCapturedFile(
            file.source,
            join(stagedRevision, "packages", node.packageId, file.path),
            file.mode,
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
      const secondSources = closure.files.map((path) => fileEvidence(factory, path));
      const secondAssets = assetPaths.map((path) => fileEvidence(factory, path));
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
