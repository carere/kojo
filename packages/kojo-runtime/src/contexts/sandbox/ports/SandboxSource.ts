import { Context, type Effect, type Layer, type Scope } from "effect";
import type { SandboxError } from "../models/SandboxError.ts";
import type { AcquiredSandbox, SandboxHandle } from "../models/SandboxHandle.ts";
import type { SandboxRequest } from "../models/SandboxRequest.ts";
import type { WorktreeState } from "../models/WorktreeState.ts";
import type { Workspace } from "./Workspace.ts";

/**
 * Where a sandbox comes from.
 *
 * Three members, because building the container is only one of the three things entering a sandbox
 * scope has to do, and the other two are the ones that make the design either true or false.
 *
 * `worktree` is the re-entry check. The branch is the durable state of a run, and the only thing
 * that makes that claim true is that something reads the tree instead of trusting an upstream
 * refresh with four silent skip paths. It belongs on this port rather than beside `sandboxed`
 * because *how* you read a worktree is an adapter's business — host git for a bind mount, a copy of
 * the same tree for an isolated provider — while *what is acceptable* is the guard's.
 *
 * `workspace` is here for the same reason: the filesystem a phase acts on is a bind mount on Docker
 * and a series of `exec` calls on Vercel, and the scope must not have to know which. Returning a
 * `Layer` rather than a service keeps the adapter's own dependencies — a real filesystem, a process
 * spawner — inside the adapter, so `sandboxed` requires none of them and a unit test needs no disk.
 */
export class SandboxSource extends Context.Service<
  SandboxSource,
  {
    /**
     * Build the container, and release it when the surrounding scope closes.
     *
     * Scoped, and that is the whole tear-down-and-rebuild decision. Idempotent by construction: the
     * request carries the branch and nothing else that could differ between two acquisitions, so
     * building it twice is building the same thing twice (architecture.md §4, rule 2).
     */
    readonly acquire: (
      request: SandboxRequest,
    ) => Effect.Effect<AcquiredSandbox, SandboxError, Scope.Scope>;
    /** Read the worktree as it stands. An observation; the guard decides what it means. */
    readonly worktree: (sandbox: AcquiredSandbox) => Effect.Effect<WorktreeState, SandboxError>;
    /** How a phase inside this sandbox touches files and runs commands. */
    readonly workspace: (sandbox: SandboxHandle) => Layer.Layer<Workspace, SandboxError>;
  }
>()("kojo/sandbox/SandboxSource") {}
