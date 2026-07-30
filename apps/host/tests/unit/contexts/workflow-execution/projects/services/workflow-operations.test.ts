import { expect, it } from "@effect/vitest";
import {
  Workflow,
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
