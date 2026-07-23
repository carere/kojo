import { Effect, Layer, Schema } from "effect";
import { Command, Sandbox, Workflow } from "../packages/workflow/src/index.ts";
import { SandboxProvider } from "@kojo/workflow";

const HelloResult = Schema.Struct({
  exitCode: Schema.Int,
  stderr: Schema.String,
  stdout: Schema.String,
});

const customSandbox = Layer.succeed(SandboxProvider, {
  configuration: {
    name: "my-provider",
    adapterVersion: "1",
    configurationFingerprint: "stable-config-fingerprint",
    publicFields: {
      type: "newone",
    },
  },

  create: (options) => {
    // Open the chosen sandbox and return a SandboxHandle.
    return Effect.tryPromise({
      try: () => createMySandbox(options),
      catch: (error) => ({
        _tag: "Sandbox.ProviderFailure" as const,
        message: String(error),
      }),
    });
  },
});

export const Hello = Workflow.make("Hello", {
  entryPoint: "workflows/hello.ts",
  failure: Schema.String,
  input: Schema.Struct({}),
  run: () =>
    Sandbox.use("hello-container", {
      branch: "sandcastle/hello-container",
      effect: Command.run("say-hello", {
        command: "printf 'Hello from Kojo\\n'",
      }),
    }).pipe(Effect.mapError((failure) => JSON.stringify(failure) ?? String(failure))),
  success: HelloResult,
  version: "v1",
});
