import { Effect, Layer, Option } from "effect";
import { ExecResult } from "../models/ExecResult.ts";
import { FileStat } from "../models/FileStat.ts";
import { WorkspaceError, type WorkspaceOperation } from "../models/WorkspaceError.ts";
import type { ExecOptions } from "../ports/Workspace.ts";
import { Workspace } from "../ports/Workspace.ts";

/** What a scripted command answers. Everything a test does not say is zero or empty. */
export interface ScriptedCommand {
  readonly exitCode?: number | undefined;
  readonly stdout?: string | undefined;
  readonly stderr?: string | undefined;
}

/** The root the seeded tree hangs from. Nothing is mounted here, so it names nothing on a disk. */
const root = "/workspace";

/**
 * The same escape rule the bind-mount adapter enforces, applied to a tree with no disk.
 *
 * An absolute path is refused rather than read as relative: on the host it would resolve outside
 * the root, and a check that passes in memory only because the in-memory adapter was more
 * forgiving is a check that lies.
 */
const normalize = (
  operation: WorkspaceOperation,
  target: string,
): Effect.Effect<string, WorkspaceError> => {
  const refuse = (reason: string) =>
    Effect.fail(new WorkspaceError({ operation, target, reason, cause: undefined }));

  if (target.startsWith("/")) return refuse("a workspace path is relative to the root");

  const segments: Array<string> = [];
  for (const segment of target.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment !== "..") {
      segments.push(segment);
      continue;
    }
    if (segments.length === 0) return refuse(`the path leaves the workspace root ${root}`);
    segments.pop();
  }
  return Effect.succeed(segments.join("/"));
};

/**
 * A workspace seeded from a plain object: keys are paths relative to the root, values are contents.
 *
 * This is the adapter every unit test uses. It holds no disk and spawns nothing, so a test says
 * what the tree contains in one literal, and a check that reads it is reading the same port a
 * container would answer.
 *
 * Commands are scripted by their whole command line. An unscripted command is a `WorkspaceError`
 * rather than a silent success — a test that forgot to say what `bun test` does must find out from
 * the test, not from a green check that never ran anything.
 */
export const layer = (
  files: Record<string, string>,
  options?: { readonly commands?: Record<string, ScriptedCommand> },
): Layer.Layer<Workspace> =>
  Layer.effect(
    Workspace,
    Effect.sync(() => {
      const contents = new Map(Object.entries(files));
      const scripted = new Map(Object.entries(options?.commands ?? {}));

      const exec = (
        argv: ReadonlyArray<string>,
        _options?: ExecOptions,
      ): Effect.Effect<ExecResult, WorkspaceError> => {
        const line = argv.join(" ");
        const answer = scripted.get(line);
        return answer === undefined
          ? Effect.fail(
              new WorkspaceError({
                operation: "exec",
                target: line,
                reason: "no scripted result for this command",
                cause: undefined,
              }),
            )
          : Effect.succeed(
              new ExecResult({
                argv,
                exitCode: answer.exitCode ?? 0,
                stdout: answer.stdout ?? "",
                stderr: answer.stderr ?? "",
              }),
            );
      };

      return {
        root,
        // Nothing here sits on a host, and saying so is the point of the field.
        hostPath: Option.none(),
        exec,
        git: (args: ReadonlyArray<string>) => exec(["git", ...args]),
        read: (target: string) =>
          normalize("read", target).pipe(
            Effect.flatMap((path) => {
              const content = contents.get(path);
              return content === undefined
                ? Effect.fail(
                    new WorkspaceError({
                      operation: "read",
                      target,
                      reason: "no such file",
                      cause: undefined,
                    }),
                  )
                : Effect.succeed(content);
            }),
          ),
        write: (target: string, content: string) =>
          normalize("write", target).pipe(
            Effect.flatMap((path) =>
              Effect.sync(() => {
                contents.set(path, content);
              }),
            ),
          ),
        stat: (target: string) =>
          normalize("stat", target).pipe(
            Effect.map((path) => {
              const content = contents.get(path);
              if (content !== undefined) {
                return Option.some(
                  new FileStat({ kind: "file", size: new TextEncoder().encode(content).length }),
                );
              }
              // A directory exists here exactly when something below it does, which is what a
              // seeded object can honestly say about one.
              const prefix = path === "" ? "" : `${path}/`;
              const holdsSomething = [...contents.keys()].some((key) => key.startsWith(prefix));
              return holdsSomething
                ? Option.some(new FileStat({ kind: "directory", size: 0 }))
                : Option.none<FileStat>();
            }),
          ),
        unlink: (target: string) =>
          normalize("unlink", target).pipe(
            Effect.flatMap((path) => {
              const removed = [...contents.keys()].filter(
                (key) => key === path || key.startsWith(`${path}/`),
              );
              if (removed.length === 0) {
                return Effect.fail(
                  new WorkspaceError({
                    operation: "unlink",
                    target,
                    reason: "no such file",
                    cause: undefined,
                  }),
                );
              }
              for (const key of removed) contents.delete(key);
              return Effect.void;
            }),
          ),
      } satisfies Workspace["Service"];
    }),
  );
