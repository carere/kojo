import { Effect, Layer, Option } from "effect";
import { ExecResult } from "../../src/contexts/sandbox/models/ExecResult.ts";
import { FileStat } from "../../src/contexts/sandbox/models/FileStat.ts";
import { WorkspaceError } from "../../src/contexts/sandbox/models/WorkspaceError.ts";
import { Workspace } from "../../src/contexts/sandbox/ports/Workspace.ts";

/**
 * A workspace whose change-set moves, which is the one thing the seeded in-memory adapter cannot do.
 *
 * The permission guard fingerprints the tree, lets an agent run, and fingerprints it again, so a
 * test needs the same `git diff HEAD --numstat` to answer differently on the two calls. This fake
 * holds the change-set itself: the test mutates it to say what the agent did, and the fake renders
 * it the way git would. Undoing mutates it too, so a rollback outcome is observed in the tree
 * rather than read back from the guard's own report.
 *
 * Everything is in memory and nothing spawns, so this stays a unit-tier double.
 */
export interface FingerprintedTree {
  /** Path to fingerprint: `"added,deleted"` for a tracked change, `"untracked"` for a new file. */
  readonly changes: Map<string, string>;
  readonly layer: Layer.Layer<Workspace>;
}

/** The fingerprint the guard reads as "git does not track this yet". */
export const untracked = "untracked";

export const fingerprintedTree = (
  initial: Record<string, string>,
  options?: {
    /** Paths whose undo the fake refuses, so the outcome that cannot be undone is reachable. */
    readonly refuses?: ReadonlyArray<string>;
    /** Tracked paths that `HEAD` does not hold — a file the agent created and then staged. */
    readonly absentFromHead?: ReadonlyArray<string>;
    /** Make `git diff` exit non-zero, which is a repository the guard cannot see. */
    readonly unreadable?: boolean;
  },
): FingerprintedTree => {
  const changes = new Map(Object.entries(initial));
  const refuses = new Set(options?.refuses ?? []);
  const absentFromHead = new Set(options?.absentFromHead ?? []);

  const answer = (argv: ReadonlyArray<string>, exitCode: number, stdout: string, stderr: string) =>
    Effect.succeed(new ExecResult({ argv, exitCode, stdout, stderr }));

  const unmodelled = (operation: "read" | "exec", target: string) =>
    Effect.fail(
      new WorkspaceError({
        operation,
        target,
        reason: "this fake models only the fingerprint and the rollback",
        cause: undefined,
      }),
    );

  const remove = (argv: ReadonlyArray<string>, path: string) => {
    if (refuses.has(path)) return answer(argv, 1, "", `error: ${path} refused the undo`);
    changes.delete(path);
    return answer(argv, 0, "", "");
  };

  const git = (args: ReadonlyArray<string>): Effect.Effect<ExecResult, WorkspaceError> => {
    const argv = ["git", ...args];
    const line = args.join(" ");

    if (line === "diff HEAD --numstat") {
      if (options?.unreadable === true) {
        return answer(argv, 128, "", "fatal: bad revision 'HEAD'");
      }
      const lines = [...changes]
        .filter(([, fingerprint]) => fingerprint !== untracked)
        .map(([path, fingerprint]) => `${fingerprint.replace(",", "\t")}\t${path}`);
      return answer(argv, 0, lines.join("\n"), "");
    }

    if (line === "ls-files --others --exclude-standard") {
      const lines = [...changes]
        .filter(([, fingerprint]) => fingerprint === untracked)
        .map(([path]) => path);
      return answer(argv, 0, lines.join("\n"), "");
    }

    // Both undo commands end with `-- <path>`, so the path is the last argument of either.
    const target = args[args.length - 1] ?? "";

    if (args[0] === "checkout" && args[1] === "HEAD") {
      if (absentFromHead.has(target)) {
        return answer(argv, 1, "", `error: pathspec '${target}' did not match any file(s)`);
      }
      return remove(argv, target);
    }

    if (args[0] === "rm") return remove(argv, target);

    return unmodelled("exec", argv.join(" "));
  };

  return {
    changes,
    layer: Layer.succeed(Workspace, {
      root: "/workspace",
      hostPath: Option.none(),
      exec: (argv) => unmodelled("exec", argv.join(" ")),
      git,
      read: (path) => unmodelled("read", path),
      /** What an agent doing its work looks like from here: the path joins the change-set. */
      write: (path, _content) =>
        Effect.sync(() => {
          if (!changes.has(path)) changes.set(path, untracked);
        }),
      stat: (path) =>
        Effect.succeed(
          changes.has(path)
            ? Option.some(new FileStat({ kind: "file", size: 0 }))
            : Option.none<FileStat>(),
        ),
      unlink: (path) =>
        refuses.has(path)
          ? Effect.fail(
              new WorkspaceError({
                operation: "unlink",
                target: path,
                reason: "refused the undo",
                cause: undefined,
              }),
            )
          : Effect.sync(() => {
              changes.delete(path);
            }),
    }),
  };
};
