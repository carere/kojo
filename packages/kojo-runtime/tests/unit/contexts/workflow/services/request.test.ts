import { expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import * as InMemoryTracer from "../../../../../src/contexts/trace/adapters/InMemoryTracer.ts";
import { workflow } from "../../../../../src/contexts/workflow/services/workflow.ts";
import { buildInfoLayer } from "../../../../support/InMemoryExecutionServices.ts";
import {
  inMemoryWorkflowEngine,
  selfContainedTestLayer,
  serviceFreeWorkflowEffect,
} from "../../../../support/inMemoryWorkflowEngine.ts";

it.effect("retains the authored request without publishing other payload fields", () => {
  const example = workflow(
    {
      name: "request-example",
      payload: { issue: Schema.Finite, secret: Schema.String },
      success: Schema.Void,
      error: Schema.Never,
      idempotencyKey: ({ issue }) => String(issue),
      request: ({ issue }) => ({
        title: `Implement issue ${issue}`,
        url: `https://github.com/example/project/issues/${issue}`,
        fields: { Branch: "codex/issue", Base: "main" },
      }),
    },
    () => Effect.void,
  );
  const services = Layer.mergeAll(InMemoryTracer.layer, inMemoryWorkflowEngine, buildInfoLayer);
  return Effect.gen(function* () {
    yield* serviceFreeWorkflowEffect(
      example.definition.execute({ issue: 102, secret: "private-payload" }),
    );
    const trace = yield* InMemoryTracer.RecordedTrace;
    const runs = yield* trace.runs;
    expect(runs).toHaveLength(1);
    expect(runs[0]?.request).toEqual({
      title: "Implement issue 102",
      url: "https://github.com/example/project/issues/102",
      fields: { Branch: "codex/issue", Base: "main" },
    });
    expect(JSON.stringify(runs)).not.toContain("private-payload");
  }).pipe(Effect.provide(selfContainedTestLayer(example.layer.pipe(Layer.provideMerge(services)))));
});
