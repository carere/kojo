import { expect, it } from "@effect/vitest";
import {
  Command,
  defineBuiltInSandboxProvider,
  defineCommand,
  defineSandbox,
  Sandbox,
  WorkflowCommandRuntime,
  type WorkflowCommandRuntimeShape,
  WorkflowSandboxRuntime,
  type WorkflowSandboxRuntimeShape,
} from "@kojo/workflow";
import { Effect } from "effect";

const sandbox = defineSandbox({
  sandboxKey: "test-sandbox",
  revision: "1",
  provider: defineBuiltInSandboxProvider({
    kind: "unsafe-host",
    providerKey: "test-provider",
    revision: "1",
    unsafeAcknowledged: true,
  }),
});

const command = defineCommand({
  commandKey: "test-command",
  revision: "1",
  arguments: ["echo", "hello"],
});

it.effect("lets unit tests fake Sandbox execution without exposing a Provider handle", () => {
  const calls: Array<string> = [];
  const acquired = {
    _tag: "workflow-sandbox" as const,
    identity: "run-1:sandbox",
    operationKey: "sandbox",
    providerKind: "unsafe-host" as const,
    providerKey: "test-provider",
    providerRevision: "1",
    sandboxKey: "test-sandbox",
    revision: "1",
  };
  const sandboxRuntime: WorkflowSandboxRuntimeShape = {
    acquire: ({ operationKey, sandbox: definition }) =>
      Effect.sync(() => {
        calls.push(`${operationKey}:${definition.sandboxKey}`);
        return acquired;
      }),
  };
  const commandRuntime: WorkflowCommandRuntimeShape = {
    run: ({ command: definition, operationKey, sandbox: logicalSandbox }) =>
      Effect.sync(() => {
        calls.push(`${operationKey}:${logicalSandbox.identity}:${definition.commandKey}`);
        return {
          artifactIds: ["artifact-1"],
          durationMs: 2,
          exitCode: 0,
          sandboxIdentity: logicalSandbox.identity,
          stderr: "",
          stdout: "hello",
        };
      }),
  };

  return Effect.gen(function* () {
    expect(Object.isFrozen(sandbox)).toBe(true);
    expect(Object.isFrozen(sandbox.provider)).toBe(true);
    expect(Object.isFrozen(command)).toBe(true);
    expect(Object.isFrozen(command.arguments)).toBe(true);
    const logicalSandbox = yield* Sandbox.acquire({ operationKey: "sandbox", sandbox });
    const result = yield* Command.run({
      operationKey: "command",
      sandbox: logicalSandbox,
      command,
    });

    expect(logicalSandbox).toEqual(acquired);
    expect(result).toMatchObject({
      artifactIds: ["artifact-1"],
      sandboxIdentity: acquired.identity,
    });
    expect(calls).toEqual(["sandbox:test-sandbox", "command:run-1:sandbox:test-command"]);
  }).pipe(
    Effect.provideService(WorkflowSandboxRuntime, sandboxRuntime),
    Effect.provideService(WorkflowCommandRuntime, commandRuntime),
  );
});
