import { Effect, FileSystem, Layer, Path } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";
import type { ExecResult } from "../models/ExecResult.ts";
import { SandboxError } from "../models/SandboxError.ts";
import type { AcquiredSandbox, SandboxHandle } from "../models/SandboxHandle.ts";
import { withEnvironment } from "../models/SandboxProvider.ts";
import type { SandboxRequest } from "../models/SandboxRequest.ts";
import { WorktreeState } from "../models/WorktreeState.ts";
import { SandboxSource } from "../ports/SandboxSource.ts";
import type { Workspace } from "../ports/Workspace.ts";
import * as BindMountWorkspace from "./BindMountWorkspace.ts";
import { acquireSandbox } from "./boundary.ts";
import * as SandboxExecWorkspace from "./SandboxExecWorkspace.ts";

/** What the host needs to answer a git question and to be a workspace. */
export type HostServices =
  | FileSystem.FileSystem
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner;

/**
 * Everything a sandbox scope asks for, answered by Sandcastle and by host git.
 *
 * Three members, three different machines' worth of concern, and keeping them on one port is what
 * lets `sandboxed` stay free of all of it: no filesystem, no process spawner, no container runtime
 * in its requirements, and therefore a unit test of the scope that needs none of them either.
 */
const make = Effect.gen(function* () {
  // Captured once, at layer build, and closed over. The port promises `Layer<Workspace,
  // SandboxError>` with nothing on its input side, so the host services a bind mount needs have to
  // be held here rather than demanded from whoever enters the scope.
  const host = yield* Effect.context<HostServices>();

  const hostWorkspace = (root: string) =>
    BindMountWorkspace.make({ root }).pipe(Effect.provideContext(host));

  /**
   * Make Sandcastle's own scratch directory invisible to git, before it exists.
   *
   * `.sandcastle/` is created in the repository the run was started from — logs, the worktrees the
   * branch is checked out into, patch directories — and none of it belongs in anybody's history.
   * Left visible it is not merely untidy: **the merge refuses to land on a trunk that has untracked
   * files**, so the first run of a freshly stamped factory would reach its merge, find `?? .sandcastle/`
   * and stop with "main holds uncommitted changes". Measured on ticket 45, walking the loop by hand.
   *
   * A `.gitignore` holding `*` inside the directory is the fix that costs nobody anything: it ignores
   * itself and everything beside it, it needs no edit to the repository's own `.gitignore` — which is
   * the person's file, and which the scaffolder refuses to touch for good reasons — and it is written
   * once and then found already there.
   *
   * Best effort. A repository that will not take this file has something else wrong with it, and the
   * acquisition below says what that is far better than a failure here would.
   */
  const ignoreOwnScratch = (cwd: string | undefined) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = path.join(path.resolve(cwd ?? process.cwd()), ".sandcastle");
      yield* fileSystem.makeDirectory(directory, { recursive: true });
      yield* fileSystem.writeFileString(path.join(directory, ".gitignore"), "*\n");
    }).pipe(Effect.provideContext(host), Effect.ignore);

  /**
   * Read the worktree with host git, whatever the provider is.
   *
   * Host git, not `sandbox.exec`, and the difference is not an optimisation. An isolated provider
   * runs commands in a container that holds a copy of the tree and none of the repository, so
   * asking it about `origin` would get an answer about nothing. The branch lives on the host; the
   * question belongs there too.
   */
  const worktree = (sandbox: AcquiredSandbox): Effect.Effect<WorktreeState, SandboxError> =>
    Effect.gen(function* () {
      const workspace = yield* hostWorkspace(sandbox.worktreePath);

      const git = (args: ReadonlyArray<string>): Effect.Effect<ExecResult, SandboxError> =>
        workspace.git(args).pipe(
          Effect.mapError(
            (cause) =>
              new SandboxError({
                operation: "exec",
                target: `git ${args.join(" ")}`,
                reason: cause.reason,
                cause,
              }),
          ),
        );

      // `--abbrev-ref HEAD` answers the literal word `HEAD` when nothing is checked out, which is
      // how a detached tree tells you so. Reading it as a branch name would produce a run that
      // believes it is on a branch called HEAD.
      const head = yield* git(["rev-parse", "--abbrev-ref", "HEAD"]);
      const named = head.stdout.trim();
      const detached = !head.succeeded || named === "HEAD";

      // Tracked changes only. `copyToWorktree` lands untracked files in this tree on purpose, and a
      // reading that counted them would condemn every run that uses the feature.
      const status = yield* git(["status", "--porcelain", "--untracked-files=no"]);

      const upstream = `refs/remotes/origin/${sandbox.branch}`;
      const remote = yield* git(["rev-parse", "--verify", "--quiet", upstream]);
      const counts = remote.succeeded
        ? yield* git(["rev-list", "--left-right", "--count", `${upstream}...HEAD`])
        : undefined;

      // `--left-right --count origin...HEAD` prints "<only on origin>\t<only here>". Left is what
      // the worktree is missing; right is what this run has produced and is not a fault.
      const [behind = "0", ahead = "0"] = counts?.stdout.trim().split(/\s+/) ?? [];

      return new WorktreeState({
        head: detached ? "" : named,
        detached,
        modified: status.stdout.trim() !== "",
        tracked: remote.succeeded,
        behind: Number(behind),
        ahead: Number(ahead),
      });
    });

  return {
    acquire: (request: SandboxRequest) =>
      Effect.andThen(ignoreOwnScratch(request.cwd), () =>
        acquireSandbox({
          branch: request.branch,
          // The provider is rebuilt with this acquisition's environment rather than used as the
          // author wrote it. `CreateSandboxOptions` has no `env`, so this is the only door.
          provider: withEnvironment(request.provider, request.environment),
          ...(request.baseBranch === undefined ? {} : { baseBranch: request.baseBranch }),
          ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
          ...(request.hooks === undefined ? {} : { hooks: request.hooks }),
          ...(request.copyToWorktree === undefined
            ? {}
            : { copyToWorktree: request.copyToWorktree }),
        }),
      ),

    worktree,

    workspace: (sandbox: SandboxHandle): Layer.Layer<Workspace, SandboxError> =>
      // An isolated provider's tree is only reachable through `exec`; everywhere else the worktree
      // is a directory on this machine, which is faster and which a human can open while the run
      // is suspended.
      sandbox.capabilities.kind === "isolated"
        ? SandboxExecWorkspace.layer(sandbox)
        : BindMountWorkspace.layer({ root: sandbox.worktreePath }).pipe(
            Layer.provide(Layer.succeedContext(host)),
          ),
  } satisfies SandboxSource["Service"];
});

/**
 * The reference adapter: real worktrees, real containers, real git.
 *
 * Its host requirements are on the **layer**, not on the port, so they are paid once where the
 * factory is assembled instead of by every scope in every workflow.
 */
export const layer: Layer.Layer<SandboxSource, never, HostServices> = Layer.effect(
  SandboxSource,
  make,
);
