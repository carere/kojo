import { describe, expect, test } from "@effect/vitest";
import { Clock, Context, Effect, Layer, Schema } from "effect";
import { Activity, DurableClock, Workflow as EffectWorkflow } from "effect/unstable/workflow";
import { ActivityRetry, Loop, Workflow, WorkflowTest } from "../src/index";

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
        yield* adapter.invoke(layer, "inspect", { kind: "workstream", workstream }, `${layer}:ok`);
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
          {
            input: { workstream: "#26", kind: "workstream" },
            layer: "GitHub",
            operation: "inspect",
          },
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

  test("rejects outcomes that do not satisfy their public schemas", async () => {
    const invalidSuccess = Workflow.make("InvalidSuccess", {
      version: "1",
      entryPoint: "workflows/invalid-success.ts",
      input: Schema.Void,
      success: Schema.String,
      failure: Schema.Never,
      run: () => Effect.succeed(42 as never),
    });

    const invalidFailure = Workflow.make("InvalidFailure", {
      version: "1",
      entryPoint: "workflows/invalid-failure.ts",
      input: Schema.Void,
      success: Schema.Never,
      failure: AcceptanceFailure,
      run: () => Effect.fail({ reason: "missing tag" } as never),
    });

    const successResult = await WorkflowTest.make(invalidSuccess).run(undefined);
    const failureResult = await WorkflowTest.make(invalidFailure).run(undefined);

    expect(successResult.state).toBe("Failed");
    expect(successResult.outcome._tag).toBe("Defect");
    if (successResult.outcome._tag === "Defect") {
      expect(successResult.outcome.cause).toContain("Expected string, got 42");
    }
    expect(failureResult.state).toBe("Failed");
    expect(failureResult.outcome._tag).toBe("Defect");
    if (failureResult.outcome._tag === "Defect") {
      expect(failureResult.outcome.cause).toContain("Missing key");
      expect(failureResult.outcome.cause).toContain('["_tag"]');
    }
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
    expect(result.trace).toContainEqual({
      attempt: 1,
      outcome: "Completed",
      sequence: 2,
      subject: "backoff",
      type: "DurableClock",
    });
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
    expect(restarted.trace.filter(({ type }) => type === "Activity")).toEqual([
      {
        attempt: 1,
        outcome: "Completed",
        sequence: 2,
        subject: "commit",
        type: "Activity",
      },
    ]);
  });

  test("suspends, resumes, and discards one durable Workflow Run without changing identity", async () => {
    let executions = 0;
    const controlled = Workflow.make("Lifecycle", {
      version: "1",
      entryPoint: "workflows/lifecycle.ts",
      input: Schema.String,
      success: Schema.String,
      failure: Schema.Never,
      run: (message) =>
        Activity.make({
          execute: Effect.sync(() => {
            executions += 1;
            return message;
          }),
          name: "settle-current",
          success: Schema.String,
        }),
    });
    const resumable = WorkflowTest.make(controlled);
    const suspended = await resumable.run("same run", {
      suspendAfter: { subject: "settle-current", type: "Activity.Completed" },
    });
    const resumed = await resumable.resume();

    expect(suspended).toMatchObject({
      attempt: 1,
      outcome: { _tag: "Suspended" },
      state: "Suspended",
    });
    expect(resumed).toMatchObject({
      attempt: 2,
      outcome: { _tag: "Success", value: "same run" },
      runId: suspended.runId,
      state: "Completed",
    });
    expect(executions).toBe(1);

    const discardable = WorkflowTest.make(controlled);
    const anotherSuspended = await discardable.run("preserve evidence", {
      suspendAfter: { subject: "settle-current", type: "Activity.Completed" },
    });
    const discarded = await discardable.discard();
    expect(discarded).toMatchObject({
      attempt: 1,
      outcome: { _tag: "Discarded" },
      runId: anotherSuspended.runId,
      state: "Discarded",
    });
    expect(discarded.evidence.map(({ type }) => type)).toEqual([
      "WorkflowRun.Started",
      "Activity.Started",
      "Activity.Completed",
      "WorkflowRun.Suspended",
      "WorkflowRun.Discarded",
    ]);
    await expect(discardable.resume()).rejects.toThrow(
      "Cannot resume a Workflow Run in Discarded state",
    );
  });

  test("runs a stable-tagged Recovery Handler before resuming an eligible Failed run", async () => {
    let recovered = false;
    const recoverable = Workflow.make("RecoverableFailure", {
      version: "1",
      entryPoint: "workflows/recoverable-failure.ts",
      input: Schema.Void,
      success: Schema.String,
      failure: AcceptanceFailure,
      recovery: {
        InvalidWorkstream: () =>
          Effect.gen(function* () {
            const adapter = yield* Adapter;
            yield* adapter.invoke("Git", "reconcile", {}, undefined);
            recovered = true;
          }),
      },
      run: () =>
        recovered
          ? Effect.succeed("recovered")
          : Effect.fail({
              _tag: "InvalidWorkstream" as const,
              reason: "repair external state",
            }),
    });
    const fixture = WorkflowTest.make(recoverable, { layer: adapterLayer });
    const failed = await fixture.run(undefined);
    const resumed = await fixture.resume();

    expect(failed.state).toBe("Failed");
    expect(resumed).toMatchObject({
      attempt: 2,
      outcome: { _tag: "Success", value: "recovered" },
      runId: failed.runId,
      state: "Completed",
    });
    expect(resumed.evidence.map(({ type }) => type)).toContain("Recovery.Completed");
    expect(resumed.calls).toContainEqual(
      expect.objectContaining({ layer: "Git", operation: "reconcile", status: "Completed" }),
    );
  });

  test("keeps a Recovery Handler defect truthful in evidence", async () => {
    const recoveryDefect = Workflow.make("RecoveryDefect", {
      version: "1",
      entryPoint: "workflows/recovery-defect.ts",
      input: Schema.Void,
      success: Schema.Never,
      failure: AcceptanceFailure,
      recovery: {
        InvalidWorkstream: () => Effect.die("recovery crashed"),
      },
      run: () =>
        Effect.fail({
          _tag: "InvalidWorkstream" as const,
          reason: "repair external state",
        }),
    });
    const fixture = WorkflowTest.make(recoveryDefect);
    await fixture.run(undefined);

    const resumed = await fixture.resume();

    expect(resumed).toMatchObject({ outcome: { _tag: "Defect" }, state: "Failed" });
    expect(resumed.evidence.map(({ type }) => type)).toContain("Recovery.Failed");
  });

  test("keeps a failed Activity truthful in evidence and trace", async () => {
    const activityFailure = Workflow.make("ActivityFailure", {
      version: "1",
      entryPoint: "workflows/activity-failure.ts",
      input: Schema.Void,
      success: Schema.Never,
      failure: AcceptanceFailure,
      run: () =>
        Activity.make({
          error: AcceptanceFailure,
          execute: Effect.fail({
            _tag: "InvalidWorkstream" as const,
            reason: "activity rejected the graph",
          }),
          name: "validate-graph",
          success: Schema.Never,
        }),
    });

    const result = await WorkflowTest.make(activityFailure).run(undefined);

    expect(result).toMatchObject({
      outcome: {
        _tag: "Failure",
        failure: {
          _tag: "InvalidWorkstream",
          reason: "activity rejected the graph",
        },
      },
      state: "Failed",
    });
    expect(result.evidence.map(({ type }) => type)).toEqual([
      "WorkflowRun.Started",
      "Activity.Started",
      "Activity.Failed",
      "WorkflowRun.Failed",
    ]);
    expect(result.trace).toContainEqual({
      attempt: 1,
      outcome: "Failed",
      sequence: 2,
      subject: "validate-graph",
      type: "Activity",
    });
  });

  test("keeps repeated calls and Activity Retry attempts as distinct trace spans", async () => {
    let activityAttempts = 0;
    const repeated = Workflow.make("RepeatedOperations", {
      version: "1",
      entryPoint: "workflows/repeated-operations.ts",
      input: Schema.Void,
      success: Schema.String,
      failure: Schema.String,
      run: () =>
        Effect.gen(function* () {
          yield* WorkflowTest.call(
            { input: { page: 1 }, layer: "GitHub", operation: "load" },
            Effect.void,
          );
          yield* WorkflowTest.call(
            { input: { page: 2 }, layer: "GitHub", operation: "load" },
            Effect.void,
          );
          return yield* Activity.retry(
            Activity.make({
              error: Schema.String,
              execute: Effect.suspend(() => {
                activityAttempts += 1;
                return activityAttempts === 1 ? Effect.fail("retry") : Effect.succeed("done");
              }),
              name: "verify",
              success: Schema.String,
            }),
            { times: 1 },
          );
        }),
    });
    const fixture = WorkflowTest.make(repeated);

    const result = await fixture.run(undefined);

    expect(result.state).toBe("Completed");
    expect(result.trace.filter(({ type }) => type === "ExternalCall")).toHaveLength(2);
    expect(result.trace.filter(({ type }) => type === "Activity")).toMatchObject([
      { outcome: "Failed", subject: "verify" },
      { outcome: "Completed", subject: "verify" },
    ]);
    await expect(fixture.run(undefined)).rejects.toThrow(
      "WorkflowTest has already been run; use restart or create a new fixture",
    );
    await expect(fixture.restart()).rejects.toThrow(
      "Cannot restart a Workflow Run in Completed state",
    );
  });

  test("restarts a void-input workflow and captures synchronous workflow defects", async () => {
    const fixture = WorkflowTest.make(
      Workflow.make("VoidReplay", {
        version: "1",
        entryPoint: "workflows/void-replay.ts",
        input: Schema.Void,
        success: Schema.String,
        failure: Schema.Never,
        run: () =>
          Activity.make({
            execute: Effect.succeed("replayed"),
            name: "void-step",
            success: Schema.String,
          }),
      }),
    );

    const interrupted = await fixture.run(undefined, {
      interruptAfter: { subject: "void-step", type: "Activity.Completed" },
    });
    const restarted = await fixture.restart();
    const defect = await WorkflowTest.make(
      Workflow.make("SynchronousDefect", {
        version: "1",
        entryPoint: "workflows/synchronous-defect.ts",
        input: Schema.Void,
        success: Schema.Never,
        failure: Schema.Never,
        run: () => {
          throw new Error("workflow construction failed");
        },
      }),
    ).run(undefined);

    expect(interrupted.state).toBe("Interrupted");
    expect(restarted).toMatchObject({
      attempt: 2,
      outcome: { _tag: "Success", value: "replayed" },
      state: "Completed",
    });
    expect(defect).toMatchObject({
      outcome: { _tag: "Defect" },
      state: "Failed",
    });
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
    const restart = fixture.restart();
    const resume = fixture.resume();

    expect(interrupted.state).toBe("Interrupted");
    await expect(restart).rejects.toThrow("unreconciled uncertain outcome");
    await expect(resume).rejects.toThrow("unreconciled uncertain outcome");
    expect(pushes).toBe(1);
    expect(interrupted.evidence.map(({ type }) => type)).toContain("ExternalCall.Uncertain");
  });

  test("runs named Loops with one-based iterations and nested durable Activity identities", async () => {
    const observed: Array<{ readonly iteration: number; readonly previous?: number }> = [];
    const looping = Workflow.make("DurableLoop", {
      version: "1",
      entryPoint: "workflows/durable-loop.ts",
      input: Schema.Void,
      success: Schema.Number,
      failure: Loop.MaximumLimitReached,
      run: () =>
        Loop.run("outer", {
          maxIterations: 3,
          effect: ({ iteration, previous }) =>
            Loop.run("inner", {
              maxIterations: 1,
              effect: () => {
                observed.push({ iteration, ...(previous === undefined ? {} : { previous }) });
                return Activity.make({
                  execute: Effect.succeed(iteration),
                  name: "inspect",
                  success: Schema.Number,
                });
              },
              repeatWhile: () => false,
            }),
          repeatWhile: (value) => value < 3,
        }),
    });

    const result = await WorkflowTest.make(looping).run(undefined);

    expect(result).toMatchObject({ outcome: { _tag: "Success", value: 3 }, state: "Completed" });
    expect(observed).toEqual([
      { iteration: 1 },
      { iteration: 2, previous: 1 },
      { iteration: 3, previous: 2 },
    ]);
    expect(
      result.evidence
        .filter(({ type }) => type === "Activity.Completed")
        .map(({ subject }) => subject),
    ).toEqual([
      "outer[1]/inner[1]/inspect",
      "outer[2]/inner[1]/inspect",
      "outer[3]/inner[1]/inspect",
    ]);
    expect(result.evidence.map(({ type }) => type)).toContain("Loop.Completed");
  });

  test("stops a Loop immediately on Effect failure and preserves the shared limit failure", async () => {
    let calls = 0;
    const BodyFailure = Schema.TaggedStruct("BodyFailure", { iteration: Schema.Number });
    const loopFailure = Workflow.make("LoopFailure", {
      version: "1",
      entryPoint: "workflows/loop-failure.ts",
      input: Schema.Boolean,
      success: Schema.Never,
      failure: Schema.Union([BodyFailure, Loop.MaximumLimitReached]),
      run: (failBody) =>
        Loop.run("bounded", {
          maxIterations: 2,
          effect: ({ iteration }) => {
            calls += 1;
            return failBody
              ? Effect.fail({ _tag: "BodyFailure" as const, iteration })
              : Effect.succeed(iteration);
          },
          repeatWhile: () => true,
        }),
    });

    const body = await WorkflowTest.make(loopFailure).run(true);
    expect(body.outcome).toEqual({
      _tag: "Failure",
      failure: { _tag: "BodyFailure", iteration: 1 },
    });
    expect(calls).toBe(1);

    calls = 0;
    const exhausted = await WorkflowTest.make(loopFailure).run(false);
    expect(exhausted.outcome).toEqual({
      _tag: "Failure",
      failure: {
        _tag: "Loop.MaximumLimitReached",
        maxIterations: 2,
        name: "bounded",
      },
    });
    expect(calls).toBe(2);
    expect(exhausted.evidence.map(({ type }) => type)).toContain("Loop.MaximumLimitReached");
  });

  test("retries only selected Typed Failures with durable backoff and one persistent budget", async () => {
    const RetryFailure = Schema.TaggedStruct("RetryFailure", {
      retryable: Schema.Boolean,
      ordinal: Schema.Number,
    });
    let executions = 0;
    const retried = Workflow.make("DurableRetry", {
      version: "1",
      entryPoint: "workflows/durable-retry.ts",
      input: Schema.Boolean,
      success: Schema.String,
      failure: RetryFailure,
      run: (retryable) =>
        ActivityRetry.run(
          Activity.make({
            error: RetryFailure,
            execute: Effect.suspend(() => {
              executions += 1;
              return Effect.fail({ _tag: "RetryFailure" as const, ordinal: executions, retryable });
            }),
            name: "publish",
            success: Schema.String,
          }),
          {
            backoff: ({ ordinal }) => `${ordinal} seconds`,
            maxAttempts: 3,
            while: (failure) => failure.retryable,
          },
        ),
    });
    const fixture = WorkflowTest.make(retried);

    const interrupted = await fixture.run(true, {
      interruptAfter: {
        subject: "activity-retry:publish:2:backoff",
        type: "DurableClock.Scheduled",
      },
    });
    const exhausted = await fixture.restart();

    expect(interrupted.state).toBe("Interrupted");
    expect(exhausted.outcome).toEqual({
      _tag: "Failure",
      failure: { _tag: "RetryFailure", ordinal: 3, retryable: true },
    });
    expect(executions).toBe(3);
    expect(
      exhausted.evidence.filter(({ type }) => type === "Activity.RetryScheduled"),
    ).toHaveLength(2);
    expect(
      exhausted.evidence.filter(({ type }) => type === "Activity.RetryExhausted"),
    ).toHaveLength(1);
    expect(
      exhausted.evidence.filter(
        ({ subject, type }) =>
          type === "DurableClock.Completed" && subject.startsWith("activity-retry:"),
      ),
    ).toHaveLength(2);
    const attempts = exhausted.evidence
      .filter(({ subject, type }) => type === "Activity.Started" && subject === "publish")
      .map(({ details }) => details as Record<string, unknown>);
    expect(attempts.map(({ ordinal }) => ordinal)).toEqual([1, 2, 3]);
    expect(new Set(attempts.map(({ idempotencyKey }) => idempotencyKey)).size).toBe(1);

    executions = 0;
    const notSelected = await WorkflowTest.make(retried).run(false);
    expect(notSelected.outcome).toEqual({
      _tag: "Failure",
      failure: { _tag: "RetryFailure", ordinal: 1, retryable: false },
    });
    expect(executions).toBe(1);
    expect(notSelected.evidence.map(({ type }) => type)).toContain("Activity.RetryDeclined");
  });

  test("never retries an Activity cause that also contains a Defect", async () => {
    const RetryFailure = Schema.TaggedStruct("RetryFailure", {});
    let executions = 0;
    const defecting = Workflow.make("DefectingRetry", {
      version: "1",
      entryPoint: "workflows/defecting-retry.ts",
      input: Schema.Void,
      success: Schema.Never,
      failure: RetryFailure,
      run: () =>
        ActivityRetry.run(
          Activity.make({
            error: RetryFailure,
            execute: Effect.suspend(() => {
              executions += 1;
              return Effect.fail({ _tag: "RetryFailure" as const }).pipe(
                Effect.ensuring(Effect.die("activity defect")),
              );
            }),
            name: "defecting",
          }),
          {
            backoff: "1 second",
            maxAttempts: 3,
            while: () => true,
          },
        ),
    });

    const result = await WorkflowTest.make(defecting).run(undefined);

    expect(result.outcome._tag).toBe("Defect");
    expect(executions).toBe(1);
    expect(result.evidence.map(({ type }) => type)).not.toContain("Activity.RetryScheduled");
  });

  test("runs evidenced durable Compensation in reverse order only for terminal failure", async () => {
    const compensated: Array<string> = [];
    const CompensatedFailure = Schema.TaggedStruct("CompensatedFailure", {});
    const compensatedWorkflow = Workflow.make("Compensated", {
      version: "1",
      entryPoint: "workflows/compensated.ts",
      input: Schema.Void,
      success: Schema.Never,
      failure: CompensatedFailure,
      run: () =>
        EffectWorkflow.withCompensation(
          EffectWorkflow.withCompensation(
            Effect.gen(function* () {
              yield* Activity.make({ name: "create-first", execute: Effect.void });
              return "first";
            }),
            () =>
              Activity.make({
                execute: Effect.sync(() => compensated.push("first")),
                name: "compensate-first",
              }),
          ).pipe(
            Effect.andThen(
              EffectWorkflow.withCompensation(
                Activity.make({
                  execute: Effect.succeed("second"),
                  name: "create-second",
                  success: Schema.String,
                }),
                () =>
                  Activity.make({
                    execute: Effect.sync(() => compensated.push("second")),
                    name: "compensate-second",
                  }),
              ),
            ),
          ),
          () => Effect.void,
        ).pipe(Effect.andThen(Effect.fail({ _tag: "CompensatedFailure" as const }))),
    });

    const failed = await WorkflowTest.make(compensatedWorkflow).run(undefined);

    expect(failed.state).toBe("Failed");
    expect(compensated).toEqual(["second", "first"]);
    expect(
      failed.evidence
        .filter(({ type }) => type === "Activity.Completed")
        .map(({ subject }) => subject),
    ).toEqual(["create-first", "create-second", "compensate-second", "compensate-first"]);

    compensated.length = 0;
    const fixture = WorkflowTest.make(compensatedWorkflow);
    const interrupted = await fixture.run(undefined, {
      interruptAfter: { subject: "create-first", type: "Activity.Started" },
    });
    expect(interrupted.state).toBe("Interrupted");
    expect(compensated).toEqual([]);

    compensated.length = 0;
    const compensationFixture = WorkflowTest.make(compensatedWorkflow);
    const interruptedCompensation = await compensationFixture.run(undefined, {
      interruptAfter: { subject: "compensate-second", type: "Activity.Completed" },
    });
    expect(interruptedCompensation.state).toBe("Interrupted");
    expect(compensated).toEqual(["second", "first"]);
    const restartedCompensation = await compensationFixture.restart();
    expect(restartedCompensation.state).toBe("Failed");
    expect(compensated).toEqual(["second", "first"]);

    compensated.length = 0;
    const suspendedAfterRegistration = Workflow.make("SuspendedCompensation", {
      version: "1",
      entryPoint: "workflows/suspended-compensation.ts",
      input: Schema.Void,
      success: Schema.Number,
      failure: Loop.MaximumLimitReached,
      run: () =>
        EffectWorkflow.withCompensation(
          Activity.make({ name: "create", execute: Effect.succeed("created") }),
          () => Effect.sync(() => compensated.push("suspended")),
        ).pipe(
          Effect.andThen(
            Loop.run("after-registration", {
              maxIterations: 1,
              effect: () => Effect.succeed(1),
              repeatWhile: () => false,
            }),
          ),
        ),
    });
    const suspended = await WorkflowTest.make(suspendedAfterRegistration).run(undefined, {
      suspendAfter: {
        subject: "after-registration[1]",
        type: "Loop.IterationStarted",
      },
    });
    expect(suspended.state).toBe("Suspended");
    expect(compensated).toEqual([]);

    const suspendedDuringBackoff = Workflow.make("SuspendedBackoffCompensation", {
      version: "1",
      entryPoint: "workflows/suspended-backoff-compensation.ts",
      input: Schema.Void,
      success: Schema.String,
      failure: Schema.Never,
      run: () =>
        EffectWorkflow.withCompensation(
          Activity.make({ name: "create", execute: Effect.succeed("created") }),
          () => Effect.sync(() => compensated.push("backoff")),
        ).pipe(
          Effect.andThen(
            DurableClock.sleep({ duration: "2 minutes", name: "suspend-during-backoff" }),
          ),
          Effect.as("done"),
        ),
    });
    const backoff = await WorkflowTest.make(suspendedDuringBackoff).run(undefined, {
      suspendAfter: {
        subject: "suspend-during-backoff",
        type: "DurableClock.Scheduled",
      },
    });
    expect(backoff.state).toBe("Suspended");
    expect(compensated).toEqual([]);
  });
});
