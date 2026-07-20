import { describe, expect, test } from "bun:test";
import { Cron, Effect, Schema } from "effect";
import {
  COMPATIBILITY,
  defineConfig,
  RegistryValidationError,
  Schedule,
  Workflow,
} from "../src/index";

const GreetingInput = Schema.Struct({ name: Schema.String });
const Greeting = Schema.Struct({ message: Schema.String });
const GreetingFailure = Schema.TaggedStruct("GreetingFailure", {
  message: Schema.String,
});

const hello = Workflow.make("Hello", {
  version: "release-opaque+1",
  entryPoint: "workflows/hello.ts",
  input: GreetingInput,
  success: Greeting,
  failure: GreetingFailure,
  run: ({ name }) => Effect.succeed({ message: `Hello, ${name}` }),
});

describe("Workflow.make", () => {
  test("defines an ordinary typed Effect program and stable revision metadata", async () => {
    expect(hello.name).toBe("Hello");
    expect(hello.version).toBe("release-opaque+1");
    expect(hello.entryPoint).toBe("workflows/hello.ts");
    expect(Effect.isEffect(hello.run({ name: "Kojo" }))).toBe(true);
    expect(await Effect.runPromise(hello.run({ name: "Kojo" }))).toEqual({
      message: "Hello, Kojo",
    });
  });
});

describe("defineConfig", () => {
  test("accepts explicitly imported workflows and schedules synchronously", () => {
    const morning = Schedule.make("MorningHello", {
      workflow: hello,
      input: { name: "Kojo" },
      cron: Cron.parseUnsafe("0 9 * * *"),
      timezone: "Europe/Paris",
      missedTimePolicy: "catch-up-once",
    });

    const config = defineConfig({ workflows: [hello], schedules: [morning] });

    expect(config.workflows).toEqual([hello]);
    expect(config.schedules).toEqual([morning]);
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.workflows)).toBe(true);
  });

  test("reports every invalid definition and rejects the registry atomically", () => {
    const duplicate = Workflow.make("Hello", {
      version: "2",
      entryPoint: "workflows/duplicate.ts",
      input: GreetingInput,
      success: Greeting,
      failure: GreetingFailure,
      run: ({ name }) => Effect.succeed({ message: name }),
    });
    const invalidSchedule = Schedule.make("InvalidInput", {
      workflow: hello,
      input: { name: 42 } as never,
      cron: Cron.parseUnsafe("* * * * *"),
      timezone: "Europe/Paris",
      missedTimePolicy: "skip",
    });

    expect(() =>
      defineConfig({
        workflows: [hello, duplicate, { name: "forged" } as never],
        schedules: [invalidSchedule],
      }),
    ).toThrow(RegistryValidationError);

    try {
      defineConfig({
        workflows: [hello, duplicate, { name: "forged" } as never],
        schedules: [invalidSchedule],
      });
    } catch (error) {
      const diagnostics = (error as RegistryValidationError).diagnostics;
      expect(diagnostics.map(({ code }) => code)).toContain("DuplicateWorkflowName");
      expect(diagnostics.map(({ code }) => code)).toContain("InvalidWorkflowDefinition");
      expect(diagnostics.map(({ code }) => code)).toContain("InvalidScheduleInput");
      expect(diagnostics.length).toBe(3);
    }
  });

  test("keeps names case-sensitive", () => {
    const lowerCase = Workflow.make("hello", {
      version: "1",
      entryPoint: "workflows/lower-case.ts",
      input: GreetingInput,
      success: Greeting,
      failure: GreetingFailure,
      run: ({ name }) => Effect.succeed({ message: name }),
    });

    expect(() => defineConfig({ workflows: [hello, lowerCase] })).not.toThrow();
  });

  test("diagnoses invalid workflow metadata and schemas without running author code", () => {
    let invoked = false;
    const malformed = Workflow.make("" as never, {
      version: "",
      entryPoint: "../outside.cjs",
      input: {} as never,
      success: Greeting,
      failure: GreetingFailure,
      run: (() => {
        invoked = true;
      }) as never,
    });

    try {
      defineConfig({ workflows: [malformed] });
      throw new Error("Expected defineConfig to reject malformed metadata");
    } catch (error) {
      const diagnostics = (error as RegistryValidationError).diagnostics;
      expect(diagnostics.map(({ code }) => code)).toEqual([
        "InvalidWorkflowName",
        "InvalidWorkflowVersion",
        "InvalidWorkflowEntryPoint",
        "InvalidWorkflowSchema",
      ]);
      expect(invoked).toBe(false);
    }
  });
});

describe("compatibility boundary", () => {
  test("declares the exact supported authoring matrix", () => {
    expect(COMPATIBILITY).toEqual({
      kojo: "0.1.0",
      workflowAbi: "1",
      effect: "4.0.0-beta.98",
      platformBun: "4.0.0-beta.98",
      bun: "1.3.14",
      typesBun: "1.3.14",
      typescript: "7.0.2",
    });
  });
});
