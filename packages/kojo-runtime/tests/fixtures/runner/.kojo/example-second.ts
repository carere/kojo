import { appendFileSync } from "node:fs";
import { Effect, Schema } from "effect";
import { code } from "../../../../src/contexts/workflow/services/phase/code.ts";
import { workflow } from "../../../../src/contexts/workflow/services/workflow.ts";

export const example = workflow(
  {
    name: "example",
    payload: Schema.Null,
    success: Schema.Null,
    error: Schema.Never,
    idempotencyKey: () => "second-revision",
  },
  () =>
    code(
      {
        name: "compile",
        description: "Count the second exact registration",
        success: Schema.Null,
        error: Schema.Never,
      },
      Effect.sync(() => {
        const counter = process.env.KOJO_EFFECT_COUNTER;
        if (counter === undefined) throw new Error("the controlled effect counter is missing");
        appendFileSync(counter, "second\n");
        return null;
      }),
    ),
);
