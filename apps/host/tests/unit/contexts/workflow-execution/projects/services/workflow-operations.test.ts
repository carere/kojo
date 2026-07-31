import { expect, it } from "@effect/vitest";
import {
  Workflow,
  WorkflowChildRuntime,
  type WorkflowChildRuntimeShape,
  type WorkflowDeferred,
  WorkflowDeferredToken,
  WorkflowOperations,
  type WorkflowOperations as WorkflowOperationsShape,
} from "@kojo/workflow";
import { Effect, Schema } from "effect";

it.effect("exposes durable waits through Kojo operations instead of Effect identities", () => {
  const calls: Array<string> = [];
  const token = Schema.decodeUnknownSync(WorkflowDeferredToken)("kojo.deferred.v1.opaque-token");
  const deferred: WorkflowDeferred<string> = { token };
  const operations: WorkflowOperationsShape = {
    sleep: ({ operationKey, duration }) =>
      Effect.sync(() => {
        calls.push(`${operationKey}:${String(duration)}`);
      }),
    deferred: ({ operationKey }) =>
      Effect.sync(() => {
        calls.push(operationKey);
        return deferred;
      }),
    awaitDeferred: <Success>(received: WorkflowDeferred<Success>) =>
      Effect.sync(() => {
        calls.push(received.token);
        return "approved" as Success;
      }),
    waitForResume: <Success extends Schema.Top>({
      operationKey,
    }: {
      readonly operationKey: string;
      readonly valueSchema: Success;
    }) =>
      Effect.sync(() => {
        calls.push(operationKey);
        return "resumed" as Success["Type"];
      }),
  };

  return Effect.gen(function* () {
    yield* Workflow.sleep({ operationKey: "wake", duration: "1 second" });
    const created = yield* Workflow.deferred({
      operationKey: "approval",
      successSchema: Schema.String,
    });
    expect(created).toEqual({ token });
    expect(yield* Workflow.await(created)).toBe("approved");
    expect(
      yield* Workflow.waitForResume({ operationKey: "resume", valueSchema: Schema.String }),
    ).toBe("resumed");
    expect(calls).toEqual(["wake:1 second", "approval", token, "resume"]);
  }).pipe(Effect.provideService(WorkflowOperations, operations));
});

it.effect("delegates durable Child Workflow invocations to the Host runtime", () => {
  const invocations: Array<{ readonly invocationKey: string; readonly workflowKey: string }> = [];
  const children: WorkflowChildRuntimeShape = {
    invoke: (invocation) =>
      Effect.sync(() => {
        invocations.push({
          invocationKey: invocation.invocationKey,
          workflowKey: invocation.workflowKey,
        });
        return `child:${String((invocation.input as { readonly message: string }).message)}`;
      }),
  };

  return Effect.gen(function* () {
    expect(
      yield* Workflow.invokeChild({
        invocationKey: "send-notification",
        workflowKey: "notification",
        input: { message: "hello" },
      }),
    ).toBe("child:hello");
    expect(
      yield* Workflow.startChild({
        invocationKey: "archive-record",
        workflowKey: "archive",
        input: { message: "done" },
      }),
    ).toBe("child:done");
    expect(invocations).toEqual([
      { invocationKey: "send-notification", workflowKey: "notification" },
      { invocationKey: "archive-record", workflowKey: "archive" },
    ]);
  }).pipe(Effect.provideService(WorkflowChildRuntime, children));
});
