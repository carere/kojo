import { describe, expect, test } from "bun:test";
import {
  claudeCode,
  codex,
  copilot,
  createBindMountSandboxProvider,
  createIsolatedSandboxProvider,
  cursor,
  opencode,
  pi,
  type AgentProvider as SandcastleAgentProvider,
} from "@ai-hero/sandcastle";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";
import { Context, Effect, Layer, Schema } from "effect";
import {
  Agent,
  AgentProvider,
  Sandbox,
  SandboxProvider,
  Workflow,
  WorkflowTest,
} from "../src/index";
import type { SandboxRuntimeService } from "../src/sandbox";

const ProjectSandboxRuntime = Context.Service<SandboxRuntimeService>(
  "@kojo/workflow/SandboxRuntime",
);

const unavailable = async (): Promise<never> => {
  throw new Error("Provider creation is not part of this contract test");
};

describe("Sandcastle providers", () => {
  test("passes every Sandbox Provider category through to the runtime unchanged", async () => {
    const providers = [
      noSandbox(),
      createBindMountSandboxProvider({ name: "custom-bind-mount", create: unavailable }),
      createIsolatedSandboxProvider({ name: "custom-isolated", create: unavailable }),
    ];
    const received: Array<unknown> = [];
    const runtime = Layer.succeed(ProjectSandboxRuntime, {
      create: (sandbox, { branch }) =>
        Effect.sync(() => {
          received.push(sandbox);
          return {
            branch,
            close: () => Promise.resolve({}),
            exec: () => Promise.resolve({ exitCode: 0, stderr: "", stdout: "" }),
            run: () => Promise.resolve({ commits: [], stdout: "" }),
          };
        }),
    });

    for (const [index, sandbox] of providers.entries()) {
      const provider = SandboxProvider.layer({
        configuration: {
          adapterVersion: "@ai-hero/sandcastle@0.12.0",
          configurationFingerprint: `sandbox-${index}`,
          name: sandbox.name,
          publicFields: {},
        },
        sandbox,
      }).pipe(Layer.provide(runtime));

      await Effect.runPromise(
        Sandbox.use(`sandbox-${index}`, {
          branch: `provider/category-${index}`,
          effect: Effect.void,
        }).pipe(Effect.provide(provider)),
      );
    }

    expect(received).toEqual(providers);
  });

  test("accepts every built-in Agent Provider and a custom AgentProvider", async () => {
    const custom = {
      name: "custom-agent",
      env: {},
      captureSessions: false,
      buildPrintCommand: ({ prompt }) => ({ command: `custom-agent ${prompt}` }),
      parseStreamLine: () => [],
    } satisfies SandcastleAgentProvider;
    const agents = [
      claudeCode("claude-opus-4-8"),
      codex("gpt-5.4"),
      pi("anthropic/claude-opus-4-8"),
      cursor("composer-2"),
      opencode("openai/gpt-5.4"),
      copilot("gpt-5.4"),
      custom,
    ];

    for (const agent of agents) {
      const layer = AgentProvider.layer({
        agent,
        configuration: {
          adapterVersion: "@ai-hero/sandcastle@0.12.0",
          configurationFingerprint: agent.name,
          name: agent.name,
          publicFields: {},
        },
      });
      const service = await Effect.runPromise(AgentProvider.pipe(Effect.provide(layer)));

      expect(service.agent).toBe(agent);
    }

    let receivedAgent: SandcastleAgentProvider | undefined;
    const sandbox = Layer.succeed(SandboxProvider, {
      configuration: {
        adapterVersion: "controlled",
        configurationFingerprint: "controlled-sandbox",
        name: "controlled-sandbox",
        publicFields: {},
      },
      create: ({ branch }) =>
        Effect.succeed({
          branch,
          close: () => Promise.resolve({}),
          exec: () => Promise.resolve({ exitCode: 0, stderr: "", stdout: "" }),
          run: ({ agent }) => {
            receivedAgent = agent;
            return Promise.resolve({
              commits: [],
              output: { _tag: "Success", value: "custom agent completed" },
              stdout: "custom agent completed",
            });
          },
        }),
    });
    const customAgent = AgentProvider.layer({
      agent: custom,
      configuration: {
        adapterVersion: "custom-agent@1",
        configurationFingerprint: "custom-agent-v1",
        name: custom.name,
        publicFields: {},
      },
    });
    const definition = Workflow.make("CustomAgentProvider", {
      version: "1",
      entryPoint: "workflows/custom-agent-provider.ts",
      input: Schema.Void,
      success: Schema.String,
      failure: Schema.Never,
      run: () =>
        Sandbox.use("custom-agent-sandbox", {
          branch: "provider/custom-agent",
          effect: Agent.run("custom-agent", {
            failure: Schema.Never,
            prompt: "Run the custom agent",
            success: Schema.String,
          }).pipe(Effect.provide(customAgent)),
        }),
    });

    const result = await WorkflowTest.make(definition, { layer: sandbox }).run(undefined);

    expect(result.outcome).toEqual({ _tag: "Success", value: "custom agent completed" });
    expect(receivedAgent).toBe(custom);
  });
});
