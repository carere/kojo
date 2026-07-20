import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { chmod, mkdtemp, readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { SystemStore } from "./storage";

export const PROJECT_SOURCE_COMPATIBILITY = Object.freeze({
  bun: "1.3.14",
  effect: "4.0.0-beta.98",
  kojo: "0.1.0",
  platformBun: "4.0.0-beta.98",
  typesBun: "1.3.14",
  typescript: "7.0.2",
  workflowAbi: "1",
} as const);

export type ProjectSourcePolicy = "LocalWithFreshnessWarning" | "RemoteLatest";

export type ProjectSourceDiagnosticCode =
  | "AUTHORED_COMMONJS"
  | "COMPUTED_IMPORT"
  | "CONFIG_LOAD_FAILED"
  | "CUSTOM_LOADER"
  | "DEPENDENCY_INSTALL_FAILED"
  | "DEFAULT_BRANCH_NOT_FOUND"
  | "ENTRY_POINT_NOT_FOUND"
  | "INCOMPATIBLE_BUN"
  | "INCOMPATIBLE_CLI"
  | "INCOMPATIBLE_EFFECT"
  | "INCOMPATIBLE_PLATFORM_BUN"
  | "INCOMPATIBLE_TYPES_BUN"
  | "INCOMPATIBLE_TYPESCRIPT"
  | "INCOMPATIBLE_WORKFLOW"
  | "INVALID_CONFIG"
  | "INVALID_LOCKFILE"
  | "INVALID_PACKAGE_MANIFEST"
  | "LOCAL_DEPENDENCY_OUTSIDE_WORKTREE"
  | "MODULE_NOT_FOUND"
  | "NATIVE_ADDON"
  | "REMOTE_FETCH_FAILED"
  | "REMOTE_IMPORT"
  | "REMOTE_NOT_CONFIGURED"
  | "UNSUPPORTED_MODULE";

export interface ProjectSourceDiagnostic {
  readonly code: ProjectSourceDiagnosticCode;
  readonly message: string;
  readonly path?: string;
  readonly specifier?: string;
}

export class ProjectSourceValidationError extends Error {
  readonly _tag = "ProjectSourceValidationError";

  constructor(readonly diagnostics: ReadonlyArray<ProjectSourceDiagnostic>) {
    super(diagnostics.map(({ code, message }) => `${code}: ${message}`).join("\n"));
    this.name = "ProjectSourceValidationError";
  }
}

export interface LoadedWorkflow {
  readonly entryPoint: string;
  readonly name: string;
  readonly version: string;
}

export interface LoadedSchedule {
  readonly cron: string;
  readonly input: unknown;
  readonly missedTimePolicy: "catch-up-once" | "skip";
  readonly name: string;
  readonly timezone: string;
  readonly workflow: string;
}

export interface LoadedRegistry {
  readonly configPath: string;
  readonly schedules: ReadonlyArray<LoadedSchedule>;
  readonly workflows: ReadonlyArray<LoadedWorkflow>;
}

export interface WorkflowClosureManifest {
  readonly entryPoint: string;
  readonly lockfileResolutions: ReadonlyArray<{
    readonly package: string;
    readonly resolution: unknown;
  }>;
  readonly modules: ReadonlyArray<{ readonly digest: string; readonly path: string }>;
  readonly resolver: { readonly conditions: ReadonlyArray<string>; readonly identity: string };
  readonly toolchain: ToolchainEvidence;
  readonly workflowAbi: string;
}

export interface ActivatedWorkflowRevision extends LoadedWorkflow {
  readonly fingerprint: string;
  readonly manifest: WorkflowClosureManifest;
}

export interface ToolchainEvidence {
  readonly bun: string;
  readonly cli: string;
  readonly effect: string;
  readonly platformBun: string;
  readonly typesBun: string;
  readonly typescript: string;
  readonly workflow: string;
  readonly workflowAbi: string;
}

export interface ProjectSourceRevision {
  readonly commit: string;
  readonly configPath: string;
  readonly freshness: {
    readonly localCommit: string;
    readonly remoteCommit?: string;
    readonly status: "Ahead" | "Behind" | "Current" | "Diverged" | "Unknown";
    readonly warning?: string;
  };
  readonly lockfileDigest: string;
  readonly policy: ProjectSourcePolicy;
  readonly provenance: {
    readonly defaultBranch: string;
    readonly remote: string | null;
    readonly repository: string;
    readonly selectedAt: string;
  };
  readonly schedules: ReadonlyArray<LoadedSchedule>;
  readonly toolchain: ToolchainEvidence;
  readonly workflows: ReadonlyArray<ActivatedWorkflowRevision>;
}

export interface ProjectSourceActivationOptions {
  readonly loadRegistry?: (checkout: string, configPath: string) => Promise<LoadedRegistry>;
  readonly policy: ProjectSourcePolicy;
  readonly repository: string;
}

interface GitResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

const runGitResult = async (
  repository: string,
  ...arguments_: ReadonlyArray<string>
): Promise<GitResult> => {
  const child = Bun.spawn(["git", "-C", repository, ...arguments_], {
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  return { exitCode, stderr: stderr.trim(), stdout: stdout.trim() };
};

const runGit = async (repository: string, ...arguments_: ReadonlyArray<string>) => {
  const result = await runGitResult(repository, ...arguments_);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || `git ${arguments_.join(" ")} failed`);
  }
  return result.stdout;
};

const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

const diagnostic = (
  code: ProjectSourceDiagnosticCode,
  message: string,
  details: Pick<ProjectSourceDiagnostic, "path" | "specifier"> = {},
): ProjectSourceDiagnostic => ({ code, message, ...details });

const defaultBranch = async (repository: string) => {
  const remoteHead = await runGitResult(
    repository,
    "symbolic-ref",
    "--short",
    "refs/remotes/origin/HEAD",
  );
  if (remoteHead.exitCode === 0 && remoteHead.stdout.startsWith("origin/")) {
    return remoteHead.stdout.slice("origin/".length);
  }
  for (const candidate of ["main", "master"]) {
    if (
      (await runGitResult(repository, "show-ref", "--verify", `refs/heads/${candidate}`))
        .exitCode === 0
    ) {
      return candidate;
    }
  }
  const current = await runGitResult(repository, "symbolic-ref", "--short", "HEAD");
  if (current.exitCode === 0 && current.stdout.length > 0) return current.stdout;
  throw new ProjectSourceValidationError([
    diagnostic(
      "DEFAULT_BRANCH_NOT_FOUND",
      "The repository default branch could not be determined.",
    ),
  ]);
};

const relation = async (repository: string, local: string, remote: string) => {
  if (local === remote) return "Current" as const;
  const localAncestor = await runGitResult(
    repository,
    "merge-base",
    "--is-ancestor",
    local,
    remote,
  );
  if (localAncestor.exitCode === 0) return "Behind" as const;
  const remoteAncestor = await runGitResult(
    repository,
    "merge-base",
    "--is-ancestor",
    remote,
    local,
  );
  return remoteAncestor.exitCode === 0 ? ("Ahead" as const) : ("Diverged" as const);
};

const selectSource = async (repository: string, policy: ProjectSourcePolicy) => {
  const branch = await defaultBranch(repository);
  const localCommit = await runGit(repository, "rev-parse", `refs/heads/${branch}`);
  const remotes = (await runGit(repository, "remote")).split("\n").filter(Boolean);
  const remote = remotes.includes("origin") ? "origin" : (remotes[0] ?? null);
  if (remote === null) {
    if (policy === "RemoteLatest") {
      throw new ProjectSourceValidationError([
        diagnostic("REMOTE_NOT_CONFIGURED", "RemoteLatest requires a configured Git remote."),
      ]);
    }
    return {
      branch,
      commit: localCommit,
      freshness: {
        localCommit,
        status: "Unknown" as const,
        warning: "Remote freshness is unknown because no Git remote is configured.",
      },
      remote,
    };
  }

  const fetch = await runGitResult(repository, "fetch", "--prune", remote);
  if (fetch.exitCode !== 0) {
    if (policy === "RemoteLatest") {
      throw new ProjectSourceValidationError([
        diagnostic(
          "REMOTE_FETCH_FAILED",
          `RemoteLatest could not fetch ${remote}: ${fetch.stderr}`,
        ),
      ]);
    }
    return {
      branch,
      commit: localCommit,
      freshness: {
        localCommit,
        status: "Unknown" as const,
        warning: `Remote freshness could not be refreshed from ${remote}.`,
      },
      remote,
    };
  }
  const remoteReference = `refs/remotes/${remote}/${branch}`;
  const remoteResult = await runGitResult(repository, "rev-parse", "--verify", remoteReference);
  if (remoteResult.exitCode !== 0) {
    if (policy === "RemoteLatest") {
      throw new ProjectSourceValidationError([
        diagnostic("REMOTE_FETCH_FAILED", `RemoteLatest requires ${remoteReference}.`),
      ]);
    }
    return {
      branch,
      commit: localCommit,
      freshness: {
        localCommit,
        status: "Unknown" as const,
        warning: `The remote default branch ${remoteReference} was not found.`,
      },
      remote,
    };
  }
  const remoteCommit = remoteResult.stdout;
  return {
    branch,
    commit: policy === "RemoteLatest" ? remoteCommit : localCommit,
    freshness: {
      localCommit,
      remoteCommit,
      status: await relation(repository, localCommit, remoteCommit),
    },
    remote,
  };
};

const makeMutableCheckout = async (repository: string, commit: string) => {
  const parent = await mkdtemp(join(tmpdir(), "kojo-source-revision-"));
  const path = join(parent, "checkout");
  try {
    await runGit(repository, "worktree", "add", "--detach", "--no-checkout", path, commit);
    await runGit(path, "checkout", "--detach", commit);
    return {
      dispose: async () => {
        await runGitResult(repository, "worktree", "remove", "--force", path);
        await rm(parent, { force: true, recursive: true });
      },
      parent,
      path,
    };
  } catch (error) {
    await rm(parent, { force: true, recursive: true });
    throw error;
  }
};

interface PackageManifest {
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
  readonly engines?: { readonly bun?: string };
  readonly exports?: unknown;
  readonly main?: string;
  readonly module?: string;
  readonly name?: string;
  readonly type?: string;
  readonly version?: string;
}

const readJson = async <A>(path: string, code: ProjectSourceDiagnosticCode): Promise<A> => {
  try {
    return JSON.parse(await readFile(path, "utf8")) as A;
  } catch {
    throw new ProjectSourceValidationError([
      diagnostic(code, `${relative(process.cwd(), path)} is missing or invalid.`),
    ]);
  }
};

const dependencyVersion = (manifest: PackageManifest, name: string) =>
  manifest.dependencies?.[name] ?? manifest.devDependencies?.[name];

const validateToolchain = async (checkout: string) => {
  const manifest = await readJson<PackageManifest>(
    join(checkout, "package.json"),
    "INVALID_PACKAGE_MANIFEST",
  );
  const lockfilePath = join(checkout, "bun.lock");
  const lockfileText = await readFile(lockfilePath, "utf8").catch(() => undefined);
  if (lockfileText === undefined) {
    throw new ProjectSourceValidationError([
      diagnostic("INVALID_LOCKFILE", "The selected source does not contain bun.lock."),
    ]);
  }
  let lockfile: { readonly packages?: Record<string, unknown> };
  try {
    lockfile = Bun.JSONC.parse(lockfileText) as { readonly packages?: Record<string, unknown> };
  } catch {
    throw new ProjectSourceValidationError([
      diagnostic("INVALID_LOCKFILE", "The selected bun.lock cannot be decoded."),
    ]);
  }
  const requirements = [
    ["@kojo/cli", PROJECT_SOURCE_COMPATIBILITY.kojo, "INCOMPATIBLE_CLI"],
    ["@kojo/workflow", PROJECT_SOURCE_COMPATIBILITY.kojo, "INCOMPATIBLE_WORKFLOW"],
    ["effect", PROJECT_SOURCE_COMPATIBILITY.effect, "INCOMPATIBLE_EFFECT"],
    ["@effect/platform-bun", PROJECT_SOURCE_COMPATIBILITY.platformBun, "INCOMPATIBLE_PLATFORM_BUN"],
    ["@types/bun", PROJECT_SOURCE_COMPATIBILITY.typesBun, "INCOMPATIBLE_TYPES_BUN"],
    ["typescript", PROJECT_SOURCE_COMPATIBILITY.typescript, "INCOMPATIBLE_TYPESCRIPT"],
  ] as const;
  const diagnostics: Array<ProjectSourceDiagnostic> = [];
  for (const [name, expected, code] of requirements) {
    const actual = dependencyVersion(manifest, name);
    if (actual !== expected) {
      diagnostics.push(
        diagnostic(
          code,
          `Expected exact project-local ${name} ${expected}, found ${actual ?? "missing"}.`,
          {
            path: "package.json",
          },
        ),
      );
    }
    const resolution = lockfile.packages?.[name];
    const resolvedIdentity = Array.isArray(resolution) ? resolution[0] : undefined;
    if (actual === expected && resolvedIdentity !== `${name}@${expected}`) {
      diagnostics.push(
        diagnostic(
          "INVALID_LOCKFILE",
          `Expected bun.lock to resolve ${name} exactly to ${expected}.`,
          { path: "bun.lock", specifier: name },
        ),
      );
    }
  }
  if (manifest.type !== "module") {
    diagnostics.push(
      diagnostic(
        "AUTHORED_COMMONJS",
        "The Project package must declare type 'module' for repository-authored workflow code.",
        { path: "package.json" },
      ),
    );
  }
  if (
    manifest.engines?.bun !== PROJECT_SOURCE_COMPATIBILITY.bun ||
    Bun.version !== PROJECT_SOURCE_COMPATIBILITY.bun
  ) {
    diagnostics.push(
      diagnostic(
        "INCOMPATIBLE_BUN",
        `Expected project and runtime Bun ${PROJECT_SOURCE_COMPATIBILITY.bun}, found ${manifest.engines?.bun ?? "missing"} and ${Bun.version}.`,
        { path: "package.json" },
      ),
    );
  }
  if (diagnostics.length > 0) throw new ProjectSourceValidationError(diagnostics);

  const evidence: ToolchainEvidence = {
    bun: PROJECT_SOURCE_COMPATIBILITY.bun,
    cli: PROJECT_SOURCE_COMPATIBILITY.kojo,
    effect: PROJECT_SOURCE_COMPATIBILITY.effect,
    platformBun: PROJECT_SOURCE_COMPATIBILITY.platformBun,
    typesBun: PROJECT_SOURCE_COMPATIBILITY.typesBun,
    typescript: PROJECT_SOURCE_COMPATIBILITY.typescript,
    workflow: PROJECT_SOURCE_COMPATIBILITY.kojo,
    workflowAbi: PROJECT_SOURCE_COMPATIBILITY.workflowAbi,
  };
  return { evidence, lockfile, lockfileDigest: sha256(lockfileText), manifest };
};

const defaultLoadRegistry = async (
  checkout: string,
  configPath: string,
): Promise<LoadedRegistry> => {
  const script = `
    const module = await import(${JSON.stringify(pathToFileURL(join(checkout, configPath)).href)});
    const config = module.default;
    if (!config || !Object.isFrozen(config) || !Object.isFrozen(config.workflows) || !Object.isFrozen(config.schedules) || !Array.isArray(config.workflows) || !Array.isArray(config.schedules)) {
      throw new Error("kojo.config.ts must default-export defineConfig({ workflows, schedules })");
    }
    const workflows = config.workflows.map(({ name, version, entryPoint }) => ({ name, version, entryPoint }));
    const schedules = config.schedules.map((schedule) => ({
      name: schedule.name,
      workflow: schedule.workflow.name,
      input: schedule.input,
      cron: String(schedule.cron),
      timezone: schedule.timezone,
      missedTimePolicy: schedule.missedTimePolicy,
    }));
    console.log(JSON.stringify({ configPath: ${JSON.stringify(configPath)}, workflows, schedules }));
  `;
  const child = Bun.spawn([process.execPath, "-e", script], {
    cwd: checkout,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  if (exitCode !== 0) {
    throw new ProjectSourceValidationError([
      diagnostic("CONFIG_LOAD_FAILED", stderr.trim() || "kojo.config.ts could not be loaded.", {
        path: configPath,
      }),
    ]);
  }
  try {
    return JSON.parse(stdout.trim()) as LoadedRegistry;
  } catch {
    throw new ProjectSourceValidationError([
      diagnostic("CONFIG_LOAD_FAILED", "kojo.config.ts returned an invalid registry response.", {
        path: configPath,
      }),
    ]);
  }
};

const installProjectDependencies = async (checkout: string) => {
  const child = Bun.spawn(
    [process.execPath, "install", "--frozen-lockfile", "--ignore-scripts", "--no-progress"],
    { cwd: checkout, stderr: "pipe", stdout: "pipe" },
  );
  const [exitCode, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  if (exitCode !== 0) {
    throw new ProjectSourceValidationError([
      diagnostic(
        "DEPENDENCY_INSTALL_FAILED",
        stderr.trim() || "The exact project-local dependencies could not be materialized.",
        { path: "bun.lock" },
      ),
    ]);
  }
};

const findConfig = async (checkout: string) => {
  const path = join(checkout, "kojo.config.ts");
  if (await Bun.file(path).exists()) return "kojo.config.ts";
  throw new ProjectSourceValidationError([
    diagnostic("INVALID_CONFIG", "The repository root does not contain kojo.config.ts."),
  ]);
};

const packageName = (specifier: string) =>
  specifier.startsWith("@")
    ? specifier.split("/").slice(0, 2).join("/")
    : (specifier.split("/")[0] ?? specifier);

const within = (root: string, candidate: string) => {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
};

const resolveModule = async (from: string, specifier: string) => {
  const base = resolve(dirname(from), specifier);
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.mts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.mjs`,
    join(base, "index.ts"),
    join(base, "index.mts"),
    join(base, "index.js"),
  ]) {
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // Continue through supported resolver candidates.
    }
  }
  return undefined;
};

interface ClosureContext {
  readonly checkout: string;
  readonly dependencies: Record<string, string>;
  readonly diagnostics: Array<ProjectSourceDiagnostic>;
  readonly lockfile: Record<string, unknown>;
  readonly localPackages: ReadonlyMap<
    string,
    { readonly manifest: PackageManifest; readonly path: string }
  >;
  readonly modules: Map<string, string>;
  readonly packages: Map<string, unknown>;
}

const collectLockResolution = (
  name: string,
  context: ClosureContext,
  path: string,
  specifier: string,
  visited = new Set<string>(),
) => {
  if (visited.has(name)) return;
  visited.add(name);
  const resolution = context.lockfile[name];
  if (resolution === undefined) {
    context.diagnostics.push(
      diagnostic("INVALID_LOCKFILE", `bun.lock has no exact resolution for '${name}'.`, {
        path,
        specifier,
      }),
    );
    return;
  }
  context.packages.set(name, resolution);
  if (!Array.isArray(resolution)) return;
  const metadata = resolution[2];
  if (metadata === null || typeof metadata !== "object") return;
  const record = metadata as Record<string, unknown>;
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"] as const) {
    const dependencies = record[field];
    if (dependencies === null || typeof dependencies !== "object") continue;
    for (const dependency of Object.keys(dependencies as Record<string, unknown>).sort()) {
      if (context.lockfile[dependency] !== undefined) {
        collectLockResolution(dependency, context, path, dependency, visited);
      }
    }
  }
};

const collectLocalPackages = async (
  checkout: string,
): Promise<ReadonlyMap<string, { readonly manifest: PackageManifest; readonly path: string }>> => {
  const packages = new Map<string, { readonly manifest: PackageManifest; readonly path: string }>();
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.name === "package.json" && directory !== checkout) {
        try {
          const manifest = JSON.parse(await readFile(path, "utf8")) as PackageManifest;
          if (typeof manifest.name === "string")
            packages.set(manifest.name, { manifest, path: directory });
        } catch {
          // The reachable dependency check reports invalid manifests if the package is imported.
        }
      }
    }
  };
  await visit(checkout);
  return packages;
};

const exportedEntry = (value: unknown): string | undefined => {
  if (typeof value === "string") return value;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return (
      exportedEntry(record.import) ?? exportedEntry(record.default) ?? exportedEntry(record["."])
    );
  }
  return undefined;
};

const scanLocalPackage = async (
  name: string,
  specifier: string,
  packagePath: string,
  manifest: PackageManifest,
  context: ClosureContext,
) => {
  const subpath = specifier === name ? undefined : specifier.slice(name.length + 1);
  const declaredEntry =
    subpath ?? exportedEntry(manifest.exports) ?? manifest.module ?? manifest.main ?? "index.ts";
  const entry = await resolveModule(
    join(packagePath, "package.json"),
    `./${declaredEntry.replace(/^\.\//, "")}`,
  );
  if (entry === undefined) {
    context.diagnostics.push(
      diagnostic(
        "MODULE_NOT_FOUND",
        `Local package '${name}' has no reproducible ESM entry point.`,
        {
          path: relative(context.checkout, packagePath).split(sep).join("/"),
          specifier,
        },
      ),
    );
    return;
  }
  await scanModule(entry, context);
};

const scanModule = async (path: string, context: ClosureContext): Promise<void> => {
  const logicalPath = relative(context.checkout, path).split(sep).join("/");
  if (context.modules.has(logicalPath)) return;
  if (!within(context.checkout, path)) {
    context.diagnostics.push(
      diagnostic(
        "LOCAL_DEPENDENCY_OUTSIDE_WORKTREE",
        "A local dependency resolves outside the Git worktree.",
        {
          path: logicalPath,
        },
      ),
    );
    return;
  }
  if (/\.(?:cjs|cts)$/i.test(path)) {
    context.diagnostics.push(
      diagnostic(
        "AUTHORED_COMMONJS",
        "Repository-authored CommonJS modules are not reproducible.",
        { path: logicalPath },
      ),
    );
    return;
  }
  if (/\.node$/i.test(path)) {
    context.diagnostics.push(
      diagnostic("NATIVE_ADDON", "Native add-ons are not supported in Workflow closures.", {
        path: logicalPath,
      }),
    );
    return;
  }
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch {
    context.diagnostics.push(
      diagnostic("MODULE_NOT_FOUND", `Module ${logicalPath} could not be read.`, {
        path: logicalPath,
      }),
    );
    return;
  }
  context.modules.set(logicalPath, sha256(contents.replaceAll("\r\n", "\n")));
  const loader = /\.[cm]?tsx$/i.test(path) ? "tsx" : /\.[cm]?ts$/i.test(path) ? "ts" : "js";
  let scannedImports: ReadonlyArray<{ readonly kind: string; readonly path: string }> = [];
  try {
    scannedImports = new Bun.Transpiler({ loader }).scanImports(contents);
  } catch {
    context.diagnostics.push(
      diagnostic(
        "UNSUPPORTED_MODULE",
        "The repository-authored module could not be parsed as ESM.",
        {
          path: logicalPath,
        },
      ),
    );
  }
  const specifiers = scannedImports.map((entry) => entry.path);
  const literalDynamicImports = scannedImports.filter(
    ({ kind }) => kind === "dynamic-import",
  ).length;
  const dynamicImportTokens = contents.match(/\bimport\s*\(/g)?.length ?? 0;
  if (dynamicImportTokens > literalDynamicImports) {
    context.diagnostics.push(
      diagnostic("COMPUTED_IMPORT", "Computed import specifiers cannot be reproduced.", {
        path: logicalPath,
      }),
    );
  }
  if (
    /\brequire\s*\(/.test(contents) ||
    /\bmodule\s*\.\s*exports\b/.test(contents) ||
    /\bimport\s+[\w$]+\s*=\s*require\s*\(/.test(contents)
  ) {
    context.diagnostics.push(
      diagnostic("AUTHORED_COMMONJS", "Repository-authored CommonJS is not supported.", {
        path: logicalPath,
      }),
    );
  }

  for (const specifier of specifiers) {
    if (/^(?:https?|data):/i.test(specifier)) {
      context.diagnostics.push(
        diagnostic("REMOTE_IMPORT", "Remote imports are not supported.", {
          path: logicalPath,
          specifier,
        }),
      );
      continue;
    }
    if (/^(?:node|bun):/.test(specifier)) continue;
    if (specifier.endsWith(".node")) {
      context.diagnostics.push(
        diagnostic("NATIVE_ADDON", "Native add-ons are not supported in Workflow closures.", {
          path: logicalPath,
          specifier,
        }),
      );
      continue;
    }
    if (specifier.startsWith(".") || specifier.startsWith("/")) {
      const resolved = await resolveModule(path, specifier);
      if (resolved === undefined) {
        context.diagnostics.push(
          diagnostic("MODULE_NOT_FOUND", `Static import '${specifier}' could not be resolved.`, {
            path: logicalPath,
            specifier,
          }),
        );
      } else {
        await scanModule(resolved, context);
      }
      continue;
    }
    const name = packageName(specifier);
    const requested = context.dependencies[name];
    if (requested === undefined) {
      context.diagnostics.push(
        diagnostic("UNSUPPORTED_MODULE", `Package '${name}' is not declared by the Project.`, {
          path: logicalPath,
          specifier,
        }),
      );
      continue;
    }
    if (
      /^(?:file|link):/.test(requested) ||
      requested.startsWith(".") ||
      requested.startsWith("/")
    ) {
      const local = resolve(context.checkout, requested.replace(/^(?:file|link):/, ""));
      if (!within(context.checkout, local)) {
        context.diagnostics.push(
          diagnostic(
            "LOCAL_DEPENDENCY_OUTSIDE_WORKTREE",
            `Local dependency '${name}' resolves outside the Git worktree.`,
            { path: logicalPath, specifier },
          ),
        );
      } else {
        let localManifest: PackageManifest;
        try {
          localManifest = JSON.parse(
            await readFile(join(local, "package.json"), "utf8"),
          ) as PackageManifest;
          await scanLocalPackage(name, specifier, local, localManifest, context);
        } catch {
          context.diagnostics.push(
            diagnostic(
              "MODULE_NOT_FOUND",
              `Local dependency '${name}' has no valid package.json.`,
              {
                path: logicalPath,
                specifier,
              },
            ),
          );
        }
      }
      continue;
    }
    if (requested.startsWith("workspace:")) {
      const workspacePackage = context.localPackages.get(name);
      if (workspacePackage === undefined) {
        context.diagnostics.push(
          diagnostic(
            "MODULE_NOT_FOUND",
            `Workspace dependency '${name}' was not found in the worktree.`,
            {
              path: logicalPath,
              specifier,
            },
          ),
        );
      } else {
        await scanLocalPackage(
          name,
          specifier,
          workspacePackage.path,
          workspacePackage.manifest,
          context,
        );
      }
      continue;
    }
    collectLockResolution(name, context, "bun.lock", specifier);
  }
};

const findNativeAddon = async (directory: string): Promise<string | undefined> => {
  let entries: Array<Dirent<string>>;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules") continue;
    const path = join(directory, entry.name);
    if (entry.isFile() && entry.name.endsWith(".node")) return path;
    if (entry.isDirectory()) {
      const nested = await findNativeAddon(path);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
};

const fingerprintWorkflow = async (
  checkout: string,
  workflow: LoadedWorkflow,
  toolchain: ToolchainEvidence,
  manifest: PackageManifest,
  lockfile: Record<string, unknown>,
) => {
  const diagnostics: Array<ProjectSourceDiagnostic> = [];
  const path = resolve(checkout, workflow.entryPoint);
  if (!within(checkout, path) || !(await Bun.file(path).exists())) {
    throw new ProjectSourceValidationError([
      diagnostic(
        "ENTRY_POINT_NOT_FOUND",
        `Workflow Entry Point '${workflow.entryPoint}' was not found in the worktree.`,
        {
          path: workflow.entryPoint,
        },
      ),
    ]);
  }
  const modules = new Map<string, string>();
  const packages = new Map<string, unknown>();
  const localPackages = await collectLocalPackages(checkout);
  await scanModule(path, {
    checkout,
    dependencies: { ...manifest.dependencies, ...manifest.devDependencies },
    diagnostics,
    lockfile,
    localPackages,
    modules,
    packages,
  });
  for (const name of packages.keys()) {
    const nativeAddon = await findNativeAddon(join(checkout, "node_modules", name));
    if (nativeAddon !== undefined) {
      diagnostics.push(
        diagnostic("NATIVE_ADDON", `Package '${name}' contains a native add-on.`, {
          path: relative(checkout, nativeAddon).split(sep).join("/"),
          specifier: name,
        }),
      );
    }
  }
  if (diagnostics.length > 0) throw new ProjectSourceValidationError(diagnostics);
  const closure: WorkflowClosureManifest = {
    entryPoint: workflow.entryPoint,
    lockfileResolutions: [...packages]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([package_, resolution]) => ({ package: package_, resolution })),
    modules: [...modules]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([modulePath, digest]) => ({ digest, path: modulePath })),
    resolver: { conditions: ["bun", "import", "default"], identity: "bun-esm-v1" },
    toolchain,
    workflowAbi: PROJECT_SOURCE_COMPATIBILITY.workflowAbi,
  };
  return { ...workflow, fingerprint: sha256(canonicalJson(closure)), manifest: closure };
};

const validateConfigClosure = async (
  checkout: string,
  configPath: string,
  manifest: PackageManifest,
  lockfile: Record<string, unknown>,
) => {
  const diagnostics: Array<ProjectSourceDiagnostic> = [];
  await scanModule(resolve(checkout, configPath), {
    checkout,
    dependencies: { ...manifest.dependencies, ...manifest.devDependencies },
    diagnostics,
    localPackages: await collectLocalPackages(checkout),
    lockfile,
    modules: new Map(),
    packages: new Map(),
  });
  if (diagnostics.length > 0) throw new ProjectSourceValidationError(diagnostics);
};

const validateLoadedRegistry = (registry: LoadedRegistry, configPath: string) => {
  const diagnostics: Array<ProjectSourceDiagnostic> = [];
  if (!Array.isArray(registry.workflows) || !Array.isArray(registry.schedules)) {
    diagnostics.push(
      diagnostic("INVALID_CONFIG", "The complete Workflow Registry and schedules must be arrays.", {
        path: configPath,
      }),
    );
  } else {
    const workflowNames = new Set<string>();
    for (const workflow of registry.workflows) {
      if (
        typeof workflow.name !== "string" ||
        workflow.name.length === 0 ||
        typeof workflow.version !== "string" ||
        workflow.version.length === 0 ||
        typeof workflow.entryPoint !== "string" ||
        workflow.entryPoint.length === 0
      ) {
        diagnostics.push(
          diagnostic(
            "INVALID_CONFIG",
            "Every Developer Workflow requires a name, version, and entry point.",
            { path: configPath },
          ),
        );
      } else if (workflowNames.has(workflow.name)) {
        diagnostics.push(
          diagnostic("INVALID_CONFIG", `Developer Workflow '${workflow.name}' is duplicated.`, {
            path: configPath,
          }),
        );
      }
      workflowNames.add(workflow.name);
    }
    const scheduleNames = new Set<string>();
    for (const schedule of registry.schedules) {
      if (scheduleNames.has(schedule.name)) {
        diagnostics.push(
          diagnostic("INVALID_CONFIG", `Workflow Schedule '${schedule.name}' is duplicated.`, {
            path: configPath,
          }),
        );
      }
      scheduleNames.add(schedule.name);
      if (!workflowNames.has(schedule.workflow)) {
        diagnostics.push(
          diagnostic(
            "INVALID_CONFIG",
            `Workflow Schedule '${schedule.name}' targets unknown Developer Workflow '${schedule.workflow}'.`,
            { path: configPath },
          ),
        );
      }
    }
  }
  if (diagnostics.length > 0) throw new ProjectSourceValidationError(diagnostics);
};

const rejectCustomLoaders = async (checkout: string) => {
  for (const name of ["bunfig.toml", "bunfig.local.toml"]) {
    const path = join(checkout, name);
    if (!(await Bun.file(path).exists())) continue;
    const contents = await readFile(path, "utf8");
    if (/\b(?:preload|loader|plugin)\b/i.test(contents)) {
      throw new ProjectSourceValidationError([
        diagnostic("CUSTOM_LOADER", "Custom loaders, plugins, and preloads are not supported.", {
          path: name,
        }),
      ]);
    }
  }
};

export const activateProjectSource = async ({
  loadRegistry = defaultLoadRegistry,
  policy,
  repository: requestedRepository,
}: ProjectSourceActivationOptions): Promise<ProjectSourceRevision> => {
  const repository = await realpath(requestedRepository);
  const selected = await selectSource(repository, policy);
  const checkout = await makeMutableCheckout(repository, selected.commit);
  try {
    const { evidence, lockfile, lockfileDigest, manifest } = await validateToolchain(checkout.path);
    await rejectCustomLoaders(checkout.path);
    const configPath = await findConfig(checkout.path);
    await validateConfigClosure(checkout.path, configPath, manifest, lockfile.packages ?? {});
    if (loadRegistry === defaultLoadRegistry) await installProjectDependencies(checkout.path);
    const registry = await loadRegistry(checkout.path, configPath);
    validateLoadedRegistry(registry, configPath);
    const workflows = await Promise.all(
      registry.workflows.map((workflow) =>
        fingerprintWorkflow(checkout.path, workflow, evidence, manifest, lockfile.packages ?? {}),
      ),
    );
    return Object.freeze({
      commit: selected.commit,
      configPath,
      freshness: selected.freshness,
      lockfileDigest,
      policy,
      provenance: {
        defaultBranch: selected.branch,
        remote: selected.remote,
        repository,
        selectedAt: new Date().toISOString(),
      },
      schedules: Object.freeze([...registry.schedules]),
      toolchain: evidence,
      workflows: Object.freeze(workflows),
    });
  } finally {
    await checkout.dispose();
  }
};

export const activateStoredProjectSource = async (
  store: SystemStore,
  projectId: string,
  options: ProjectSourceActivationOptions,
): Promise<ProjectSourceRevision> => {
  try {
    const revision = await activateProjectSource(options);
    store.projectSources.activate(projectId, options.policy, canonicalJson(revision));
    return revision;
  } catch (error) {
    const diagnostics =
      error instanceof ProjectSourceValidationError
        ? error.diagnostics
        : [
            diagnostic(
              "CONFIG_LOAD_FAILED",
              error instanceof Error ? error.message : String(error),
            ),
          ];
    store.projectSources.reject(projectId, options.policy, canonicalJson(diagnostics));
    if (error instanceof ProjectSourceValidationError) throw error;
    throw new ProjectSourceValidationError(diagnostics);
  }
};

const chmodTree = async (path: string, writable: boolean): Promise<void> => {
  const information = await stat(path);
  if (!information.isDirectory()) {
    await chmod(path, writable ? 0o600 : 0o400);
    return;
  }
  if (writable) await chmod(path, 0o700);
  for (const entry of await readdir(path)) await chmodTree(join(path, entry), writable);
  if (!writable) await chmod(path, 0o500);
};

export interface RuntimeSourceCheckout {
  readonly commit: string;
  readonly path: string;
  readonly dispose: () => Promise<void>;
}

export const materializeRuntimeSourceCheckout = async (
  requestedRepository: string,
  revision: Pick<ProjectSourceRevision, "commit">,
): Promise<RuntimeSourceCheckout> => {
  const repository = await realpath(requestedRepository);
  const checkout = await makeMutableCheckout(repository, revision.commit);
  await chmodTree(checkout.path, false);
  let disposed = false;
  return {
    commit: revision.commit,
    path: checkout.path,
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      await chmodTree(checkout.path, true).catch(() => undefined);
      await checkout.dispose();
    },
  };
};
