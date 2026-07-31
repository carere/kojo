import type { ProjectSnapshot } from "@kojo/control";
import type {
  AcquiredWorkflowSandbox,
  AgentProvider,
  AgentProviderResult,
  AgentSession,
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

export interface ProviderAgentExecution extends AgentProviderResult {
  readonly durationMs: number;
  readonly sessionRecreated: boolean;
  /** True only when this invocation explicitly continued a prior Agent Session. */
  readonly sessionContinued: boolean;
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
  readonly runAgent: (input: {
    readonly agent: AgentProvider;
    readonly definition: WorkflowSandboxDefinition;
    readonly idempotencyKey: string;
    readonly project: ProjectSnapshot;
    readonly prompt: string;
    readonly runId: string;
    readonly sandbox: AcquiredWorkflowSandbox;
    readonly session?: AgentSession;
  }) => Effect.Effect<ProviderAgentExecution, SandboxProviderFailure>;
  /** Interrupts provider work that is still owned by a Run. */
  readonly interruptRun: (project: ProjectSnapshot, runId: string) => Effect.Effect<void>;
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
  runAgent: () =>
    Effect.fail({
      _tag: "sandbox-provider-failure" as const,
      message: "Workflow Agent execution is not configured for this Project Runtime.",
    }),
  interruptRun: () => Effect.void,
  releaseProject: () => Effect.void,
} satisfies ProviderRuntimeShape;
