import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { TestConsole } from "effect/testing";
import type { DockerRunInput } from "../../src/types/preview";
import {
  type PreviewContainerState,
  PreviewDocker,
  PreviewReadiness,
} from "../../src/workflows/preview/services";
import { startPreview } from "../../src/workflows/preview/start";
import { stopPreview } from "../../src/workflows/preview/stop";
import { resolveWorktree } from "../../src/workflows/preview/worktree";
import { runEffect } from "../helpers/effect";
import { runGit } from "../helpers/git";

const temporaryDirectories: Array<string> = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

const createRepositoryWithPreviewBranches = async () => {
  const repository = await mkdtemp(join(tmpdir(), "sandcastle-preview-"));
  temporaryDirectories.push(repository);
  await runGit(repository, "init", "--initial-branch=main");
  await runGit(repository, "config", "user.email", "sandcastle@example.test");
  await runGit(repository, "config", "user.name", "Sandcastle Test");
  await Bun.write(join(repository, "preview.txt"), "base\n");
  await runGit(repository, "add", "preview.txt");
  await runGit(repository, "commit", "-m", "test: base");
  for (const branch of ["feat/one", "feat/two"]) {
    await runGit(repository, "branch", branch);
    await runGit(
      repository,
      "worktree",
      "add",
      join(repository, ".sandcastle", "worktrees", branch.replace("/", "-")),
      branch,
    );
  }
  return repository;
};

describe("preview lifecycle", () => {
  test("previews the checked-out primary branch from a distinct clean exact worktree", async () => {
    const repository = await createRepositoryWithPreviewBranches();
    const committedRevision = await runGit(repository, "rev-parse", "refs/heads/main");
    await Bun.write(join(repository, "preview.txt"), "uncommitted primary checkout change\n");

    const worktree = await runEffect(
      resolveWorktree(repository, "main").pipe(Effect.provide(BunServices.layer)),
    );

    expect(worktree).not.toBe(repository);
    expect(await runGit(worktree, "rev-parse", "HEAD")).toBe(committedRevision);
    expect(await runGit(worktree, "branch", "--show-current")).toBe("");
    expect(await runGit(worktree, "status", "--porcelain", "--untracked-files=all")).toBe("");
  });

  test("reuses the dedicated preview worktree at the branch's latest exact commit", async () => {
    const repository = await createRepositoryWithPreviewBranches();
    const firstWorktree = await runEffect(
      resolveWorktree(repository, "main").pipe(Effect.provide(BunServices.layer)),
    );
    await Bun.write(join(repository, "preview.txt"), "advanced main\n");
    await runGit(repository, "add", "preview.txt");
    await runGit(repository, "commit", "-m", "test: advance main");
    const advancedRevision = await runGit(repository, "rev-parse", "refs/heads/main");

    const reusedWorktree = await runEffect(
      resolveWorktree(repository, "main").pipe(Effect.provide(BunServices.layer)),
    );

    expect(reusedWorktree).toBe(firstWorktree);
    expect(await runGit(reusedWorktree, "rev-parse", "HEAD")).toBe(advancedRevision);
    expect(await runGit(reusedWorktree, "branch", "--show-current")).toBe("");
    expect(await runGit(reusedWorktree, "status", "--porcelain", "--untracked-files=all")).toBe("");
  });

  test("creates a preview worktree from a remote-only branch", async () => {
    const root = await mkdtemp(join(tmpdir(), "sandcastle-preview-remote-"));
    temporaryDirectories.push(root);
    const remote = join(root, "remote.git");
    const repository = join(root, "repository");
    await runGit(root, "init", "--bare", remote);
    await runGit(root, "init", "--initial-branch=main", repository);
    await runGit(repository, "config", "user.email", "sandcastle@example.test");
    await runGit(repository, "config", "user.name", "Sandcastle Test");
    await Bun.write(join(repository, "preview.txt"), "base\n");
    await runGit(repository, "add", "preview.txt");
    await runGit(repository, "commit", "-m", "test: base");
    await runGit(repository, "remote", "add", "origin", remote);
    await runGit(repository, "push", "-u", "origin", "main");
    await runGit(repository, "switch", "-c", "feat/remote");
    await Bun.write(join(repository, "preview.txt"), "remote branch\n");
    await runGit(repository, "add", "preview.txt");
    await runGit(repository, "commit", "-m", "feat: remote preview");
    const remoteRevision = await runGit(repository, "rev-parse", "HEAD");
    await runGit(repository, "push", "-u", "origin", "feat/remote");
    await runGit(repository, "switch", "main");
    await runGit(repository, "branch", "-D", "feat/remote");

    const worktree = await runEffect(
      resolveWorktree(repository, "feat/remote").pipe(Effect.provide(BunServices.layer)),
    );

    expect(await runGit(worktree, "branch", "--show-current")).toBe("");
    expect(await runGit(worktree, "rev-parse", "HEAD")).toBe(remoteRevision);
  });

  test("keeps another branch preview running when one preview stops", async () => {
    const repository = await createRepositoryWithPreviewBranches();
    const originalBranchWorktrees = new Map([
      ["feat/one", join(repository, ".sandcastle", "worktrees", "feat-one")],
      ["feat/two", join(repository, ".sandcastle", "worktrees", "feat-two")],
    ]);
    const containers = new Map<string, { input: DockerRunInput; port: number; revision: string }>();
    const createdInputs: Array<DockerRunInput> = [];
    let nextPort = 6101;
    const inspect = (containerName: string): PreviewContainerState => {
      const container = containers.get(containerName);
      return container
        ? {
            status: "running",
            port: container.port,
            revision: container.revision,
            worktreePath: container.input.worktreePath,
          }
        : { status: "missing" };
    };
    const docker = PreviewDocker.of({
      assertReady: () => Effect.void,
      create: (input) =>
        Effect.promise(async () => {
          const revision = await runGit(input.worktreePath, "rev-parse", "HEAD");
          containers.set(input.identity.containerName, { input, port: nextPort, revision });
          createdInputs.push(input);
          nextPort += 1;
        }),
      initialize: (containerName) => Effect.sync(() => containers.get(containerName)?.port ?? 0),
      inspect: (containerName) => Effect.sync(() => inspect(containerName)),
      prepareImage: () => Effect.succeed("sha256:preview"),
      readLogs: () => Effect.succeed(""),
      remove: (containerName) =>
        Effect.sync(() => {
          containers.delete(containerName);
        }),
    });
    const readiness = PreviewReadiness.of({ wait: () => Effect.void });

    const state = await runEffect(
      Effect.gen(function* () {
        yield* startPreview(repository, "feat/one");
        yield* startPreview(repository, "feat/two");
        const docker = yield* PreviewDocker;
        const beforeStop = yield* Effect.all([
          docker.inspect([...containers.keys()][0] ?? ""),
          docker.inspect([...containers.keys()][1] ?? ""),
        ]);
        yield* stopPreview(repository, "feat/one");
        const remaining = [...containers.keys()][0] ?? "";
        return { beforeStop, remaining: yield* docker.inspect(remaining) };
      }).pipe(
        Effect.provideService(PreviewDocker, docker),
        Effect.provideService(PreviewReadiness, readiness),
        Effect.provide(TestConsole.layer),
        Effect.provide(BunServices.layer),
      ),
    );

    expect(state.beforeStop).toMatchObject([
      { status: "running", port: 6101 },
      { status: "running", port: 6102 },
    ]);
    expect(state.remaining).toMatchObject({ status: "running", port: 6102 });
    expect(containers.size).toBe(1);
    expect(createdInputs).toHaveLength(2);
    for (const input of createdInputs) {
      expect(input.worktreePath).not.toBe(originalBranchWorktrees.get(input.identity.branch));
      expect(await runGit(input.worktreePath, "rev-parse", "--is-inside-work-tree")).toBe("true");
      expect(await runGit(input.worktreePath, "branch", "--show-current")).toBe("");
      expect(await runGit(input.worktreePath, "rev-parse", "HEAD")).toBe(
        await runGit(repository, "rev-parse", `refs/heads/${input.identity.branch}`),
      );
    }
  });

  test("recreates a stale running preview and reuses its healthy exact replacement", async () => {
    const repository = await createRepositoryWithPreviewBranches();
    const containers = new Map<string, { input: DockerRunInput; port: number; revision: string }>();
    const createdInputs: Array<DockerRunInput> = [];
    const removedContainers: Array<string> = [];
    let nextPort = 6201;
    const docker = PreviewDocker.of({
      assertReady: () => Effect.void,
      create: (input) =>
        Effect.promise(async () => {
          const revision = await runGit(input.worktreePath, "rev-parse", "HEAD");
          containers.set(input.identity.containerName, { input, port: nextPort, revision });
          createdInputs.push(input);
          nextPort += 1;
        }),
      initialize: (containerName) => Effect.sync(() => containers.get(containerName)?.port ?? 0),
      inspect: (containerName) =>
        Effect.sync(() => {
          const container = containers.get(containerName);
          return container
            ? ({
                status: "running",
                port: container.port,
                revision: container.revision,
                worktreePath: container.input.worktreePath,
              } as const)
            : ({ status: "missing" } as const);
        }),
      prepareImage: () => Effect.succeed("sha256:preview"),
      readLogs: () => Effect.succeed(""),
      remove: (containerName) =>
        Effect.sync(() => {
          containers.delete(containerName);
          removedContainers.push(containerName);
        }),
    });
    const readiness = PreviewReadiness.of({ wait: () => Effect.void });

    await runEffect(
      startPreview(repository, "main").pipe(
        Effect.provideService(PreviewDocker, docker),
        Effect.provideService(PreviewReadiness, readiness),
        Effect.provide(TestConsole.layer),
        Effect.provide(BunServices.layer),
      ),
    );
    await Bun.write(join(repository, "preview.txt"), "advanced main\n");
    await runGit(repository, "add", "preview.txt");
    await runGit(repository, "commit", "-m", "test: advance running preview");
    const advancedRevision = await runGit(repository, "rev-parse", "refs/heads/main");

    await runEffect(
      startPreview(repository, "main").pipe(
        Effect.provideService(PreviewDocker, docker),
        Effect.provideService(PreviewReadiness, readiness),
        Effect.provide(TestConsole.layer),
        Effect.provide(BunServices.layer),
      ),
    );

    expect(createdInputs).toHaveLength(2);
    expect(removedContainers).toHaveLength(1);
    const recreated = createdInputs[1];
    if (!recreated) throw new Error("preview was not recreated");
    expect(await runGit(recreated.worktreePath, "rev-parse", "HEAD")).toBe(advancedRevision);

    await runEffect(
      startPreview(repository, "main").pipe(
        Effect.provideService(PreviewDocker, docker),
        Effect.provideService(PreviewReadiness, readiness),
        Effect.provide(TestConsole.layer),
        Effect.provide(BunServices.layer),
      ),
    );

    expect(createdInputs).toHaveLength(2);
    expect(removedContainers).toHaveLength(1);
  });
});
