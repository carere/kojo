import { Context, type Effect, type Option } from "effect";
import type { ExecResult } from "../models/ExecResult.ts";
import type { FileStat } from "../models/FileStat.ts";
import type { WorkspaceError } from "../models/WorkspaceError.ts";

/** How one command is run. Both fields are relative to, or merged over, the workspace itself. */
export interface ExecOptions {
  /** Where to run, relative to `root`. Defaults to the root. */
  readonly cwd?: string | undefined;
  /** Extra environment, merged over the one the workspace already has. */
  readonly env?: Record<string, string> | undefined;
}

/**
 * The filesystem and shell a phase acts on, wherever it physically is.
 *
 * This port is why code phases and checks are honest. Call `fs.stat` directly and a check inspects
 * the host while the agent wrote inside a container — the factory then grades a tree nobody
 * touched. Every path here is relative to `root`, so the same check text runs against a worktree on
 * the host, a bind mount in a container, and a plain object in a test.
 *
 * `git` is its own method rather than `exec(["git", …])` because the two do not always land in the
 * same place: an isolated provider runs commands in the container while the branch — the durable
 * state of a run — lives on whatever holds the repository. An adapter that must split them can.
 */
export class Workspace extends Context.Service<
  Workspace,
  {
    /** The workspace root as the running phase sees it. Every path is relative to this. */
    readonly root: string;
    /**
     * Where the same tree sits on the host, when it sits anywhere.
     *
     * `None` is not a failure to look it up: an isolated provider genuinely has no host path, and
     * a caller that needs one — to open an editor, to hand a path to a tool that is not sandboxed
     * — has to handle its absence rather than be handed a plausible string that resolves to
     * nothing.
     */
    readonly hostPath: Option.Option<string>;
    readonly exec: (
      argv: ReadonlyArray<string>,
      options?: ExecOptions,
    ) => Effect.Effect<ExecResult, WorkspaceError>;
    readonly git: (args: ReadonlyArray<string>) => Effect.Effect<ExecResult, WorkspaceError>;
    readonly read: (path: string) => Effect.Effect<string, WorkspaceError>;
    readonly write: (path: string, content: string) => Effect.Effect<void, WorkspaceError>;
    /** `None` for a path that holds nothing. Absence is an answer, so it is not an error. */
    readonly stat: (path: string) => Effect.Effect<Option.Option<FileStat>, WorkspaceError>;
    readonly unlink: (path: string) => Effect.Effect<void, WorkspaceError>;
  }
>()("kojo/sandbox/Workspace") {}
