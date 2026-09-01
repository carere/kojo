import { Effect, Layer, Option } from "effect";
import { ExecResult } from "../models/ExecResult.ts";
import { FileStat } from "../models/FileStat.ts";
import { SandboxError } from "../models/SandboxError.ts";
import type { AcquiredSandbox } from "../models/SandboxHandle.ts";
import { WorkspaceError, type WorkspaceOperation } from "../models/WorkspaceError.ts";
import type { ExecOptions } from "../ports/Workspace.ts";
import { Workspace } from "../ports/Workspace.ts";

/**
 * POSIX single-quoting — the one escaping every shell in every image agrees on.
 *
 * The port takes an argv and Sandcastle takes a command line, so something has to join them. Doing
 * it by `join(" ")` would let a path with a space, a semicolon or a backtick become a second
 * command; quoting every word means the shell sees exactly the words the caller wrote.
 */
const quote = (word: string): string => `'${word.replaceAll("'", "'\\''")}'`;

/** The directory a path sits in. String work, because there is no host `Path` to ask. */
const parentOf = (path: string): string => {
  const cut = path.lastIndexOf("/");
  return cut <= 0 ? "/" : path.slice(0, cut);
};

const refuse = (
  operation: WorkspaceOperation,
  target: string,
  reason: string,
): Effect.Effect<never, WorkspaceError> =>
  Effect.fail(new WorkspaceError({ operation, target, reason, cause: undefined }));

/** What the command itself said went wrong, and a fallback for the command that said nothing. */
const said = (result: ExecResult, fallback: string): string => {
  const spoken = result.stderr.trim();
  return spoken === "" ? fallback : spoken;
};

/**
 * The same escape rule the other two adapters enforce, applied to a tree only the sandbox can see.
 *
 * Purely textual, and it has to be: there is no host filesystem here to resolve against, so an
 * absolute path is refused rather than read as relative. A check that passed against a container
 * only because this adapter was more forgiving than the bind-mount one would be a check that lies.
 */
const inside = (
  operation: WorkspaceOperation,
  target: string,
): Effect.Effect<string, WorkspaceError> => {
  if (target.startsWith("/"))
    return refuse(operation, target, "a workspace path is relative to the root");

  const segments: Array<string> = [];
  for (const segment of target.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment !== "..") {
      segments.push(segment);
      continue;
    }
    if (segments.length === 0)
      return refuse(operation, target, "the path leaves the workspace root");
    segments.pop();
  }
  return Effect.succeed(segments.join("/"));
};

/**
 * `stat` as one portable shell sentence: `<kind> <size>`.
 *
 * Not `stat -c` and not `stat -f` — those are GNU's and BSD's, and the same check has to answer on
 * a Debian image, an Alpine one, and a developer's Mac. `test` and `wc` are in POSIX, so this reads
 * the same everywhere. A path that holds nothing prints `none`, because absence is an answer.
 */
const statScript = (path: string): string => {
  const p = quote(path);
  return (
    `if [ -f ${p} ]; then printf 'file %s' "$(wc -c < ${p} | tr -d ' ')"; ` +
    `elif [ -d ${p} ]; then printf 'directory 0'; ` +
    `elif [ -e ${p} ] || [ -L ${p} ]; then printf 'other 0'; ` +
    `else printf 'none 0'; fi`
  );
};

/** `rm` that tells absence apart from failure, because the port does too. */
const unlinkScript = (path: string): string => {
  const p = quote(path);
  return `if [ -e ${p} ] || [ -L ${p} ]; then rm -rf ${p}; else exit 66; fi`;
};

/** The exit code `unlinkScript` reserves for "there was nothing there". */
const nothingThere = 66;

/**
 * The root, asked of the sandbox rather than assumed of it.
 *
 * Sandcastle defaults `exec`'s cwd to the sandbox repo path and does not publish what that path is
 * — it is `/repo` on one provider and a worktree path on another. So the adapter runs one command
 * to find out. Guessing would put every later path one directory away from the tree the agent
 * wrote in, which is the exact failure this port exists to prevent.
 */
const rootOf = (sandbox: AcquiredSandbox): Effect.Effect<string, SandboxError> =>
  sandbox.exec("pwd").pipe(
    Effect.flatMap((result) =>
      result.succeeded
        ? Effect.succeed(result.stdout.trim())
        : Effect.fail(
            new SandboxError({
              operation: "exec",
              target: "pwd",
              reason: said(result, `pwd exited ${result.exitCode}`),
              cause: undefined,
            }),
          ),
    ),
  );

const service = (sandbox: AcquiredSandbox, root: string): Workspace["Service"] => {
  const at = (relative: string): string => (relative === "" ? root : `${root}/${relative}`);

  const shell = (
    operation: WorkspaceOperation,
    target: string,
    command: string,
    options?: { readonly cwd?: string; readonly stdin?: string },
  ): Effect.Effect<ExecResult, WorkspaceError> =>
    sandbox
      .exec(command, options)
      .pipe(
        Effect.mapError(
          (cause) => new WorkspaceError({ operation, target, reason: cause.reason, cause }),
        ),
      );

  /**
   * `env NAME=value …` rather than an option, because `SandboxExecOptions` has none.
   *
   * The prefix is added only when the caller asked for environment. `env` runs a binary, so adding
   * it unconditionally would break the shell builtins a plain command line can still reach.
   */
  const commandLine = (
    argv: ReadonlyArray<string>,
    env?: Record<string, string> | undefined,
  ): string => {
    const command = argv.map(quote).join(" ");
    const entries = Object.entries(env ?? {});
    return entries.length === 0
      ? command
      : `env ${entries.map(([name, value]) => `${name}=${quote(value)}`).join(" ")} ${command}`;
  };

  const exec = (
    argv: ReadonlyArray<string>,
    execOptions?: ExecOptions,
  ): Effect.Effect<ExecResult, WorkspaceError> => {
    if (argv.length === 0) return refuse("exec", "", "a command needs at least one word");

    return inside("exec", execOptions?.cwd ?? ".").pipe(
      Effect.flatMap((relative) =>
        shell("exec", argv.join(" "), commandLine(argv, execOptions?.env), { cwd: at(relative) }),
      ),
      // Rebuilt around the caller's argv. The boundary records the command line it handed the
      // sandbox; the port promises the words the caller wrote, so a trace row names the check
      // rather than the quoting.
      Effect.map(
        (result) =>
          new ExecResult({
            argv,
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
          }),
      ),
    );
  };

  const readStat = (
    target: string,
    result: ExecResult,
  ): Effect.Effect<Option.Option<FileStat>, WorkspaceError> => {
    const [kind, size] = result.stdout.split(" ");
    if (kind === "none") return Effect.succeed(Option.none());
    if (kind !== "file" && kind !== "directory" && kind !== "other") {
      return refuse("stat", target, `the sandbox answered ${JSON.stringify(result.stdout)}`);
    }
    const bytes = Number(size);
    return Number.isFinite(bytes)
      ? Effect.succeed(Option.some(new FileStat({ kind, size: bytes })))
      : refuse("stat", target, `the sandbox reported the size as ${JSON.stringify(size)}`);
  };

  return {
    root,
    /**
     * `None` on an isolated provider, and that is the whole point of the field.
     *
     * A bind-mount or no-sandbox provider reached through `exec` still has the tree on the host —
     * the same directory, seen from the other side of the mount — so naming it is true. An isolated
     * provider has no such directory at all, and handing back `worktreePath` there would be a
     * plausible string that resolves to a staging copy nobody is running against.
     */
    hostPath:
      sandbox.capabilities.kind === "isolated" ? Option.none() : Option.some(sandbox.worktreePath),
    exec,
    // Through the same sandbox as everything else. Sandcastle put a real worktree in there, so git
    // runs beside the files it is asked about; running it on the host instead would report on a
    // tree the agent never touched.
    git: (args: ReadonlyArray<string>) => exec(["git", ...args]),
    read: (target: string) =>
      inside("read", target).pipe(
        Effect.flatMap((relative) =>
          shell("read", target, `cat -- ${quote(at(relative))}`).pipe(
            Effect.flatMap((result) =>
              result.succeeded
                ? Effect.succeed(result.stdout)
                : refuse("read", target, said(result, "no such file")),
            ),
          ),
        ),
      ),
    write: (target: string, content: string) =>
      inside("write", target).pipe(
        Effect.flatMap((relative) => {
          const path = at(relative);
          // The content goes down stdin, not into the command line: it is the only way past the
          // 128 KB per-argument limit on Linux, and it keeps a file full of quotes from having to
          // survive a shell.
          return shell(
            "write",
            target,
            `mkdir -p ${quote(parentOf(path))} && cat > ${quote(path)}`,
            { stdin: content },
          ).pipe(
            Effect.flatMap((result) =>
              result.succeeded
                ? Effect.void
                : refuse("write", target, said(result, `the write exited ${result.exitCode}`)),
            ),
          );
        }),
      ),
    stat: (target: string) =>
      inside("stat", target).pipe(
        Effect.flatMap((relative) =>
          shell("stat", target, statScript(at(relative))).pipe(
            Effect.flatMap((result) =>
              result.succeeded
                ? readStat(target, result)
                : refuse("stat", target, said(result, `the stat exited ${result.exitCode}`)),
            ),
          ),
        ),
      ),
    unlink: (target: string) =>
      inside("unlink", target).pipe(
        Effect.flatMap((relative) =>
          shell("unlink", target, unlinkScript(at(relative))).pipe(
            Effect.flatMap((result) =>
              result.succeeded
                ? Effect.void
                : refuse(
                    "unlink",
                    target,
                    result.exitCode === nothingThere
                      ? "no such file"
                      : said(result, `the unlink exited ${result.exitCode}`),
                  ),
            ),
          ),
        ),
      ),
  } satisfies Workspace["Service"];
};

/**
 * The workspace as the sandbox sees it — every file and every command through `sandbox.exec`.
 *
 * This is the adapter an isolated provider needs. There is no host filesystem to open, so reading a
 * file is `cat`, writing one is `cat >` with the content on stdin, and `stat` is a portable shell
 * sentence. A check written against the port does not know the difference: it calls `read` and
 * `exec` exactly as it does over a bind mount, and grades the tree the agent actually wrote in.
 *
 * The price is one process per operation, which is why the bind-mount adapter stays the default
 * wherever the tree is on the host.
 *
 * The layer's error channel is `SandboxError` because the root is discovered by running a command,
 * and a sandbox that cannot run one is not a workspace at all.
 */
export const layer = (sandbox: AcquiredSandbox): Layer.Layer<Workspace, SandboxError> =>
  Layer.effect(Workspace, rootOf(sandbox).pipe(Effect.map((root) => service(sandbox, root))));
