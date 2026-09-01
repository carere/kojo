import { Acceptance, Judgement } from "@carere/kojo-runtime/contexts/workflow/models/Acceptance";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { layer as triggerLayer } from "../../../../src/contexts/trigger/adapters/InMemoryTrigger.ts";
import { workflow } from "../../../../src/contexts/workflow/services/workflow.ts";

describe("runtime authoring compatibility", () => {
  it("keeps the accepted judgement behavior", () => {
    const acceptance = new Acceptance({
      mechanical: new Judgement({ by: "suite", accepted: true, reason: "green" }),
      human: new Judgement({ by: "reviewer", accepted: false, reason: "needs work" }),
    });

    expect(acceptance.accepted).toBe(false);
    expect(acceptance.refusal).toBe("reviewer: needs work");
  });

  it("wraps non-object JSON only at the Effect engine boundary", () => {
    const scalar = workflow(
      {
        name: "scalar",
        payload: Schema.NullOr(Schema.Array(Schema.Finite)),
        success: Schema.Null,
        error: Schema.Never,
        idempotencyKey: (payload) => JSON.stringify(payload),
      },
      () => Effect.succeed(null),
    );
    expect(scalar.authoredIdempotencyKey(null)).toBe("null");
    expect(scalar.authoredIdempotencyKey([1, 2])).toBe("[1,2]");
    expect(scalar.encodeEnginePayload(null)).toEqual({ value: null });
    expect(scalar.encodeEnginePayload([1, 2])).toEqual({ value: [1, 2] });
  });

  it("declares at most one logical Trigger on the Workflow bundle", () => {
    const triggered = workflow(
      {
        name: "triggered",
        payload: { key: Schema.String },
        success: Schema.Void,
        error: Schema.Never,
        idempotencyKey: (payload) => payload.key,
        trigger: triggerLayer([]),
      },
      () => Effect.void,
    );
    expect(triggered.trigger).toBeDefined();
  });
});
