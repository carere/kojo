import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activateProjectSource,
  activateStoredProjectSource,
  freezeCheckoutSource,
  type LoadedRegistry,
  materializeRuntimeSourceCheckout,
  ProjectSourceValidationError,
  validatePinnedProjectSource,
} from "../src/system/project-source";
import { makeProjectService, ProjectOperationError } from "../src/system/projects";
import { openSystemStore } from "../src/system/storage";

const cleanup = new Set<string>();

const git = (directory: string, ...arguments_: ReadonlyArray<string>) => {
  const result = Bun.spawnSync(["git", "-C", directory, ...arguments_], {
    stderr: "pipe",
    stdout: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
};

const write = (path: string, contents: string) => Bun.write(path, contents);

const makeRepository = async () => {
  const repository = await mkdtemp(join(tmpdir(), "kojo-source-test-"));
  cleanup.add(repository);
  git(repository, "init", "--initial-branch=main");
  git(repository, "config", "user.email", "kojo@example.test");
  git(repository, "config", "user.name", "Kojo Test");
  await mkdir(join(repository, "workflows"));
  await write(
    join(repository, "package.json"),
    JSON.stringify({
      dependencies: {
        "@effect/platform-bun": "4.0.0-beta.98",
        "@kojo/cli": "0.1.0",
        "@kojo/workflow": "0.1.0",
        effect: "4.0.0-beta.98",
        library: "1.0.0",
      },
      devDependencies: { "@types/bun": "1.3.14", typescript: "7.0.2" },
      engines: { bun: "1.3.14" },
      name: "source-fixture",
      type: "module",
      version: "1.0.0",
    }),
  );
  await write(
    join(repository, "bun.lock"),
    JSON.stringify({
      lockfileVersion: 1,
      packages: {
        "@effect/platform-bun": ["@effect/platform-bun@4.0.0-beta.98", "", {}, "sha512-platform"],
        "@kojo/cli": ["@kojo/cli@0.1.0", "", {}, "sha512-cli"],
        "@kojo/workflow": ["@kojo/workflow@0.1.0", "", {}, "sha512-workflow"],
        "@types/bun": ["@types/bun@1.3.14", "", {}, "sha512-types-bun"],
        effect: ["effect@4.0.0-beta.98", "", {}, "sha512-effect"],
        library: ["library@1.0.0", "", { dependencies: { transitive: "3.0.0" } }, "sha512-library"],
        "library/transitive": ["transitive@3.0.0", "", {}, "sha512-library-transitive"],
        transitive: ["transitive@2.0.0", "", {}, "sha512-transitive"],
        typescript: ["typescript@7.0.2", "", {}, "sha512-typescript"],
      },
    }),
  );
  await write(join(repository, "kojo.config.ts"), "export default {}\n");
  await write(join(repository, "workflows/shared.ts"), "export const message = 'one'\n");
  await write(
    join(repository, "workflows/alpha.ts"),
    "import 'library'\nimport { message } from './shared.ts'\nexport const alpha = message\n",
  );
  await write(join(repository, "workflows/beta.ts"), "export const beta = 'stable'\n");
  git(repository, "add", ".");
  git(repository, "commit", "-m", "initial");
  return repository;
};

const registry = (): LoadedRegistry => ({
  configPath: "kojo.config.ts",
  schedules: [],
  workflows: [
    { entryPoint: "workflows/alpha.ts", name: "alpha", version: "v1" },
    { entryPoint: "workflows/beta.ts", name: "beta", version: "v1" },
  ],
});

afterEach(async () => {
  for (const path of cleanup) await rm(path, { force: true, recursive: true });
  cleanup.clear();
});

describe("Project Source Revision adapter", () => {
  test("freezes dirty and untracked workflow source with truthful provenance", async () => {
    const repository = await makeRepository();
    await write(join(repository, "workflows/shared.ts"), "export const message = 'dirty'\n");
    await write(join(repository, "workflows/untracked.ts"), "export const value = 'untracked'\n");

    const frozen = await freezeCheckoutSource(repository, {
      installRuntimeDependencies: false,
      loadRegistry: async () => ({
        configPath: "kojo.config.ts",
        schedules: [],
        workflows: [
          { entryPoint: "workflows/alpha.ts", name: "alpha", version: "v1" },
          { entryPoint: "workflows/untracked.ts", name: "untracked", version: "v1" },
        ],
      }),
    });
    try {
      expect(frozen.source).toMatchObject({
        baseCommit: git(repository, "rev-parse", "HEAD"),
        dirty: true,
        kind: "CheckoutSourceSnapshot",
      });
      expect(frozen.source.changes.join("\n")).toContain("workflows/shared.ts");
      expect(frozen.source.changes.join("\n")).toContain("workflows/untracked.ts");
      expect(await Bun.file(join(frozen.checkout.path, "workflows/shared.ts")).text()).toContain(
        "dirty",
      );
      expect(await Bun.file(join(frozen.checkout.path, "workflows/untracked.ts")).text()).toContain(
        "untracked",
      );
      expect(frozen.revision.workflows.map(({ name }) => name)).toEqual(["alpha", "untracked"]);
    } finally {
      await frozen.checkout.dispose();
    }
  });

  test("selects the local default branch with freshness evidence and requires remote latest", async () => {
    const remote = await makeRepository();
    const local = await mkdtemp(join(tmpdir(), "kojo-source-clone-"));
    cleanup.add(local);
    await rm(local, { recursive: true });
    git(remote, "clone", remote, local);
    git(local, "config", "user.email", "kojo@example.test");
    git(local, "config", "user.name", "Kojo Test");
    const localCommit = git(local, "rev-parse", "refs/heads/main");
    await write(join(remote, "workflows/beta.ts"), "export const beta = 'remote'\n");
    git(remote, "add", ".");
    git(remote, "commit", "-m", "remote change");
    const remoteCommit = git(remote, "rev-parse", "HEAD");

    const localRevision = await activateProjectSource({
      loadRegistry: async () => registry(),
      policy: "LocalWithFreshnessWarning",
      repository: local,
    });
    expect(localRevision.commit).toBe(localCommit);
    expect(localRevision.freshness).toMatchObject({ status: "Behind", remoteCommit });

    const latestRevision = await activateProjectSource({
      loadRegistry: async () => registry(),
      policy: "RemoteLatest",
      repository: local,
    });
    expect(latestRevision.commit).toBe(remoteCommit);
    expect(git(local, "rev-parse", "refs/heads/main")).toBe(localCommit);
  });

  test("validates a pinned commit after the Project default branch advances", async () => {
    const repository = await makeRepository();
    const pinnedCommit = git(repository, "rev-parse", "HEAD");
    const pinned = await activateProjectSource({
      loadRegistry: async () => registry(),
      policy: "LocalWithFreshnessWarning",
      repository,
    });
    await write(join(repository, "workflows/shared.ts"), "export const message = 'new'\n");
    git(repository, "add", ".");
    git(repository, "commit", "-m", "advance default branch");

    const restored = await validatePinnedProjectSource({
      commit: pinnedCommit,
      loadRegistry: async () => registry(),
      policy: "LocalWithFreshnessWarning",
      repository,
    });

    expect(restored.commit).toBe(pinnedCommit);
    expect(restored.workflows).toEqual(pinned.workflows);
    expect(restored.commit).not.toBe(git(repository, "rev-parse", "HEAD"));
  });

  test("RemoteLatest follows the current remote default branch instead of stale origin HEAD", async () => {
    const remote = await makeRepository();
    const local = await mkdtemp(join(tmpdir(), "kojo-source-clone-"));
    cleanup.add(local);
    await rm(local, { recursive: true });
    git(remote, "clone", remote, local);
    git(remote, "branch", "-m", "main", "trunk");
    await write(join(remote, "workflows/beta.ts"), "export const beta = 'trunk'\n");
    git(remote, "add", ".");
    git(remote, "commit", "-m", "move remote default");
    const remoteCommit = git(remote, "rev-parse", "HEAD");

    const revision = await activateProjectSource({
      loadRegistry: async () => registry(),
      policy: "RemoteLatest",
      repository: local,
    });

    expect(git(local, "symbolic-ref", "--short", "refs/remotes/origin/HEAD")).toBe("origin/main");
    expect(revision.commit).toBe(remoteCommit);
    expect(revision.provenance.defaultBranch).toBe("trunk");
  });

  test("checks the exact project-local stack before loading configuration", async () => {
    const repository = await makeRepository();
    const manifest = JSON.parse(await Bun.file(join(repository, "package.json")).text());
    manifest.dependencies.effect = "^4.0.0-beta.98";
    await write(join(repository, "package.json"), JSON.stringify(manifest));
    git(repository, "add", ".");
    git(repository, "commit", "-m", "incompatible stack");
    let loaded = false;

    const failure = await activateProjectSource({
      loadRegistry: async () => {
        loaded = true;
        return registry();
      },
      policy: "LocalWithFreshnessWarning",
      repository,
    }).catch((error) => error);

    expect(loaded).toBe(false);
    expect(failure).toBeInstanceOf(ProjectSourceValidationError);
    expect(failure.diagnostics).toContainEqual(
      expect.objectContaining({ code: "INCOMPATIBLE_EFFECT" }),
    );
  });

  test("rejects an invalid Schedule with the complete registry", async () => {
    const repository = await makeRepository();
    const failure = await activateProjectSource({
      loadRegistry: async () => ({
        ...registry(),
        schedules: [
          {
            cron: {
              and: false,
              days: [],
              hours: [9],
              minutes: [0],
              months: [],
              seconds: [0],
              weekdays: [],
            },
            input: {},
            missedTimePolicy: "skip",
            name: "daily",
            timezone: "+01:00",
            workflow: "alpha",
          },
        ],
      }),
      policy: "LocalWithFreshnessWarning",
      repository,
    }).catch((error) => error);

    expect(failure).toBeInstanceOf(ProjectSourceValidationError);
    expect(failure.diagnostics).toContainEqual(expect.objectContaining({ code: "INVALID_CONFIG" }));
  });

  test("rejects out-of-range Effect Cron fields before activating source", async () => {
    const repository = await makeRepository();
    const failure = await activateProjectSource({
      loadRegistry: async () => ({
        ...registry(),
        schedules: [
          {
            cron: {
              and: false,
              days: [],
              hours: [9],
              minutes: [60],
              months: [],
              seconds: [0],
              weekdays: [],
            },
            input: {},
            missedTimePolicy: "skip",
            name: "invalid-cron",
            timezone: "UTC",
            workflow: "alpha",
          },
        ],
      }),
      policy: "LocalWithFreshnessWarning",
      repository,
    }).catch((error) => error);

    expect(failure).toBeInstanceOf(ProjectSourceValidationError);
    expect(failure.diagnostics).toContainEqual(expect.objectContaining({ code: "INVALID_CONFIG" }));
  });

  test("fingerprints each workflow static closure independently", async () => {
    const repository = await makeRepository();
    const first = await activateProjectSource({
      loadRegistry: async () => registry(),
      policy: "LocalWithFreshnessWarning",
      repository,
    });
    await write(join(repository, "workflows/shared.ts"), "export const message = 'two'\n");
    git(repository, "add", ".");
    git(repository, "commit", "-m", "change alpha closure");
    const second = await activateProjectSource({
      loadRegistry: async () => registry(),
      policy: "LocalWithFreshnessWarning",
      repository,
    });

    expect(second.workflows.find(({ name }) => name === "alpha")?.fingerprint).not.toBe(
      first.workflows.find(({ name }) => name === "alpha")?.fingerprint,
    );
    expect(second.workflows.find(({ name }) => name === "beta")?.fingerprint).toBe(
      first.workflows.find(({ name }) => name === "beta")?.fingerprint,
    );
    expect(first.workflows[0]?.manifest.workflowAbi).toBe("1");
    expect(first.workflows[0]?.manifest.modules.map(({ path }) => path)).toEqual([
      "workflows/alpha.ts",
      "workflows/shared.ts",
    ]);
    expect(
      first.workflows[0]?.manifest.lockfileResolutions.map(({ package: name }) => name),
    ).toEqual(["library", "library/transitive"]);
  });

  test("uses each reachable workspace package dependency scope", async () => {
    const repository = await makeRepository();
    const manifest = JSON.parse(await Bun.file(join(repository, "package.json")).text());
    manifest.dependencies["workspace-library"] = "workspace:*";
    await write(join(repository, "package.json"), JSON.stringify(manifest));
    await mkdir(join(repository, "packages", "workspace-library"), { recursive: true });
    await write(
      join(repository, "packages", "workspace-library", "package.json"),
      JSON.stringify({
        dependencies: { transitive: "2.0.0" },
        exports: { "./feature": "./src/actual.ts" },
        name: "workspace-library",
        type: "module",
      }),
    );
    await mkdir(join(repository, "packages", "workspace-library", "src"));
    await write(
      join(repository, "packages", "workspace-library", "src", "actual.ts"),
      "import 'transitive'\nexport const workspaceValue = true\n",
    );
    await write(
      join(repository, "workflows/alpha.ts"),
      "import 'workspace-library/feature'\nexport const alpha = true\n",
    );
    git(repository, "add", ".");
    git(repository, "commit", "-m", "add workspace dependency");

    const revision = await activateProjectSource({
      loadRegistry: async () => registry(),
      policy: "LocalWithFreshnessWarning",
      repository,
    });

    expect(revision.workflows[0]?.manifest.modules.map(({ path }) => path)).toEqual([
      "packages/workspace-library/src/actual.ts",
      "workflows/alpha.ts",
    ]);
    expect(
      revision.workflows[0]?.manifest.lockfileResolutions.map(({ package: name }) => name),
    ).toEqual(["transitive"]);
  });

  test.each([
    ["COMPUTED_IMPORT", "const target = './shared.ts'; import(target)"],
    ["COMPUTED_IMPORT", "const target = './shared.ts'; import /* comment */ (target)"],
    ["AUTHORED_COMMONJS", "const shared = require('./shared.ts')"],
    ["AUTHORED_COMMONJS", "const alpha = 1; export = alpha"],
    ["AUTHORED_COMMONJS", "const alpha = 1; module['exports'] = alpha"],
    ["REMOTE_IMPORT", "import 'https://example.test/workflow.ts'"],
    ["NATIVE_ADDON", "import './binding.node'"],
  ] as const)("rejects unreproducible closure element %s", async (code, source) => {
    const repository = await makeRepository();
    await write(join(repository, "workflows/alpha.ts"), `${source}\nexport const alpha = 1\n`);
    if (code === "NATIVE_ADDON") await write(join(repository, "workflows/binding.node"), "native");
    git(repository, "add", ".");
    git(repository, "commit", "-m", "unsafe closure");

    const failure = await activateProjectSource({
      loadRegistry: async () => registry(),
      policy: "LocalWithFreshnessWarning",
      repository,
    }).catch((error) => error);
    expect(failure).toBeInstanceOf(ProjectSourceValidationError);
    expect(failure.diagnostics).toContainEqual(expect.objectContaining({ code }));
  });

  test("rejects custom loaders and local dependencies outside the worktree", async () => {
    const repository = await makeRepository();
    const external = await mkdtemp(join(tmpdir(), "kojo-external-dependency-"));
    cleanup.add(external);
    await write(
      join(external, "package.json"),
      JSON.stringify({ name: "external", module: "index.ts" }),
    );
    await write(join(external, "index.ts"), "export const external = true\n");
    const manifest = JSON.parse(await Bun.file(join(repository, "package.json")).text());
    manifest.dependencies.external = `file:${external}`;
    await write(join(repository, "package.json"), JSON.stringify(manifest));
    await write(
      join(repository, "workflows/alpha.ts"),
      "import 'external'\nexport const alpha = 1\n",
    );
    git(repository, "add", ".");
    git(repository, "commit", "-m", "external dependency");

    const outside = await activateProjectSource({
      loadRegistry: async () => registry(),
      policy: "LocalWithFreshnessWarning",
      repository,
    }).catch((error) => error);
    expect(outside.diagnostics).toContainEqual(
      expect.objectContaining({ code: "LOCAL_DEPENDENCY_OUTSIDE_WORKTREE" }),
    );

    await write(join(repository, "bunfig.toml"), 'preload = ["./loader.ts"]\n');
    await write(join(repository, "loader.ts"), "export {}\n");
    git(repository, "add", ".");
    git(repository, "commit", "-m", "custom loader");
    const loader = await activateProjectSource({
      loadRegistry: async () => registry(),
      policy: "LocalWithFreshnessWarning",
      repository,
    }).catch((error) => error);
    expect(loader.diagnostics).toContainEqual(expect.objectContaining({ code: "CUSTOM_LOADER" }));
  });

  test("materializes and disposes an immutable checkout without changing the developer checkout", async () => {
    const repository = await makeRepository();
    const revision = await activateProjectSource({
      loadRegistry: async () => registry(),
      policy: "LocalWithFreshnessWarning",
      repository,
    });
    await write(join(repository, "workflows/beta.ts"), "export const beta = 'dirty'\n");
    const before = git(repository, "status", "--short");
    const checkout = await materializeRuntimeSourceCheckout(repository, revision);

    expect(git(checkout.path, "rev-parse", "HEAD")).toBe(revision.commit);
    expect(await Bun.file(join(checkout.path, "workflows/beta.ts")).text()).toContain("stable");
    expect(git(repository, "status", "--short")).toBe(before);
    await checkout.dispose();
    expect(await Bun.file(checkout.path).exists()).toBe(false);
  });

  test("rejects symlinks outside the worktree without changing their targets", async () => {
    const repository = await makeRepository();
    const external = await mkdtemp(join(tmpdir(), "kojo-external-source-"));
    cleanup.add(external);
    const externalModule = join(external, "shared.ts");
    await write(externalModule, "export const message = 'external'\n");
    await rm(join(repository, "workflows/shared.ts"));
    await symlink(externalModule, join(repository, "workflows/shared.ts"));
    git(repository, "add", ".");
    git(repository, "commit", "-m", "add escaping symlink");

    const failure = await activateProjectSource({
      loadRegistry: async () => registry(),
      policy: "LocalWithFreshnessWarning",
      repository,
    }).catch((error) => error);
    expect(failure).toBeInstanceOf(ProjectSourceValidationError);
    expect(failure.diagnostics).toContainEqual(
      expect.objectContaining({ code: "LOCAL_DEPENDENCY_OUTSIDE_WORKTREE" }),
    );

    const beforeMode = (await stat(externalModule)).mode;
    await expect(
      materializeRuntimeSourceCheckout(repository, {
        commit: git(repository, "rev-parse", "HEAD"),
      }),
    ).rejects.toBeInstanceOf(ProjectSourceValidationError);
    expect((await stat(externalModule)).mode).toBe(beforeMode);
  });

  test("validates source while adding and enabling a Project", async () => {
    const repository = await makeRepository();
    const home = await mkdtemp(join(tmpdir(), "kojo-source-service-test-"));
    cleanup.add(home);
    const store = await openSystemStore(home);
    const service = makeProjectService(store, (sourceStore, projectId, options) =>
      activateStoredProjectSource(sourceStore, projectId, {
        ...options,
        loadRegistry: async () => registry(),
      }),
    );
    try {
      const added = await service.add(repository);
      expect(added.availability).toEqual({ status: "Available" });
      expect(added.source?.revision?.workflows.map(({ name }) => name)).toEqual(["alpha", "beta"]);

      const manifest = JSON.parse(await Bun.file(join(repository, "package.json")).text());
      manifest.dependencies.effect = "4.0.0-beta.99";
      await write(join(repository, "package.json"), JSON.stringify(manifest));
      git(repository, "add", ".");
      git(repository, "commit", "-m", "break source compatibility");

      const failure = await service.enable(added.id).catch((error) => error);
      expect(failure).toBeInstanceOf(ProjectOperationError);
      expect(failure).toMatchObject({
        code: "PROJECT_UNAVAILABLE",
        reasons: [
          {
            code: "PROJECT_SOURCE_INVALID",
            diagnostics: [expect.objectContaining({ code: "INCOMPATIBLE_EFFECT" })],
          },
        ],
      });
      expect(store.projects.findById(added.id)?.registrationState).toBe("Disabled");
      expect(store.projectSources.findByProjectId(added.id)?.activeRevision).toBeNull();
    } finally {
      store.close();
    }
  });

  test("atomically replaces a valid source with an unavailable invalid candidate", async () => {
    const repository = await makeRepository();
    const home = await mkdtemp(join(tmpdir(), "kojo-source-store-test-"));
    cleanup.add(home);
    const store = await openSystemStore(home);
    const now = new Date().toISOString();
    store.projects.create({
      createdAt: now,
      id: "project-1",
      metadata: "{}",
      path: repository,
      registrationState: "Disabled",
      updatedAt: now,
    });
    try {
      const active = await activateStoredProjectSource(store, "project-1", {
        loadRegistry: async () => registry(),
        policy: "LocalWithFreshnessWarning",
        repository,
      });
      expect(
        JSON.parse(store.projectSources.findByProjectId("project-1")?.activeRevision ?? "null"),
      ).toMatchObject({
        commit: active.commit,
        workflows: [{ name: "alpha" }, { name: "beta" }],
      });

      await write(join(repository, "workflows/alpha.ts"), "const value = require('./shared.ts')\n");
      git(repository, "add", ".");
      git(repository, "commit", "-m", "invalid candidate");
      await expect(
        activateStoredProjectSource(store, "project-1", {
          loadRegistry: async () => registry(),
          policy: "LocalWithFreshnessWarning",
          repository,
        }),
      ).rejects.toBeInstanceOf(ProjectSourceValidationError);
      const rejected = store.projectSources.findByProjectId("project-1");
      expect(rejected?.activeRevision).toBeNull();
      expect(JSON.parse(rejected?.diagnostics ?? "[]")).toContainEqual(
        expect.objectContaining({ code: "AUTHORED_COMMONJS" }),
      );
      await expect(makeProjectService(store).list()).resolves.toMatchObject([
        {
          availability: {
            reasons: [
              {
                code: "PROJECT_SOURCE_INVALID",
                diagnostics: [expect.objectContaining({ code: "AUTHORED_COMMONJS" })],
              },
            ],
            status: "Unavailable",
          },
          source: { revision: null },
        },
      ]);
    } finally {
      store.close();
    }
  });
});
