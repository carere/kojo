import { expect, it } from "@effect/vitest";
import {
  Agent,
  defineCustomAgentProvider,
  WorkflowAgentRuntime,
  type WorkflowAgentRuntimeShape,
} from "@kojo/workflow";
import { claudeCode } from "@kojo/workflow/agents/claude-code";
import { codex } from "@kojo/workflow/agents/codex";
import { cursor } from "@kojo/workflow/agents/cursor";
import { githubCopilot } from "@kojo/workflow/agents/github-copilot";
import { opencode } from "@kojo/workflow/agents/opencode";
import { pi } from "@kojo/workflow/agents/pi";
import { Effect } from "effect";

const sandbox = {
  _tag: "workflow-sandbox" as const,
  identity: "run-1:sandbox",
  operationKey: "sandbox",
  providerKind: "unsafe-host" as const,
  providerKey: "test-provider",
  providerRevision: "1",
  sandboxKey: "test-sandbox",
  revision: "1",
};

it.effect("keeps built-in Agent Providers immutable and lets tests fake normalized results", () => {
  const codexProvider = codex({ model: "gpt-5.4", providerKey: "codex", revision: "1" });
  const providers = [
    codexProvider,
    claudeCode({ model: "claude-opus", providerKey: "claude", revision: "1" }),
    pi({ model: "pi", providerKey: "pi", revision: "1" }),
    cursor({ model: "cursor", providerKey: "cursor", revision: "1" }),
    opencode({ model: "opencode", providerKey: "opencode", revision: "1" }),
    githubCopilot({ model: "copilot", providerKey: "copilot", revision: "1" }),
  ];
  const custom = defineCustomAgentProvider({
    kind: "custom",
    providerKey: "custom",
    revision: "1",
    supportsSessionContinuation: true,
    run: () => Effect.succeed({ commits: [], text: "unused" }),
  });
  const calls: Array<string> = [];
  const runtime: WorkflowAgentRuntimeShape = {
    run: ({ agent, operationKey, prompt, sandbox: logicalSandbox, session }) =>
      Effect.sync(() => {
        calls.push(
          `${agent.providerKey}:${operationKey}:${logicalSandbox.identity}:${session?.sessionId ?? "new"}`,
        );
        return {
          artifactIds: ["artifact-1"],
          commits: [{ sha: "commit-1" }],
          sandboxIdentity: logicalSandbox.identity,
          text: prompt,
          usage: {
            cacheCreationInputTokens: 2,
            cacheReadInputTokens: 3,
            inputTokens: 1,
            outputTokens: 4,
          },
          session: {
            _tag: "agent-session" as const,
            providerKind: agent.kind,
            providerKey: agent.providerKey,
            providerRevision: agent.revision,
            sandboxIdentity: logicalSandbox.identity,
            sessionId: "session-1",
          },
        };
      }),
  };

  return Effect.gen(function* () {
    expect(providers.map(Object.isFrozen)).toEqual([true, true, true, true, true, true]);
    expect(Object.isFrozen(custom)).toBe(true);
    const first = yield* Agent.run({
      agent: codexProvider,
      operationKey: "first",
      prompt: "first prompt",
      sandbox,
    });
    const second = yield* Agent.run({
      agent: codexProvider,
      operationKey: "second",
      prompt: "continued prompt",
      sandbox,
      session: first.session,
    });

    expect(first).toMatchObject({
      artifactIds: ["artifact-1"],
      commits: [{ sha: "commit-1" }],
      text: "first prompt",
      usage: { inputTokens: 1, outputTokens: 4 },
    });
    expect(second.session?.sessionId).toBe("session-1");
    expect(calls).toEqual([
      "codex:first:run-1:sandbox:new",
      "codex:second:run-1:sandbox:session-1",
    ]);
  }).pipe(Effect.provideService(WorkflowAgentRuntime, runtime));
});
