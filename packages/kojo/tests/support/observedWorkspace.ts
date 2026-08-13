import { Context, Effect, Layer } from "effect";
import type { ScriptedCommand } from "../../src/contexts/sandbox/adapters/InMemoryWorkspace.ts";
import * as InMemoryWorkspace from "../../src/contexts/sandbox/adapters/InMemoryWorkspace.ts";
import type { ExecOptions } from "../../src/contexts/sandbox/ports/Workspace.ts";
import { Workspace } from "../../src/contexts/sandbox/ports/Workspace.ts";

/**
 * Every command line the workspace was asked to run, in order.
 *
 * Separate from `Workspace` for the reason `RecordedTrace` is separate from `Tracer`: the thing
 * under test must not be able to read back what it did.
 */
export class ObservedCommands extends Context.Service<
  ObservedCommands,
  { readonly lines: Effect.Effect<ReadonlyArray<string>> }
>()("kojo/test/ObservedCommands") {}

/**
 * `InMemoryWorkspace` with a note taken of every command.
 *
 * Two claims in this ticket are about commands that must **not** run — a merge that was refused
 * touches no git at all, and a conflicted one aborts before it reports. Neither can be asserted by
 * looking at a result: "it failed before it merged" and "it merged and then failed" produce the same
 * error. So the commands themselves are the evidence.
 */
export const layer = (options?: {
  readonly files?: Record<string, string>;
  readonly commands?: Record<string, ScriptedCommand>;
}): Layer.Layer<Workspace | ObservedCommands> =>
  Layer.effectContext(
    Effect.gen(function* () {
      const lines: Array<string> = [];
      const inner = yield* Effect.provide(
        Effect.andThen(Workspace, (workspace) => Effect.succeed(workspace)),
        InMemoryWorkspace.layer(options?.files ?? {}, { commands: options?.commands ?? {} }),
      );

      const exec = (argv: ReadonlyArray<string>, execOptions?: ExecOptions) => {
        lines.push(argv.join(" "));
        return inner.exec(argv, execOptions);
      };

      return Context.make(Workspace, {
        ...inner,
        exec,
        git: (args: ReadonlyArray<string>) => exec(["git", ...args]),
      }).pipe(Context.add(ObservedCommands, { lines: Effect.sync(() => [...lines]) }));
    }),
  );

/** What was run, read from a test. */
export const observed = Effect.flatMap(ObservedCommands, (commands) => commands.lines);
