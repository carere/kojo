import { describe, expect, test } from "@effect/vitest";
import { Clock, Context, Effect, Layer, Schema } from "effect";
import { Activity, DurableClock } from "effect/unstable/workflow";
import { Workflow, WorkflowTest } from "../src/index";

const Adapter = Context.Service<{
  readonly invoke: <A>(
    layer: WorkflowTest.ExternalLayer,
    operation: string,
    input: unknown,
    value: A,
  ) => Effect.Effect<A>;
}>("AcceptanceAdapter");

const adapterLayer = Layer.succeed(Adapter, {
  invoke: (layer, operation, input, value) =>
    WorkflowTest.call({ input, layer, operation }, Effect.succeed(value)),
});

const AcceptanceInput = Schema.Struct({ workstream: Schema.String });
const AcceptanceSuccess = Schema.Struct({ id: Schema.String, loadedAt: Schema.Number });
const AcceptanceFailure = Schema.TaggedStruct("InvalidWorkstream", { reason: Schema.String });

const acceptance = Workflow.make("Acceptance", {
  version: "1",
  entryPoint: "workflows/acceptance.ts",
  input: AcceptanceInput,
  success: AcceptanceSuccess,
  failure: AcceptanceFailure,
  run: ({ workstream }) =>
    Effect.gen(function* () {
      const adapter = yield* Adapter;
      for (const layer of ["Agent", "Sandbox", "Command", "Git", "GitHub"] as const) {
        yield* adapter.invoke(layer, "inspect", { workstream }, `${layer}:ok`);
      }
      return {
        id: yield* WorkflowTest.nextId,
        loadedAt: yield* Clock.currentTimeMillis,
      };
    }),
});

describe("WorkflowTest", () => {
  test("runs a Developer Workflow through its public entry point with controlled layers", async () => {
    const fixture = WorkflowTest.make(acceptance, {
      clock: "2026-07-20T12:00:00.000Z",
      ids: ["acceptance-id"],
      layer: adapterLayer,
    });

    const result = await fixture.run({ workstream: "#26" });

    expect(result.state).toBe("Completed");
    expect(result.outcome).toEqual({
      _tag: "Success",
      value: { id: "acceptance-id", loadedAt: Date.parse("2026-07-20T12:00:00.000Z") },
    });
    expect(result.evidence.map(({ type }) => type)).toEqual([
      "WorkflowRun.Started",
      "ExternalCall.Started",
      "ExternalCall.Completed",
      "ExternalCall.Started",
      "ExternalCall.Completed",
      "ExternalCall.Started",
      "ExternalCall.Completed",
      "ExternalCall.Started",
      "ExternalCall.Completed",
      "ExternalCall.Started",
      "ExternalCall.Completed",
      "WorkflowRun.Completed",
    ]);
    expect(result.trace.map(({ subject, type }) => ({ subject, type }))).toEqual([
      { subject: "Acceptance", type: "WorkflowRun" },
      { subject: "Agent.inspect", type: "ExternalCall" },
      { subject: "Sandbox.inspect", type: "ExternalCall" },
      { subject: "Command.inspect", type: "ExternalCall" },
      { subject: "Git.inspect", type: "ExternalCall" },
      { subject: "GitHub.inspect", type: "ExternalCall" },
    ]);
    expect(() =>
      WorkflowTest.assertCalls(result, {
        forbidden: [{ layer: "GitHub", operation: "close" }],
        required: [
          { layer: "Agent", operation: "inspect" },
          { input: { workstream: "#26" }, layer: "GitHub", operation: "inspect" },
        ],
      }),
    ).not.toThrow();
  });

  test("returns a typed failure and proves forbidden calls", async () => {
    const failing = Workflow.make("FailingAcceptance", {
      version: "1",
      entryPoint: "workflows/failing-acceptance.ts",
      input: Schema.String,
      success: Schema.Never,
      failure: AcceptanceFailure,
      run: (reason) => Effect.fail({ _tag: "InvalidWorkstream" as const, reason }),
    });

    const result = await WorkflowTest.make(failing).run("broken graph");

    expect(result).toMatchObject({
      outcome: {
        _tag: "Failure",
        failure: { _tag: "InvalidWorkstream", reason: "broken graph" },
      },
      state: "Failed",
    });
    expect(() =>
      WorkflowTest.assertCalls(result, {
        forbidden: [{ layer: "GitHub", operation: "close" }],
        required: [],
      }),
    ).not.toThrow();
  });

  test("normalizes generated plumbing without removing behavioral details", () => {
    expect(
      WorkflowTest.normalize(
        {
          eventId: "event-991",
          fiber: { id: 42 },
          idempotencyKey: "generated-key",
          recordedAt: "2026-07-20T12:00:00.000Z",
          sql: "insert into evidence values (?, ?)",
          subject: "GitHub.close",
        },
        { ignore: ["fiber", "idempotencyKey", "sql"] },
      ),
    ).toEqual({
      eventId: "<id>",
      recordedAt: "<timestamp>",
      subject: "GitHub.close",
    });
  });

  test("advances controlled durable workflow time without waiting", async () => {
    const durableClock = Workflow.make("DurableClockAcceptance", {
      version: "1",
      entryPoint: "workflows/durable-clock-acceptance.ts",
      input: Schema.Void,
      success: Schema.Number,
      failure: Schema.Never,
      run: () =>
        Effect.gen(function* () {
          yield* DurableClock.sleep({ duration: "2 minutes", name: "backoff" });
          return yield* Clock.currentTimeMillis;
        }),
    });

    const result = await WorkflowTest.make(durableClock, {
      clock: "2026-07-20T12:00:00.000Z",
    }).run(undefined);

    expect(result).toMatchObject({
      outcome: {
        _tag: "Success",
        value: Date.parse("2026-07-20T12:02:00.000Z"),
      },
      state: "Completed",
    });
    expect(result.evidence.map(({ type }) => type)).toContain("DurableClock.Completed");
  });

  test("interrupts after a durable boundary and replays it on restart", async () => {
    let executions = 0;
    const replayable = Workflow.make("Replayable", {
      version: "1",
      entryPoint: "workflows/replayable.ts",
      input: Schema.String,
      success: Schema.String,
      failure: Schema.Never,
      run: (message) =>
        Activity.make({
          execute: Effect.sync(() => {
            executions += 1;
            return message;
          }),
          name: "commit",
          success: Schema.String,
        }),
    });
    const fixture = WorkflowTest.make(replayable);

    const interrupted = await fixture.run("exact commit", {
      interruptAfter: { subject: "commit", type: "Activity.Completed" },
    });
    const restarted = await fixture.restart();

    expect(interrupted.state).toBe("Interrupted");
    expect(restarted).toMatchObject({
      attempt: 2,
      outcome: { _tag: "Success", value: "exact commit" },
      state: "Completed",
    });
    expect(executions).toBe(1);
    expect(restarted.evidence.map(({ type }) => type)).toContain("Activity.Replayed");
  });

  test("injects an uncertain external outcome in memory without repeating the call", async () => {
    let pushes = 0;
    const uncertain = Workflow.make("Uncertain", {
      version: "1",
      entryPoint: "workflows/uncertain.ts",
      input: Schema.String,
      success: Schema.String,
      failure: Schema.Never,
      run: (commit) =>
        WorkflowTest.call(
          { input: { commit }, layer: "Git", operation: "push" },
          Effect.sync(() => {
            pushes += 1;
            return commit;
          }),
        ),
    });
    const fixture = WorkflowTest.make(uncertain);

    const interrupted = await fixture.run("abc123", {
      uncertain: [{ layer: "Git", operation: "push" }],
    });
    const restarted = await fixture.restart();

    expect(interrupted.state).toBe("Interrupted");
    expect(restarted.state).toBe("Interrupted");
    expect(pushes).toBe(1);
    expect(restarted.evidence.map(({ type }) => type)).toContain("ExternalCall.Uncertain");
  });
});
