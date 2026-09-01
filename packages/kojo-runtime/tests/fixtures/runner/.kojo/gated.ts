import { appendFileSync } from "node:fs";
import { Duration, Effect, Schema } from "effect";
import { GateExpired } from "../../../../src/contexts/gate/models/GateExpired.ts";
import { fail } from "../../../../src/contexts/gate/models/OnExpiry.ts";
import { code } from "../../../../src/contexts/workflow/services/phase/code.ts";
import { gate } from "../../../../src/contexts/workflow/services/phase/gate.ts";
import { workflow } from "../../../../src/contexts/workflow/services/workflow.ts";

export const gated = workflow(
  {
    name: "gated",
    payload: Schema.Null,
    success: Schema.Null,
    error: GateExpired,
    idempotencyKey: () => "one-gated-run",
  },
  () =>
    Effect.gen(function* () {
      yield* gate({
        name: "ship",
        description: "Ship this retained revision?",
        actor: "release-engineer",
        choices: ["approve", "reject"],
        deadline: Duration.hours(1),
        onExpiry: fail(),
      });
      return yield* code(
        {
          name: "after-verdict",
          description: "Count the effect after the Verdict is applied",
          success: Schema.Null,
          error: Schema.Never,
        },
        Effect.sync(() => {
          const counter = process.env.KOJO_EFFECT_COUNTER;
          if (counter === undefined) throw new Error("the controlled effect counter is missing");
          appendFileSync(counter, "applied\n");
          return null;
        }),
      );
    }),
);
