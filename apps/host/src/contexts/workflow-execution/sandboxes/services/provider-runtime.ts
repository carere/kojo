import type { ProjectSnapshot } from "@kojo/control";
import type {
  AcquiredWorkflowSandbox,
  Command,
  CommandExecutionResult,
  SandboxProviderFailure,
  WorkflowSandboxDefinition,
} from "@kojo/workflow";
import { Context, Effect } from "effect";

export interface ProviderSandboxAcquisition {
  readonly providerKind: AcquiredWorkflowSandbox["providerKind"];
  readonly sessionRecreated: boolean;
  /** A safe branch label, never an absolute local path. */
  readonly worktreeBranch: string;
}

export interface ProviderCommandExecution extends CommandExecutionResult {
  readonly sessionRecreated: boolean;
  readonly worktreeBranch: string;
}

/**
 * Host-owned seam around live Sandbox Provider sessions. Its results are safe
 * values; concrete provider handles remain exclusively in its adapter.
 */
export interface ProviderRuntimeShape {
  readonly acquire: (input: {
    readonly project: ProjectSnapshot;
    readonly runId: string;
    readonly sandbox: AcquiredWorkflowSandbox;
    readonly definition: WorkflowSandboxDefinition;
  }) => Effect.Effect<ProviderSandboxAcquisition, SandboxProviderFailure>;
  readonly runCommand: (input: {
    readonly command: Command;
    readonly definition: WorkflowSandboxDefinition;
    readonly project: ProjectSnapshot;
    readonly runId: string;
    readonly sandbox: AcquiredWorkflowSandbox;
  }) => Effect.Effect<ProviderCommandExecution, SandboxProviderFailure>;
  readonly releaseProject: (project: ProjectSnapshot) => Effect.Effect<void>;
}

export class ProviderRuntime extends Context.Service<ProviderRuntime, ProviderRuntimeShape>()(
  "kojo/host/ProviderRuntime",
) {}

/** Keeps existing non-sandbox workflow fixtures independent of providers. */
export const ProviderRuntimeUnavailable = {
  acquire: () =>
    Effect.fail({
      _tag: "sandbox-provider-failure" as const,
      message: "Workflow Sandbox execution is not configured for this Project Runtime.",
    }),
  runCommand: () =>
    Effect.fail({
      _tag: "sandbox-provider-failure" as const,
      message: "Workflow Sandbox execution is not configured for this Project Runtime.",
    }),
  releaseProject: () => Effect.void,
} satisfies ProviderRuntimeShape;
