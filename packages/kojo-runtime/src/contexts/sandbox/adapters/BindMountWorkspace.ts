import { Effect, FileSystem, Layer, Option, Path, type PlatformError, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { ExecResult } from "../models/ExecResult.ts";
import { FileStat } from "../models/FileStat.ts";
import { WorkspaceError, type WorkspaceOperation } from "../models/WorkspaceError.ts";
import type { ExecOptions } from "../ports/Workspace.ts";
import { Workspace } from "../ports/Workspace.ts";

/** Eight platform types collapse to the three a check can act on. */
const kindOf = (type: FileSystem.File.Info["type"]): FileStat["kind"] =>
  type === "File" ? "file" : type === "Directory" ? "directory" : "other";

const platformFailure =
  (operation: WorkspaceOperation, target: string) => (cause: PlatformError.PlatformError) =>
    new WorkspaceError({ operation, target, reason: cause.message, cause });

const isNotFound = (error: PlatformError.PlatformError): boolean =>
  error.reason._tag === "NotFound";

/**
 * The service itself, exported beside the layer.
 *
 * A caller that already holds a scope and needs a workspace for a directory it has just been handed
 * — `SandcastleSandboxSource`, reading the worktree of a sandbox it built a moment ago — would
 * otherwise have to build a whole layer to ask git one question.
 */
export const make = (options: { readonly root: string }) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const root = path.resolve(options.root);

    /**
     * A path is only a workspace path if it stays inside the workspace.
     *
     * Without this, `read("../../.ssh/id_ed25519")` is a working method call: the port promises a
     * bounded tree and would quietly hand back the host. The in-memory adapter refuses the same
     * paths, so a check cannot pass in a test by escaping a root that a test does not have.
     */
    const resolve = (
      operation: WorkspaceOperation,
      target: string,
    ): Effect.Effect<string, WorkspaceError> => {
      const resolved = path.resolve(root, target);
      return resolved === root || resolved.startsWith(root + path.sep)
        ? Effect.succeed(resolved)
        : Effect.fail(
            new WorkspaceError({
              operation,
              target,
              reason: `the path leaves the workspace root ${root}`,
              cause: undefined,
            }),
          );
    };

    const exec = (
      argv: ReadonlyArray<string>,
      execOptions?: ExecOptions,
    ): Effect.Effect<ExecResult, WorkspaceError> => {
      const [head, ...rest] = argv;
      if (head === undefined) {
        return Effect.fail(
          new WorkspaceError({
            operation: "exec",
            target: "",
            reason: "a command needs at least one word",
            cause: undefined,
          }),
        );
      }

      return resolve("exec", execOptions?.cwd ?? ".").pipe(
        Effect.flatMap((cwd) =>
          Effect.gen(function* () {
            const handle = yield* spawner.spawn(
              ChildProcess.make(head, rest, { cwd, env: execOptions?.env, extendEnv: true }),
            );

            // Drained concurrently on purpose. Read one pipe to the end before the other and a
            // command that fills the pipe you are not reading blocks forever — a hang that only
            // shows up on the chattiest run, which is the one you most need the output of.
            const [stdout, stderr] = yield* Effect.all(
              [
                handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
                handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
              ],
              { concurrency: 2 },
            );
            const exitCode = yield* handle.exitCode;

            return new ExecResult({ argv, exitCode, stdout, stderr });
          }).pipe(Effect.scoped, Effect.mapError(platformFailure("exec", argv.join(" ")))),
        ),
      );
    };

    return {
      root,
      hostPath: Option.some(root),
      exec,
      git: (args: ReadonlyArray<string>) => exec(["git", ...args]),
      read: (target: string) =>
        resolve("read", target).pipe(
          Effect.flatMap((resolved) =>
            fileSystem
              .readFileString(resolved)
              .pipe(Effect.mapError(platformFailure("read", target))),
          ),
        ),
      write: (target: string, content: string) =>
        resolve("write", target).pipe(
          Effect.flatMap((resolved) =>
            fileSystem
              .makeDirectory(path.dirname(resolved), { recursive: true })
              .pipe(
                Effect.andThen(fileSystem.writeFileString(resolved, content)),
                Effect.mapError(platformFailure("write", target)),
              ),
          ),
        ),
      stat: (target: string) =>
        resolve("stat", target).pipe(
          Effect.flatMap((resolved) =>
            fileSystem.stat(resolved).pipe(
              Effect.map((info) =>
                Option.some(new FileStat({ kind: kindOf(info.type), size: Number(info.size) })),
              ),
              Effect.catchIf(isNotFound, () => Effect.succeed(Option.none<FileStat>())),
              Effect.mapError(platformFailure("stat", target)),
            ),
          ),
        ),
      unlink: (target: string) =>
        resolve("unlink", target).pipe(
          Effect.flatMap((resolved) =>
            fileSystem
              .remove(resolved, { recursive: true })
              .pipe(Effect.mapError(platformFailure("unlink", target))),
          ),
        ),
    } satisfies Workspace["Service"];
  });

/**
 * The workspace as a directory on the host — the worktree a run is checked out into.
 *
 * Fast and debuggable: the tree is on the disk of the machine you are already logged into, so
 * `hostPath` is `Some` and a human can open it while the run is suspended. The isolated variant
 * (everything through `sandbox.exec`) is the same port with `hostPath` as `None`.
 */
export const layer = (options: {
  readonly root: string;
}): Layer.Layer<
  Workspace,
  never,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> => Layer.effect(Workspace, make(options));
