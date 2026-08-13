import { Duration, Effect, Schema } from "effect";
import { GateExpired } from "../contexts/gate/models/GateExpired.ts";
import { GateRejected } from "../contexts/gate/models/GateRejected.ts";
import { GateUnreachable } from "../contexts/gate/models/GateUnreachable.ts";
import * as OnExpiry from "../contexts/gate/models/OnExpiry.ts";
import { code } from "../contexts/workflow/services/phase/code.ts";
import { gate } from "../contexts/workflow/services/phase/gate.ts";
import { workflow } from "../contexts/workflow/services/workflow.ts";

/** Who this workflow asks. One name, because the roster is a later ticket's problem. */
const actor = "engineer";

/**
 * The smallest workflow that still waits on a human: draft, ask, land.
 *
 * `demo-hello` proves the engine, the phase and the trace agree. This one proves the thing the whole
 * design is for — that the process which started the run can **exit** while a person thinks, and
 * that answering days later continues the run where it stopped rather than from the top. It is what
 * `kojo run demo-review` runs, and what the two-process acceptance test drives.
 *
 * **It is `demo-review`, and it used to be `review`.** Under the old name it shared both a name and
 * an idempotency key with the `review` a factory stamps — and, having no agent phase and no sandbox,
 * it would answer `kojo run review "the change"` in a stamped repository by succeeding in
 * milliseconds while invoking nothing. See `cli/workflows.ts` for why the answer is a rename rather
 * than a rule about which one wins.
 *
 * The deadline is two days and the expiry branch is `fail`, so a question nobody answers ends the
 * run loudly instead of leaking a suspended row forever.
 */
export const review = workflow(
  {
    name: "demo-review",
    payload: { subject: Schema.String },
    success: Schema.String,
    error: Schema.Union([GateExpired, GateRejected, GateUnreachable]),
    idempotencyKey: (payload) => `demo-review/${payload.subject}`,
  },
  (payload) =>
    Effect.gen(function* () {
      const drafted = yield* code(
        {
          name: "draft",
          description: "Prepare the change the human is asked about",
          success: Schema.String,
          error: Schema.Never,
        },
        Effect.succeed(`draft of ${payload.subject}`),
      );

      const verdict = yield* gate({
        name: "approve",
        description: `Land ${payload.subject}?`,
        actor,
        choices: ["approve", "reject"],
        deadline: Duration.days(2),
        onExpiry: OnExpiry.fail(),
      });

      if (verdict.choice !== "approve") {
        return yield* new GateRejected({ gate: "approve", actor, reason: verdict.reason });
      }

      return yield* code(
        {
          name: "land",
          description: "Land what the human approved",
          success: Schema.String,
          error: Schema.Never,
        },
        Effect.succeed(`${drafted} landed by ${verdict.answerer}`),
      );
    }),
);
