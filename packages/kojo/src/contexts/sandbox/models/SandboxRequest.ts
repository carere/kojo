import type { SandboxId } from "../../shared/models/SandboxId.ts";
import type { WorktreePolicy } from "../guards/worktreeIsUsable.ts";
import type { SandboxHooks } from "./SandboxHooks.ts";
import type { SandboxProvider } from "./SandboxProvider.ts";

/**
 * What an author writes around a region of a workflow.
 *
 * The optional fields carry no `| undefined`, unlike most of Kojo's option types, for the reason
 * `SandboxHooks` gives: this shape reaches Sandcastle structurally, and under
 * `exactOptionalPropertyTypes` a widened optional is not assignable to a plain one. The assignment
 * is what keeps the two in step.
 */
export interface SandboxConfig {
  /**
   * What this scope is called. It names the sandbox's rows in the trace and its ids, so two lanes
   * of one factory stay apart even when they share a branch prefix.
   */
  readonly name: string;
  /** The branch the worktree is checked out on. The durable state of a run. */
  readonly branch: string;
  /** Where a branch that does not exist yet forks from. Ignored when it already exists. */
  readonly baseBranch?: string;
  readonly provider: SandboxProvider;
  /** The host repo the worktree comes from. Defaults to the process's own directory. */
  readonly cwd?: string;
  readonly hooks?: SandboxHooks;
  /** Paths, relative to the host repo root, copied into the worktree before the sandbox starts. */
  readonly copyToWorktree?: ReadonlyArray<string>;
  /** Which readings of the worktree stop the run on entry. Defaults to all three. */
  readonly worktree?: WorktreePolicy;
}

/**
 * The same thing, with what Kojo stamped on it.
 *
 * `sandboxed` builds this from the author's config; a `SandboxSource` only carries it out. The two
 * added fields are the two an adapter must never invent for itself: the acquisition's identity, and
 * the correlation that has to reach the far side of a boundary Effect cannot cross.
 */
export interface SandboxRequest extends SandboxConfig {
  readonly id: SandboxId;
  /** Merged over whatever the provider already carries, at the moment the container is built. */
  readonly environment: Record<string, string>;
}
