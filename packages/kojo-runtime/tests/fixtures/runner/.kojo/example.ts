import { appendFileSync } from "node:fs";
import { Effect, Schema } from "effect";
import { code } from "../../../../src/contexts/workflow/services/phase/code.ts";
import { workflow } from "../../../../src/contexts/workflow/services/workflow.ts";

const state = globalThis as typeof globalThis & { __kojoRunnerImportCount?: number };
state.__kojoRunnerImportCount = (state.__kojoRunnerImportCount ?? 0) + 1;

export const example = workflow(
  {
    name: "example",
    payload: Schema.Null,
    success: Schema.Null,
    error: Schema.Never,
    idempotencyKey: () => "null-payload",
  },
  () =>
    code(
      {
        name: "compile",
        description: "Count the controlled code Phase effect",
        success: Schema.Null,
        error: Schema.Never,
      },
      Effect.sync(() => {
        const counter = process.env.KOJO_EFFECT_COUNTER;
        if (counter === undefined) throw new Error("the controlled effect counter is missing");
        appendFileSync(counter, "effect\n");
        return null;
      }),
    ),
);
