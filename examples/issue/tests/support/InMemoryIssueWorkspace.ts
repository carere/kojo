import { ExecResult } from "@carere/kojo-runtime/contexts/sandbox/models/ExecResult";
import { Workspace } from "@carere/kojo-runtime/contexts/sandbox/ports/Workspace";
import { Effect, Layer, Option } from "effect";

export const layer = (commands: Readonly<Record<string, { readonly stdout: string }>>) => {
  const exec = (argv: ReadonlyArray<string>) => {
    const result = commands[argv.join(" ")];
    return result === undefined
      ? Effect.die(`Unscripted command: ${argv.join(" ")}`)
      : Effect.succeed(new ExecResult({ argv, exitCode: 0, stdout: result.stdout, stderr: "" }));
  };
  return Layer.succeed(Workspace, {
    root: "/workspace",
    hostPath: Option.none(),
    exec,
    git: (args) => exec(["git", ...args]),
    read: () => Effect.die("No file read was expected"),
    write: () => Effect.die("No file write was expected"),
    stat: () => Effect.die("No file lookup was expected"),
    unlink: () => Effect.die("No file removal was expected"),
  });
};
