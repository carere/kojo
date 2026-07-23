import { expect, test } from "bun:test";
import { Effect, Layer } from "effect";
import { SandboxProvider, WorkflowTest } from "../packages/workflow/src/index.ts";
import { Hello } from "./hello.ts";

test("says hello inside a Sandbox", async () => {
  const commands: Array<string> = [];
  const fixture = WorkflowTest.make(Hello, {
    layer: Layer.succeed(SandboxProvider, {
      configuration: {
        adapterVersion: "controlled",
        configurationFingerprint: "hello-sandbox",
        name: "controlled-sandbox",
        publicFields: { image: "sandcastle:kojo" },
      },
      create: ({ branch }) =>
        Effect.succeed({
          branch,
          close: () => Promise.resolve({}),
          exec: (command) => {
            commands.push(command);
            return Promise.resolve({ exitCode: 0, stderr: "", stdout: "Hello from Kojo\n" });
          },
          run: () => Promise.reject(new Error("The Hello workflow does not run an Agent")),
        }),
    }),
  });

  const result = await fixture.run({});

  expect(result.state).toBe("Completed");
  expect(result.outcome).toEqual({
    _tag: "Success",
    value: { exitCode: 0, stderr: "", stdout: "Hello from Kojo\n" },
  });
  expect(commands).toEqual(["printf 'Hello from Kojo\\n'"]);
  expect(result.evidence.map(({ type }) => type)).toContain("Command.OutputArtifactsRecorded");
});
