import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
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
  | "SOURCE_NOT_ACTIVATED"
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

export interface PinnedProjectSourceOptions extends ProjectSourceActivationOptions {
  readonly commit: string;
  readonly defaultBranch?: string;
  readonly remote?: string | null;
}

interface GitResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

interface SelectedProjectSource {
  readonly branch: string;
  readonly commit: string;
  readonly freshness: ProjectSourceRevision["freshness"];
  readonly remote: string | null;
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

const localDefaultBranch = async (repository: string, remote: string | null) => {
  if (remote !== null) {
    const remoteHead = await runGitResult(
      repository,
      "symbolic-ref",
      "--short",
      `refs/remotes/${remote}/HEAD`,
    );
    if (remoteHead.exitCode === 0 && remoteHead.stdout.startsWith(`${remote}/`)) {
      return remoteHead.stdout.slice(`${remote}/`.length);
    }
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

const remoteDefaultBranch = async (repository: string, remote: string) => {
  const result = await runGitResult(repository, "ls-remote", "--symref", remote, "HEAD");
  if (result.exitCode !== 0) {
    throw new ProjectSourceValidationError([
      diagnostic(
        "REMOTE_FETCH_FAILED",
        `The current default branch could not be read from ${remote}.`,
      ),
    ]);
  }
  const lines = result.stdout.split("\n");
  const symbolic = lines.find(
    (line) => line.startsWith("ref: refs/heads/") && line.endsWith("\tHEAD"),
  );
  const head = lines.find(
    (line) => line.endsWith("\tHEAD") && /^(?:[a-f0-9]{40}|[a-f0-9]{64})\tHEAD$/.test(line),
  );
  const branch = symbolic?.slice("ref: refs/heads/".length, -"\tHEAD".length);
  const commit = head?.slice(0, -"\tHEAD".length);
  if (branch === undefined || branch.length === 0 || commit === undefined) {
    throw new ProjectSourceValidationError([
      diagnostic(
        "DEFAULT_BRANCH_NOT_FOUND",
        `The current default branch could not be determined from ${remote}.`,
      ),
    ]);
  }
  return { branch, commit };
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
  const remotes = (await runGit(repository, "remote")).split("\n").filter(Boolean);
  const remote = remotes.includes("origin") ? "origin" : (remotes[0] ?? null);
  const branch = await localDefaultBranch(repository, remote);
  const localCommit = await runGit(repository, "rev-parse", `refs/heads/${branch}`);
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
        diagnostic("REMOTE_FETCH_FAILED", `RemoteLatest could not fetch ${remote}.`),
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

  if (policy === "RemoteLatest") {
    const latest = await remoteDefaultBranch(repository, remote);
    const commitAvailable = await runGitResult(
      repository,
      "cat-file",
      "-e",
      `${latest.commit}^{commit}`,
    );
    if (commitAvailable.exitCode !== 0) {
      throw new ProjectSourceValidationError([
        diagnostic(
          "REMOTE_FETCH_FAILED",
          `The fetched source does not contain current ${remote}/${latest.branch} commit ${latest.commit}.`,
        ),
      ]);
    }
    const matchingLocal = await runGitResult(
      repository,
      "rev-parse",
      `refs/heads/${latest.branch}`,
    );
    const freshness =
      matchingLocal.exitCode === 0
        ? {
            localCommit: matchingLocal.stdout,
            remoteCommit: latest.commit,
            status: await relation(repository, matchingLocal.stdout, latest.commit),
          }
        : {
            localCommit,
            remoteCommit: latest.commit,
            status: "Unknown" as const,
            warning: `The current remote default branch ${latest.branch} has no matching local branch.`,
          };
    return {
      branch: latest.branch,
      commit: latest.commit,
      freshness,
      remote,
    };
  }

  const remoteReference = `refs/remotes/${remote}/${branch}`;
  const remoteResult = await runGitResult(repository, "rev-parse", "--verify", remoteReference);
  if (remoteResult.exitCode !== 0) {
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
    commit: localCommit,
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
  readonly optionalDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
  readonly type?: string;
  readonly version?: string;
}

const readJson = async <A>(path: string, code: ProjectSourceDiagnosticCode): Promise<A> => {
  try {
    return JSON.parse(await readFile(path, "utf8")) as A;
  } catch {
    const logicalPath = path.slice(path.lastIndexOf(sep) + 1);
    throw new ProjectSourceValidationError([
      diagnostic(code, `${logicalPath} is missing or invalid.`, { path: logicalPath }),
    ]);
  }
};

const dependencyVersion = (manifest: PackageManifest, name: string) =>
  manifest.dependencies?.[name] ?? manifest.devDependencies?.[name];

const manifestDependencies = (manifest: PackageManifest) => ({
  ...manifest.dependencies,
  ...manifest.devDependencies,
  ...manifest.optionalDependencies,
  ...manifest.peerDependencies,
});

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
    const hasMarker = (value, description) => value && typeof value === "object" && Object.isFrozen(value) && Object.getOwnPropertySymbols(value).some((symbol) => symbol.description === description && value[symbol] === symbol);
    if (!config.workflows.every((workflow) => hasMarker(workflow, "@kojo/workflow/WorkflowDefinition")) || !config.schedules.every((schedule) => hasMarker(schedule, "@kojo/workflow/ScheduleDefinition"))) {
      throw new Error("kojo.config.ts must contain definitions created by @kojo/workflow");
    }
    const { Cron, Schema } = await import("effect");
    const workflowSet = new Set(config.workflows);
    const validTimezone = (timezone) => {
      try {
        const resolved = new Intl.DateTimeFormat("en", { timeZone: timezone }).resolvedOptions().timeZone;
        return !/^[+-]\\d{2}:\\d{2}$/.test(resolved);
      } catch {
        return false;
      }
    };
    const validInput = (schedule) => {
      try {
        Schema.decodeUnknownSync(Schema.toType(schedule.workflow.input))(schedule.input);
        return true;
      } catch {
        return false;
      }
    };
    if (!config.workflows.every((workflow) => typeof workflow.name === "string" && workflow.name.length > 0 && typeof workflow.version === "string" && workflow.version.length > 0 && typeof workflow.entryPoint === "string" && Schema.isSchema(workflow.input) && Schema.isSchema(workflow.success) && Schema.isSchema(workflow.failure) && typeof workflow.run === "function") || !config.schedules.every((schedule) => workflowSet.has(schedule.workflow) && Cron.isCron(schedule.cron) && schedule.cron.seconds.size === 1 && schedule.cron.seconds.has(0) && typeof schedule.timezone === "string" && validTimezone(schedule.timezone) && (schedule.missedTimePolicy === "skip" || schedule.missedTimePolicy === "catch-up-once") && validInput(schedule))) {
      throw new Error("kojo.config.ts contains an invalid Workflow Registry or Schedule");
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
  const [exitCode, , stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  if (exitCode !== 0) {
    throw new ProjectSourceValidationError([
      diagnostic("CONFIG_LOAD_FAILED", "kojo.config.ts could not be loaded.", {
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
  const [exitCode] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text(),
  ]);
  if (exitCode !== 0) {
    throw new ProjectSourceValidationError([
      diagnostic(
        "DEPENDENCY_INSTALL_FAILED",
        "The exact project-local dependencies could not be materialized.",
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
  key: string,
  context: ClosureContext,
  path: string,
  specifier: string,
  visited = new Set<string>(),
) => {
  if (visited.has(key)) return;
  visited.add(key);
  const resolution = context.lockfile[key];
  if (resolution === undefined) {
    context.diagnostics.push(
      diagnostic("INVALID_LOCKFILE", `bun.lock has no exact resolution for '${key}'.`, {
        path,
        specifier,
      }),
    );
    return;
  }
  context.packages.set(key, resolution);
  if (!Array.isArray(resolution)) return;
  const metadata = resolution[2];
  if (metadata === null || typeof metadata !== "object") return;
  const record = metadata as Record<string, unknown>;
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"] as const) {
    const dependencies = record[field];
    if (dependencies === null || typeof dependencies !== "object") continue;
    for (const dependency of Object.keys(dependencies as Record<string, unknown>).sort()) {
      const nestedKey = `${key}/${dependency}`;
      const dependencyKey = context.lockfile[nestedKey] === undefined ? dependency : nestedKey;
      if (context.lockfile[dependencyKey] !== undefined) {
        collectLockResolution(dependencyKey, context, path, dependency, visited);
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

const packageExport = (exports: unknown, subpath: string | undefined) => {
  if (subpath === undefined) return exportedEntry(exports);
  if (exports === null || typeof exports !== "object") return undefined;
  const entries = Object.entries(exports as Record<string, unknown>);
  const exact = entries.find(([key]) => key === `./${subpath}`);
  if (exact !== undefined) return exportedEntry(exact[1]);
  for (const [key, value] of entries) {
    const wildcard = key.indexOf("*");
    if (wildcard === -1) continue;
    const prefix = key.slice(0, wildcard);
    const suffix = key.slice(wildcard + 1);
    const requested = `./${subpath}`;
    if (!requested.startsWith(prefix) || !requested.endsWith(suffix)) continue;
    const match = requested.slice(prefix.length, requested.length - suffix.length);
    const target = exportedEntry(value);
    return target?.replace("*", match);
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
    packageExport(manifest.exports, subpath) ??
    subpath ??
    manifest.module ??
    manifest.main ??
    "index.ts";
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
  if (/\.jsx?$/i.test(entry) && manifest.type !== "module") {
    context.diagnostics.push(
      diagnostic(
        "AUTHORED_COMMONJS",
        `Local package '${name}' does not declare its JavaScript entry point as ESM.`,
        { path: relative(context.checkout, entry).split(sep).join("/"), specifier },
      ),
    );
    return;
  }
  await scanModule(entry, context, manifestDependencies(manifest));
};

const scanModule = async (
  path: string,
  context: ClosureContext,
  dependencies: Record<string, string> = context.dependencies,
): Promise<void> => {
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
  let resolvedPath: string;
  try {
    resolvedPath = await realpath(path);
  } catch {
    context.diagnostics.push(
      diagnostic("MODULE_NOT_FOUND", `Module ${logicalPath} could not be resolved.`, {
        path: logicalPath,
      }),
    );
    return;
  }
  if (!within(context.checkout, resolvedPath)) {
    context.diagnostics.push(
      diagnostic(
        "LOCAL_DEPENDENCY_OUTSIDE_WORKTREE",
        "A repository module resolves outside the Git worktree.",
        { path: logicalPath },
      ),
    );
    return;
  }
  if ((await lstat(path)).isSymbolicLink()) {
    context.diagnostics.push(
      diagnostic(
        "UNSUPPORTED_MODULE",
        "Symbolic-linked repository modules are not supported in Workflow closures.",
        { path: logicalPath },
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
  const dynamicImportTokens =
    contents.match(/\bimport(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*(?:\r?\n|$))*\(/g)?.length ?? 0;
  if (dynamicImportTokens > literalDynamicImports) {
    context.diagnostics.push(
      diagnostic("COMPUTED_IMPORT", "Computed import specifiers cannot be reproduced.", {
        path: logicalPath,
      }),
    );
  }
  if (
    /\brequire\b/.test(contents) ||
    /\bexport\s*=/.test(contents) ||
    /\bexports\s*(?:\.|\[)/.test(contents) ||
    /\bmodule\s*(?:\.\s*exports\b|\[\s*["']exports["']\s*\])/.test(contents)
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
        await scanModule(resolved, context, dependencies);
      }
      continue;
    }
    const name = packageName(specifier);
    const requested = dependencies[name];
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

const lockedPackageName = (resolution: unknown) => {
  if (!Array.isArray(resolution) || typeof resolution[0] !== "string") return undefined;
  const separator = resolution[0].lastIndexOf("@");
  return separator > 0 ? resolution[0].slice(0, separator) : undefined;
};

const installedPackagePath = (
  checkout: string,
  key: string,
  lockfile: Record<string, unknown>,
): string | undefined => {
  const name = lockedPackageName(lockfile[key]);
  if (name === undefined) return undefined;
  if (key === name) return join(checkout, "node_modules", name);
  const suffix = `/${name}`;
  if (!key.endsWith(suffix)) return undefined;
  const parentKey = key.slice(0, -suffix.length);
  const parent = installedPackagePath(checkout, parentKey, lockfile);
  return parent === undefined ? undefined : join(parent, "node_modules", name);
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
    dependencies: manifestDependencies(manifest),
    diagnostics,
    lockfile,
    localPackages,
    modules,
    packages,
  });
  for (const name of packages.keys()) {
    const packagePath = installedPackagePath(checkout, name, lockfile);
    if (packagePath === undefined) continue;
    const nativeAddon = await findNativeAddon(packagePath);
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
    dependencies: manifestDependencies(manifest),
    diagnostics,
    localPackages: await collectLocalPackages(checkout),
    lockfile,
    modules: new Map(),
    packages: new Map(),
  });
  if (diagnostics.length > 0) throw new ProjectSourceValidationError(diagnostics);
};

const validTimeZone = (timezone: string) => {
  try {
    const resolved = new Intl.DateTimeFormat("en", { timeZone: timezone }).resolvedOptions()
      .timeZone;
    return !/^[+-]\d{2}:\d{2}$/.test(resolved);
  } catch {
    return false;
  }
};

const validEntryPoint = (entryPoint: unknown): entryPoint is string =>
  typeof entryPoint === "string" &&
  entryPoint.length > 0 &&
  !isAbsolute(entryPoint) &&
  entryPoint.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..") &&
  /\.(?:ts|mts)$/.test(entryPoint);

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
        !validEntryPoint(workflow.entryPoint)
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
      if (
        typeof schedule.name !== "string" ||
        schedule.name.length === 0 ||
        typeof schedule.workflow !== "string" ||
        schedule.workflow.length === 0 ||
        typeof schedule.cron !== "string" ||
        schedule.cron.length === 0 ||
        typeof schedule.timezone !== "string" ||
        !validTimeZone(schedule.timezone) ||
        (schedule.missedTimePolicy !== "skip" && schedule.missedTimePolicy !== "catch-up-once")
      ) {
        diagnostics.push(
          diagnostic(
            "INVALID_CONFIG",
            "Every Workflow Schedule requires a name, target, Effect Cron, IANA timezone, and missed-time policy.",
            { path: configPath },
          ),
        );
      } else if (scheduleNames.has(schedule.name)) {
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

const validateSelectedProjectSource = async (
  repository: string,
  policy: ProjectSourcePolicy,
  selected: SelectedProjectSource,
  loadRegistry: NonNullable<ProjectSourceActivationOptions["loadRegistry"]>,
): Promise<ProjectSourceRevision> => {
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

export const activateProjectSource = async ({
  loadRegistry = defaultLoadRegistry,
  policy,
  repository: requestedRepository,
}: ProjectSourceActivationOptions): Promise<ProjectSourceRevision> => {
  const repository = await realpath(requestedRepository);
  const selected = await selectSource(repository, policy);
  return validateSelectedProjectSource(repository, policy, selected, loadRegistry);
};

export const validatePinnedProjectSource = async ({
  commit,
  defaultBranch = "(pinned)",
  loadRegistry = defaultLoadRegistry,
  policy,
  remote = null,
  repository: requestedRepository,
}: PinnedProjectSourceOptions): Promise<ProjectSourceRevision> => {
  const repository = await realpath(requestedRepository);
  const available = await runGitResult(repository, "cat-file", "-e", `${commit}^{commit}`);
  if (available.exitCode !== 0) {
    throw new ProjectSourceValidationError([
      diagnostic(
        "SOURCE_NOT_ACTIVATED",
        `The pinned Project Source Revision ${commit} is not available in the registered repository.`,
      ),
    ]);
  }
  return validateSelectedProjectSource(
    repository,
    policy,
    {
      branch: defaultBranch,
      commit,
      freshness: {
        localCommit: commit,
        status: "Unknown",
        warning:
          "Resume validated the pinned commit independently from the current default branch.",
      },
      remote,
    },
    loadRegistry,
  );
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

const chmodTree = async (root: string, path: string, writable: boolean): Promise<void> => {
  const information = await lstat(path);
  if (information.isSymbolicLink()) {
    if (!writable) {
      const target = await realpath(path);
      if (!within(root, target)) {
        throw new ProjectSourceValidationError([
          diagnostic(
            "LOCAL_DEPENDENCY_OUTSIDE_WORKTREE",
            "An immutable Runtime Source Checkout cannot contain a symlink outside the worktree.",
            { path: relative(root, path).split(sep).join("/") },
          ),
        ]);
      }
    }
    return;
  }
  if (!information.isDirectory()) {
    await chmod(path, writable ? 0o600 : 0o400);
    return;
  }
  if (writable) await chmod(path, 0o700);
  for (const entry of await readdir(path)) await chmodTree(root, join(path, entry), writable);
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
  options: { readonly installDependencies?: boolean } = {},
): Promise<RuntimeSourceCheckout> => {
  const repository = await realpath(requestedRepository);
  const checkout = await makeMutableCheckout(repository, revision.commit);
  try {
    if (options.installDependencies === true) await installProjectDependencies(checkout.path);
    await chmodTree(checkout.path, checkout.path, false);
  } catch (error) {
    await chmodTree(checkout.path, checkout.path, true).catch(() => undefined);
    await checkout.dispose();
    throw error;
  }
  let disposed = false;
  return {
    commit: revision.commit,
    path: checkout.path,
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      await chmodTree(checkout.path, checkout.path, true).catch(() => undefined);
      await checkout.dispose();
    },
  };
};

export interface CheckoutSourceSnapshotRuntime {
  readonly checkout: RuntimeSourceCheckout;
  readonly revision: ProjectSourceRevision;
  readonly source: {
    readonly baseCommit: string;
    readonly changes: ReadonlyArray<string>;
    readonly commit: string;
    readonly dirty: boolean;
    readonly kind: "CheckoutSourceSnapshot";
  };
}

const nulSeparated = (value: string) => value.split("\0").filter((entry) => entry.length > 0);

export const freezeCheckoutSource = async (
  requestedRepository: string,
  options: {
    readonly installRuntimeDependencies?: boolean;
    readonly loadRegistry?: ProjectSourceActivationOptions["loadRegistry"];
  } = {},
): Promise<CheckoutSourceSnapshotRuntime> => {
  const repository = await realpath(requestedRepository);
  const baseCommit = await runGit(repository, "rev-parse", "HEAD");
  const status = await runGit(
    repository,
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  );
  const changes = nulSeparated(status);
  const parent = await mkdtemp(join(tmpdir(), "kojo-checkout-snapshot-"));
  const snapshotRepository = join(parent, "repository");
  let checkout: RuntimeSourceCheckout | undefined;
  try {
    const clone = Bun.spawnSync(
      ["git", "clone", "--no-hardlinks", "--no-checkout", repository, snapshotRepository],
      { stderr: "pipe", stdout: "pipe" },
    );
    if (clone.exitCode !== 0) throw new Error(clone.stderr.toString().trim());
    await runGit(snapshotRepository, "checkout", "--detach", baseCommit);
    const paths = nulSeparated(
      await runGit(repository, "ls-files", "-z", "--cached", "--others", "--exclude-standard"),
    );
    for (const logicalPath of paths) {
      const source = join(repository, logicalPath);
      const destination = join(snapshotRepository, logicalPath);
      const information = await lstat(source).catch(() => undefined);
      if (information === undefined) {
        await rm(destination, { force: true, recursive: true });
        continue;
      }
      await mkdir(dirname(destination), { recursive: true });
      await cp(source, destination, { force: true, recursive: information.isDirectory() });
    }
    await runGit(snapshotRepository, "config", "user.email", "kojo@localhost");
    await runGit(snapshotRepository, "config", "user.name", "Kojo Checkout Snapshot");
    await runGit(snapshotRepository, "add", "--all");
    if (changes.length > 0) {
      await runGit(
        snapshotRepository,
        "commit",
        "--no-gpg-sign",
        "-m",
        "kojo checkout source snapshot",
      );
    }
    const snapshotCommit = await runGit(snapshotRepository, "rev-parse", "HEAD");
    await runGit(snapshotRepository, "branch", "--force", "main", snapshotCommit);
    await runGit(snapshotRepository, "checkout", "main");
    await runGit(snapshotRepository, "remote", "remove", "origin");
    const revision = await activateProjectSource({
      loadRegistry: options.loadRegistry,
      policy: "LocalWithFreshnessWarning",
      repository: snapshotRepository,
    });
    checkout = await materializeRuntimeSourceCheckout(snapshotRepository, revision, {
      installDependencies: options.installRuntimeDependencies ?? true,
    });
    const originalDispose = checkout.dispose;
    checkout = {
      ...checkout,
      dispose: async () => {
        await originalDispose();
        await rm(parent, { force: true, recursive: true });
      },
    };
    return {
      checkout,
      revision,
      source: {
        baseCommit,
        changes,
        commit: snapshotCommit,
        dirty: changes.length > 0,
        kind: "CheckoutSourceSnapshot",
      },
    };
  } catch (error) {
    await checkout?.dispose().catch(() => undefined);
    await rm(parent, { force: true, recursive: true });
    throw error;
  }
};
