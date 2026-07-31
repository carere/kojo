import { createHash } from "node:crypto";
import {
  createSandbox,
  type AgentProvider as SandcastleAgentProvider,
  type SandboxProvider as SandcastleProvider,
  type Sandbox as SandcastleSandbox,
} from "@ai-hero/sandcastle";
import type { ProjectSnapshot } from "@kojo/control";
import type {
  AcquiredWorkflowSandbox,
  BuiltInAgentProvider,
  BuiltInSandboxProvider,
  Command,
  SandboxProviderFailure,
  WorkflowSandboxDefinition,
} from "@kojo/workflow";
import { Effect, Layer } from "effect";
import { ProviderRuntime, type ProviderSandboxAcquisition } from "./provider-runtime";

interface LiveSandbox {
  readonly branch: string;
  readonly sandbox?: SandcastleSandbox;
}

const sessionKey = (project: ProjectSnapshot, runId: string, sandboxIdentity: string) =>
  `${project.identity}:${runId}:${sandboxIdentity}`;

const worktreeBranch = (runId: string, sandboxIdentity: string) =>
  `kojo-sandbox-${createHash("sha256")
    .update(`${runId}:${sandboxIdentity}`)
    .digest("hex")
    .slice(0, 32)}`;

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\\"'\\\"'")}'`;

const commandText = (command: Command) => {
  const environment = Object.entries(command.environment ?? {}).map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Command environment key ${key} is invalid.`);
    }
    return `${key}=${shellQuote(value)}`;
  });
  const invocation =
    command.shell === "sh"
      ? `sh -lc ${shellQuote(command.arguments.join(" "))}`
      : command.arguments.map(shellQuote).join(" ");
  const invocationText = [...environment, invocation].join(" ");
  return command.workingDirectory === undefined
    ? invocationText
    : `cd ${shellQuote(command.workingDirectory)} && ${invocationText}`;
};

const failure = (message: string): SandboxProviderFailure => ({
  _tag: "sandbox-provider-failure",
  message,
});

const builtinProvider = async (
  provider: BuiltInSandboxProvider,
  definition: WorkflowSandboxDefinition,
): Promise<SandcastleProvider> => {
  const imageName = definition.image?.source.reference;
  switch (provider.kind) {
    case "docker": {
      const { docker } = await import("@ai-hero/sandcastle/sandboxes/docker");
      return docker(imageName === undefined ? {} : { imageName });
    }
    case "podman": {
      const { podman } = await import("@ai-hero/sandcastle/sandboxes/podman");
      return podman(imageName === undefined ? {} : { imageName });
    }
    case "vercel": {
      const { vercel } = await import("@ai-hero/sandcastle/sandboxes/vercel");
      return vercel();
    }
    case "daytona": {
      const { daytona } = await import("@ai-hero/sandcastle/sandboxes/daytona");
      return daytona();
    }
    case "unsafe-host": {
      if (provider.unsafeAcknowledged !== true) {
        throw new Error("Unsafe host execution was not acknowledged.");
      }
      const { noSandbox } = await import("@ai-hero/sandcastle/sandboxes/no-sandbox");
      return noSandbox();
    }
  }
};

/**
 * Built-in Agent constructors deliberately receive no credential value. Their
 * CLI processes resolve credentials from the local environment only when this
 * invocation starts; nothing credential-bearing reaches project records.
 */
const builtinAgent = async (provider: BuiltInAgentProvider): Promise<SandcastleAgentProvider> => {
  const sandcastle = await import("@ai-hero/sandcastle");
  switch (provider.kind) {
    case "codex":
      return sandcastle.codex(provider.model);
    case "claude-code":
      return sandcastle.claudeCode(provider.model);
    case "pi":
      return sandcastle.pi(provider.model);
    case "cursor":
      return sandcastle.cursor(provider.model);
    case "opencode":
      return sandcastle.opencode(provider.model);
    case "github-copilot":
      return sandcastle.copilot(provider.model);
  }
};

/**
 * Production ProviderRuntime. Sandcastle v0.12.0 stays wholly inside this
 * adapter; only logical identities and safe command outcomes leave it.
 */
export const SandcastleProviderRuntimeLive = Layer.sync(ProviderRuntime, () => {
  const sessions = new Map<string, LiveSandbox>();

  const releaseRun = async (project: ProjectSnapshot, runId: string) => {
    const owned = [...sessions.entries()].filter(([key]) =>
      key.startsWith(`${project.identity}:${runId}:`),
    );
    for (const [key, session] of owned) {
      await session.sandbox?.close();
      sessions.delete(key);
    }
  };

  const acquire = (input: {
    readonly project: ProjectSnapshot;
    readonly runId: string;
    readonly sandbox: AcquiredWorkflowSandbox;
    readonly definition: WorkflowSandboxDefinition;
  }): Effect.Effect<ProviderSandboxAcquisition, SandboxProviderFailure> =>
    Effect.tryPromise({
      try: async () => {
        const key = sessionKey(input.project, input.runId, input.sandbox.identity);
        const existing = sessions.get(key);
        if (existing !== undefined) {
          return {
            providerKind: input.sandbox.providerKind,
            sessionRecreated: false,
            worktreeBranch: existing.branch,
          };
        }
        const branch = worktreeBranch(input.runId, input.sandbox.identity);
        if (input.definition.provider.kind === "custom") {
          await Effect.runPromise(
            input.definition.provider.acquire?.({
              image: input.definition.image,
              sandbox: input.sandbox,
            }) ?? Effect.void,
          );
          sessions.set(key, { branch });
          return {
            providerKind: "custom",
            sessionRecreated: true,
            worktreeBranch: branch,
          };
        }
        const sandbox = await createSandbox({
          branch,
          cwd: input.project.path,
          sandbox: await builtinProvider(input.definition.provider, input.definition),
        });
        sessions.set(key, { branch, sandbox });
        return {
          providerKind: input.sandbox.providerKind,
          sessionRecreated: true,
          worktreeBranch: branch,
        };
      },
      catch: (error) =>
        failure(error instanceof Error ? error.message : "Sandbox Provider failed."),
    });

  return {
    acquire,
    runCommand: (input) =>
      Effect.gen(function* () {
        const acquisition = yield* acquire(input);
        const startedAtMs = Date.now();
        if (input.definition.provider.kind === "custom") {
          const result = yield* input.definition.provider.runCommand({
            command: input.command,
            image: input.definition.image,
            sandbox: input.sandbox,
          });
          return { ...result, ...acquisition, durationMs: Math.max(0, Date.now() - startedAtMs) };
        }
        const live = sessions.get(sessionKey(input.project, input.runId, input.sandbox.identity));
        const liveSandbox = live?.sandbox;
        if (liveSandbox === undefined) {
          return yield* Effect.fail(failure("Sandbox session was not available."));
        }
        const result = yield* Effect.tryPromise({
          try: () => liveSandbox.exec(commandText(input.command)),
          catch: (error) =>
            failure(error instanceof Error ? error.message : "Command execution failed."),
        });
        return {
          ...result,
          ...acquisition,
          durationMs: Math.max(0, Date.now() - startedAtMs),
        };
      }),
    runAgent: (input) =>
      Effect.gen(function* () {
        const acquisition = yield* acquire(input);
        const startedAtMs = Date.now();
        if (input.agent.kind === "custom") {
          const result = yield* input.agent
            .run({
              idempotencyKey: input.idempotencyKey,
              prompt: input.prompt,
              sandbox: input.sandbox,
              ...(input.session === undefined ? {} : { session: input.session }),
            })
            .pipe(Effect.mapError((error) => failure(error.message)));
          return {
            ...acquisition,
            ...result,
            durationMs: Math.max(0, Date.now() - startedAtMs),
            sessionContinued: input.session !== undefined,
          };
        }
        const live = sessions.get(sessionKey(input.project, input.runId, input.sandbox.identity));
        const liveSandbox = live?.sandbox;
        if (liveSandbox === undefined) {
          return yield* Effect.fail(failure("Sandbox session was not available."));
        }
        const agent = yield* Effect.tryPromise({
          try: () => builtinAgent(input.agent as BuiltInAgentProvider),
          catch: (error) =>
            failure(
              error instanceof Error ? error.message : "Agent Provider could not be initialized.",
            ),
        });
        const result = yield* Effect.tryPromise({
          try: () =>
            liveSandbox.run({
              agent,
              prompt: input.prompt,
              ...(input.session === undefined ? {} : { resumeSession: input.session.sessionId }),
            }),
          catch: (error) =>
            failure(error instanceof Error ? error.message : "Agent execution failed."),
        });
        const latest = result.iterations.at(-1);
        return {
          ...acquisition,
          commits: result.commits,
          durationMs: Math.max(0, Date.now() - startedAtMs),
          ...(latest?.sessionId === undefined ? {} : { sessionId: latest.sessionId }),
          ...(latest?.usage === undefined ? {} : { usage: latest.usage }),
          sessionContinued: input.session !== undefined,
          text: result.stdout,
        };
      }),
    interruptRun: (project, runId) => Effect.promise(() => releaseRun(project, runId)),
    releaseProject: (project) =>
      Effect.promise(async () => {
        const runIds = new Set(
          [...sessions.keys()]
            .filter((key) => key.startsWith(`${project.identity}:`))
            .map((key) => key.split(":")[1]),
        );
        for (const runId of runIds) await releaseRun(project, runId);
      }),
  };
});
