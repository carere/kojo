import { Effect, FileSystem, Layer, Path } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";
import {
  canHide,
  hiddenFiles,
  hideFiles,
  listHidden,
  pathspecsOf,
  restoreFiles,
  showFiles,
} from "../guards/hiddenPaths.ts";
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
   * Host git, in one worktree, with a `SandboxError` on the channel.
   *
   * Host git, not `sandbox.exec`, and the difference is not an optimisation. An isolated provider
   * runs commands in a container that holds a copy of the tree and none of the repository, so
   * asking it about `origin` would get an answer about nothing. The branch lives on the host; the
   * question belongs there too.
   *
   * A non-zero exit is **not** an error here — it is a reading, in the `ExecResult`. Every caller
   * below wants to say something different about a git command that ran and refused.
   */
  const gitIn = (root: string) =>
    Effect.map(
      hostWorkspace(root),
      (workspace) =>
        (args: ReadonlyArray<string>): Effect.Effect<ExecResult, SandboxError> =>
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
          ),
    );

  /** A git command that ran and refused, named as the lifecycle step it stopped. */
  const refused = (
    operation: "create" | "close",
    branch: string,
    result: ExecResult,
  ): SandboxError =>
    new SandboxError({
      operation,
      target: branch,
      reason: `${result.argv.join(" ")} exited ${result.exitCode}: ${
        result.stderr.trim() === "" ? result.stdout.trim() : result.stderr.trim()
      }`,
      cause: undefined,
    });

  /**
   * Put the factory's own files back into the worktree, on the way out.
   *
   * Nothing about the **branch** depends on this — the index was never modified, so every commit the
   * run made already carries the original blobs. What depends on it is the directory a human may
   * open: an unmasked worktree, and a `git status` that reads clean so that `sandbox.close()` removes
   * the worktree instead of preserving it as "uncommitted work".
   *
   * The release half of `hide`'s own `acquireRelease`, so it runs on a suspension too: a gate leaves
   * the tree honest for whoever looks at it, and the next acquisition masks it again. It is
   * registered **after** `acquireSandbox`'s release and therefore runs **before** it — the tree is
   * put back while the sandbox still exists, and only then is Sandcastle asked to close it and to
   * read that tree for uncommitted work.
   *
   * **Best effort with a warning, never a failure.** The order is load-bearing and the reason it can
   * fail is not — a release that turned a two-day suspension into a defect over a file it could put
   * back on the next acquisition would be the worse of the two faults.
   */
  const showAgain = (root: string, files: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const git = yield* gitIn(root);
      const shown = yield* git(showFiles(files));
      const restored = shown.succeeded ? yield* git(restoreFiles(files)) : shown;
      if (!restored.succeeded) {
        yield* Effect.logWarning(
          `the factory's own files were left out of ${root}: ${refused("close", root, restored).reason}`,
        );
      }
    }).pipe(
      Effect.catchTag("SandboxError", (error) =>
        Effect.logWarning(`the factory's own files were left out of ${root}: ${error.reason}`),
      ),
    );

  /**
   * Take the factory's own files out of the tree the agent is given, for the life of the scope.
   *
   * Three steps, and the order of them is the whole implementation — see `guards/hiddenPaths.ts` for
   * what each one is defending and what none of them can defend. Narrow the pathspecs to the files
   * git actually tracks, mark those `--skip-worktree`, then delete them from disk.
   *
   * **Applied after the sandbox exists, not through a hook.** A bind mount is live — the container
   * reads the host's own inodes, so a file removed now is a file the container cannot open — and
   * `none` *is* the host. Nothing runs inside the sandbox between `createSandbox` resolving and this
   * returning, so there is no window to close, and doing it here rather than in
   * `hooks.host.onWorktreeReady` leaves that slot entirely to the author. A factory that installs its
   * dependencies there (this repository's does) would otherwise have to be merged with Kojo's own
   * hook and kept in the right order forever.
   *
   * **`acquireRelease` rather than `addFinalizer`, and this is an argument rather than a measurement.**
   * The two halves belong to one another: the acquisition is uninterruptible by the combinator's own
   * contract, so an interrupt arriving mid-mask cannot leave a worktree git has been told to ignore
   * with the files still on disk; and the un-mask is registered by the same mechanism that registers
   * `sandbox.close()` one line above, which is what makes "un-mask first, then close" a property of
   * the shape instead of a fact about where two calls happen to sit. An earlier version used
   * `Effect.addFinalizer`, and a container that survived a gate was blamed on it — wrongly. The
   * fixture that failed carries no `.kojo/` at all, so this function is a no-op there, and the same
   * failure was then measured at 1 run in 4 **with and without** the whole ticket: it is the exit-127
   * Docker Desktop fault `fixtureRoot` in `lane.test.ts` is written about. Recorded because the wrong
   * diagnosis is the more expensive half of the story.
   *
   * A failure here fails the acquisition, which is right: a mask that could not be applied is a
   * sandbox that is not what the workflow asked for, and `acquire` rebuilds or reports it like any
   * other refusal to create. **With one exception, and it is the whole reason `sandboxed` probes the
   * workspace before it reads the worktree**: a worktree directory that is not there at all is not a
   * mask that failed. It is a workspace that is gone — a fault the caller can recover from by
   * building another container — and failing here would replace *"the workspace is unreachable"* with
   * a message about `git ls-files`, which is the substitution that ordering exists to prevent. So an
   * absent tree is skipped, silently, and the probe two steps later says what is actually wrong.
   */
  const hide = (request: SandboxRequest, sandbox: AcquiredSandbox) => {
    const root = sandbox.worktreePath;

    /** The files actually taken out of the worktree. Empty means the mask did nothing at all. */
    const apply: Effect.Effect<ReadonlyArray<string>, SandboxError> = Effect.gen(function* () {
      if (!canHide(sandbox.capabilities.kind)) return [];
      const pathspecs = pathspecsOf(request.hidden);
      if (pathspecs.length === 0) return [];

      const present = yield* Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        return yield* fileSystem.exists(root);
      }).pipe(
        Effect.provideContext(host),
        Effect.orElseSucceed(() => false),
      );
      if (!present) return [];

      const git = yield* gitIn(root);

      const listed = yield* git(listHidden(pathspecs));
      if (!listed.succeeded) return yield* refused("create", request.branch, listed);
      const files = hiddenFiles(listed.stdout);
      if (files.length === 0) return [];

      const marked = yield* git(hideFiles(files));
      if (!marked.succeeded) return yield* refused("create", request.branch, marked);

      yield* Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* Effect.forEach(
          files,
          // `force`, because a tracked file may already be absent from a tree somebody else touched,
          // and the mask has done its job either way.
          (file) => fileSystem.remove(path.join(root, file), { force: true }),
          { discard: true },
        );
      }).pipe(
        Effect.provideContext(host),
        Effect.mapError(
          (cause) =>
            new SandboxError({
              operation: "create",
              target: request.branch,
              reason: `the factory's own files could not be taken out of ${root}: ${cause.message}`,
              cause,
            }),
        ),
      );

      return files;
    });

    return Effect.acquireRelease(apply, (files) =>
      files.length === 0 ? Effect.void : showAgain(root, files),
    );
  };

  /** Read the worktree as it stands, with host git. An observation; the guard decides what it means. */
  const worktree = (sandbox: AcquiredSandbox): Effect.Effect<WorktreeState, SandboxError> =>
    Effect.gen(function* () {
      const git = yield* gitIn(sandbox.worktreePath);

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
    acquire: (request: SandboxRequest, observer) =>
      Effect.andThen(ignoreOwnScratch(request.cwd), () =>
        acquireSandbox(
          {
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
            // The mask goes on after the tree is cut and the author's hooks have run, and comes off in
            // a finalizer of this same scope — which is registered second and therefore runs *first*,
            // before Sandcastle is asked to close the sandbox and reads the tree for uncommitted work.
          },
          observer,
        ).pipe(
          Effect.tap((sandbox) => observer?.acquired(sandbox) ?? Effect.void),
          Effect.tap((sandbox) => hide(request, sandbox)),
        ),
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
