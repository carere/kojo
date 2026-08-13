import type { AgentProvider } from "@ai-hero/sandcastle";
import type { Effect } from "effect";
import type { SandboxId } from "../../shared/models/SandboxId.ts";
import type { ExecResult } from "./ExecResult.ts";
import type { SandboxError } from "./SandboxError.ts";
import type { SandboxCapabilities } from "./SandboxProvider.ts";

/**
 * One agent turn, asked of the sandbox rather than of the agent context.
 *
 * The sandbox owns this because *where* an agent process starts is the sandbox's business and
 * nothing else's: a bind-mount provider spawns it in the container over the same worktree, an
 * isolated one spawns it in a copy, `no-sandbox` spawns it on this machine. The agent context
 * decides *who* is asked and *what* they are asked; this decides where the process lands.
 *
 * `provider` is Sandcastle's own value, unwrapped, and deliberately so — `claudeCode()` is used as
 * it ships (see `adapters/SandcastleAgentInvoker.ts`), and a Kojo-side mirror of `AgentProvider`
 * would be a second thing to keep in step with upstream for no gain. It is a **type** import; the
 * promises on it stay behind `adapters/boundary.ts`.
 */
export interface SandboxAgentCall {
  readonly provider: AgentProvider;
  /** The whole prompt, already rendered. The sandbox composes nothing. */
  readonly prompt: string;
  /** The session to re-enter. Absent starts cold. */
  readonly resumeSession?: string | undefined;
}

/**
 * What one agent turn left behind, with every promise already spent.
 *
 * `output` is text and nothing else: the schema stays on Kojo's side of the port, so decoding — and
 * therefore `EnvelopeParseError`, and therefore the correction loop — belongs to the phase.
 */
export interface SandboxAgentRun {
  readonly output: string;
  /** The session the turn ran in, when the provider reports one. */
  readonly session: string | undefined;
  readonly tokensIn: number;
  readonly tokensOut: number;
  /** What the session occupied after the turn, when the provider reports usage at all. */
  readonly contextTokens: number | undefined;
}

/**
 * Options for one command inside a sandbox.
 *
 * A subset of Sandcastle's own, restated because it is authored surface: a code phase writes it.
 * Note what is absent — there is no `env` here, and there is none upstream either. Per-command
 * environment is not a thing a sandbox offers, which is exactly why correlation is stamped on the
 * container at creation instead.
 */
export interface SandboxExecOptions {
  /** Where to run, inside the sandbox. Defaults to the sandbox's own repo path. */
  readonly cwd?: string;
  /** Run with sudo, where the provider supports it. */
  readonly sudo?: boolean;
  /** Piped to the child and then closed. Avoids the 128 KB per-argument limit on Linux. */
  readonly stdin?: string;
}

/**
 * A live sandbox as the Sandcastle boundary hands it back, with every promise already spent.
 *
 * Nothing here returns a `Promise`, and that is enforced rather than intended —
 * `moon run kojo:check-public-types` reads the emitted declarations. Sandcastle's own `Sandbox`
 * cannot be handed out in its place, because `run()`, `exec()` and `close()` are promises on its
 * public shape.
 */
export interface AcquiredSandbox {
  /** The provider's own name — `"docker"`, `"no-sandbox"`. Recorded on the trace. */
  readonly provider: string;
  readonly capabilities: SandboxCapabilities;
  /** The branch the worktree is on. */
  readonly branch: string;
  /** Host path to the worktree. Present on every kind: even an isolated provider cuts its copy
   *  from a worktree that lives here, which is why the branch stays checkable from the host. */
  readonly worktreePath: string;
  /**
   * Run one command line inside the sandbox.
   *
   * A command line rather than an argv, because that is what Sandcastle takes and splitting it here
   * would be a guess about a shell Kojo does not own. The result records it verbatim as a
   * single-element `argv`, so a trace row still names what produced it.
   *
   * A non-zero exit code comes back in the result, exactly as it does through `Workspace`. Only a
   * command that never ran reaches the error channel.
   */
  readonly exec: (
    command: string,
    options?: SandboxExecOptions,
  ) => Effect.Effect<ExecResult, SandboxError>;
  /**
   * Run one agent turn inside this sandbox.
   *
   * One turn, never a loop: Sandcastle's iteration count and completion signal would be a second
   * control plane under Kojo's, and running two means neither can say why a run stopped (D4). So
   * the boundary pins `maxIterations` to one and the author's program owns the looping.
   *
   * Only a turn that never happened reaches the error channel. An agent that ran and answered
   * something useless answered something useless, and that is the correction loop's input rather
   * than the sandbox's fault.
   */
  readonly agent: (call: SandboxAgentCall) => Effect.Effect<SandboxAgentRun, SandboxError>;
}

/**
 * The same sandbox, plus the two things Kojo stamped on it rather than found out about it.
 *
 * `id` names this **acquisition**, so the trace row and the container's own environment agree; and
 * `environment` is what actually crossed the boundary, kept on the handle so a test — and a human
 * reading the trace — can check the join rather than trust it.
 */
export interface SandboxHandle extends AcquiredSandbox {
  readonly id: SandboxId;
  readonly environment: Record<string, string>;
}
