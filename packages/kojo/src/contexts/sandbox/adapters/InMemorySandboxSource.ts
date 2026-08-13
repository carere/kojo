import { Context, Effect, Layer, type Scope } from "effect";
import type { SandboxId } from "../../shared/models/SandboxId.ts";
import { workspaceProbe } from "../guards/workspaceIsReachable.ts";
import { ExecResult } from "../models/ExecResult.ts";
import { SandboxError } from "../models/SandboxError.ts";
import type { AcquiredSandbox, SandboxHandle } from "../models/SandboxHandle.ts";
import type { SandboxRequest } from "../models/SandboxRequest.ts";
import { WorktreeState } from "../models/WorktreeState.ts";
import { SandboxSource } from "../ports/SandboxSource.ts";
import type { Workspace } from "../ports/Workspace.ts";
import type { ScriptedCommand } from "./InMemoryWorkspace.ts";
import * as InMemoryWorkspace from "./InMemoryWorkspace.ts";

/** A worktree that passes every check. What a fresh acquisition finds when nothing is wrong. */
export const healthyWorktree = (branch: string): WorktreeState =>
  new WorktreeState({
    head: branch,
    detached: false,
    modified: false,
    tracked: false,
    behind: 0,
    ahead: 0,
  });

/** One thing that happened to a sandbox, in the order it happened. */
export interface SandboxEvent {
  readonly moment: "acquired" | "released";
  readonly id: SandboxId;
  readonly name: string;
  readonly branch: string;
  /** What crossed into the container. Read at acquisition; carried on the release for symmetry. */
  readonly environment: Record<string, string>;
}

/**
 * What the fake watched happen, readable from a test.
 *
 * Separate from `SandboxSource` for the reason `RecordedTrace` is separate from `Tracer`: the thing
 * a workflow depends on must not be able to read back what it did.
 *
 * Not a duplicate of the trace either. The trace keeps one row per acquisition, written when the
 * sandbox is released; this keeps the two moments in order, which is what says *acquired, released,
 * acquired* across a suspension — the sequence, not the summary.
 */
export class ObservedSandboxes extends Context.Service<
  ObservedSandboxes,
  { readonly events: Effect.Effect<ReadonlyArray<SandboxEvent>> }
>()("kojo/sandbox/ObservedSandboxes") {}

/**
 * What a test says about the sandboxes a run will build. Everything unsaid is healthy and empty.
 *
 * Keyed by **branch** rather than by scope name, because the branch is what identifies a sandbox in
 * this design — the scope name only decorates its ids — and because a nested scope on the same
 * branch as its parent would be a mistake a test should not be able to hide.
 */
export interface Programmed {
  /**
   * The tree each acquisition finds.
   *
   * A function of how many times that branch has been acquired, so a test can say "healthy the
   * first time, somebody moved the branch the second". That is the whole re-entry story, and a
   * constant cannot tell it.
   */
  readonly worktrees?: Record<string, (acquisition: number) => WorktreeState> | undefined;
  /**
   * Whether each acquisition's workspace answers from inside the sandbox. Unsaid means yes.
   *
   * A function of the acquisition count for the same reason `worktrees` is: "unreachable the first
   * time, fine on the rebuild" is the recovery this fake exists to let a test drive, and a constant
   * cannot say it. What a `false` produces is a command that **ran and exited non-zero**, which is
   * the bind-mount shape of the fault; the shape where the command never ran at all belongs to a
   * real provider and is graded by `workspaceIsReachable` and by the integration tier.
   */
  readonly reachable?: Record<string, (acquisition: number) => boolean> | undefined;
  /** The tree a phase inside the sandbox reads. */
  readonly files?: Record<string, Record<string, string>> | undefined;
  /** What a command answers, by whole command line — through the sandbox and through the workspace. */
  readonly commands?: Record<string, Record<string, ScriptedCommand>> | undefined;
  /** Branches whose container refuses to start, the way a broken image would. */
  readonly refuses?: ReadonlyArray<string> | undefined;
}

/**
 * A sandbox that is nothing but a scope: no container, no worktree, no clock.
 *
 * This is the adapter that makes the highest-risk claim in the design testable. Whether a suspension
 * releases what a run is holding, whether replay builds it again, and whether every acquisition
 * leaves its own row are questions about **where the scope sits**, not about Docker — so they are
 * answered here, deterministically, in milliseconds, and the container is left to the integration
 * tier, where it costs what it is worth.
 */
export const layer = (
  programmed: Programmed = {},
): Layer.Layer<SandboxSource | ObservedSandboxes> =>
  Layer.effectContext(
    Effect.sync(() => {
      const events: Array<SandboxEvent> = [];
      const acquisitions = new Map<string, number>();

      const record = (moment: SandboxEvent["moment"], request: SandboxRequest) => {
        events.push({
          moment,
          id: request.id,
          name: request.name,
          branch: request.branch,
          environment: request.environment,
        });
      };

      const commandsFor = (branch: string) => programmed.commands?.[branch] ?? {};

      const acquire = (
        request: SandboxRequest,
      ): Effect.Effect<AcquiredSandbox, SandboxError, Scope.Scope> =>
        Effect.acquireRelease(
          Effect.suspend(() => {
            if (programmed.refuses?.includes(request.branch) === true) {
              return Effect.fail(
                new SandboxError({
                  operation: "create",
                  target: request.branch,
                  reason: `no image is programmed for ${request.branch}`,
                  cause: undefined,
                }),
              );
            }

            acquisitions.set(request.branch, (acquisitions.get(request.branch) ?? 0) + 1);
            record("acquired", request);

            const commands = commandsFor(request.branch);
            // Read at acquisition rather than at exec time, so the reading belongs to *this*
            // container and a later rebuild cannot change what an earlier one already answered.
            const reaches =
              programmed.reachable?.[request.branch]?.(acquisitions.get(request.branch) ?? 1) ??
              true;

            return Effect.succeed({
              provider: "in-memory",
              capabilities: request.provider.capabilities,
              branch: request.branch,
              worktreePath: `/worktrees/${request.branch}`,
              exec: (command: string) => {
                // Every sandbox answers the workspace probe, because every scope now asks it. A
                // fake that made a test script `pwd` before it could open a sandbox would be a fake
                // about Kojo's plumbing rather than about a sandbox.
                if (command === workspaceProbe && commands[command] === undefined) {
                  return Effect.succeed(
                    new ExecResult({
                      argv: [command],
                      exitCode: reaches ? 0 : 127,
                      stdout: reaches ? `/worktrees/${request.branch}` : "chdir to cwd failed",
                      stderr: "",
                    }),
                  );
                }

                const answer = commands[command];
                return answer === undefined
                  ? Effect.fail(
                      new SandboxError({
                        operation: "exec",
                        target: command,
                        reason: "no scripted result for this command",
                        cause: undefined,
                      }),
                    )
                  : Effect.succeed(
                      new ExecResult({
                        argv: [command],
                        exitCode: answer.exitCode ?? 0,
                        stdout: answer.stdout ?? "",
                        stderr: answer.stderr ?? "",
                      }),
                    );
              },
              /**
               * **A fake sandbox spawns no agent, and says so.**
               *
               * A unit test that wants an agent scripts one through `InMemoryAgentInvoker`, which
               * is the port an agent is asked through. Answering here with a plausible empty turn
               * would let a test believe an agent ran inside a container that has no processes in
               * it — the same lie as a placeholder command that exits 0.
               */
              agent: (call) =>
                Effect.fail(
                  new SandboxError({
                    operation: "agent",
                    target: call.provider.name,
                    reason:
                      "this is the in-memory sandbox: it runs no processes, so it starts no agent. " +
                      "Script the answer through InMemoryAgentInvoker instead",
                    cause: undefined,
                  }),
                ),
            } satisfies AcquiredSandbox);
          }),
          () => Effect.sync(() => record("released", request)),
        );

      return Context.make(SandboxSource, {
        acquire,
        worktree: (sandbox: AcquiredSandbox) =>
          Effect.sync(() => {
            const script = programmed.worktrees?.[sandbox.branch];
            return script === undefined
              ? healthyWorktree(sandbox.branch)
              : script(acquisitions.get(sandbox.branch) ?? 1);
          }),
        workspace: (sandbox: SandboxHandle): Layer.Layer<Workspace, SandboxError> =>
          InMemoryWorkspace.layer(programmed.files?.[sandbox.branch] ?? {}, {
            commands: commandsFor(sandbox.branch),
          }),
      }).pipe(Context.add(ObservedSandboxes, { events: Effect.sync(() => [...events]) }));
    }),
  );
