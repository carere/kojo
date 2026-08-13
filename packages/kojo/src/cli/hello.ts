import { Effect, Schema } from "effect";
import { code } from "../contexts/workflow/services/phase/code.ts";
import { workflow } from "../contexts/workflow/services/workflow.ts";

/**
 * A deliberately failing greeting, so `kojo run hello --fail` exercises the path that matters:
 * a phase that fails must still leave a complete record, and the phase table must still print.
 */
export class GreetingRefused extends Schema.TaggedError<GreetingRefused>()("GreetingRefused", {
  who: Schema.String,
}) {}

/**
 * The smallest workflow that is still a workflow: two code phases, a typed error channel, and a
 * trace. It exists to prove the engine, the phase, and the tracer agree — and it is what
 * `kojo run demo-hello` runs.
 *
 * **`demo-` is part of the name, not decoration.** See `cli/workflows.ts`: a demo Kojo ships must
 * not be able to collide with a workflow a factory stamps, and a prefix is what makes the collision
 * unrepresentable rather than merely resolved.
 */
export const hello = workflow(
  {
    name: "demo-hello",
    payload: { who: Schema.String, fail: Schema.Boolean },
    success: Schema.String,
    error: GreetingRefused,
    idempotencyKey: (payload) => `demo-hello/${payload.who}/${payload.fail}`,
  },
  (payload) =>
    Effect.gen(function* () {
      const greeting = yield* code(
        {
          name: "compose",
          description: "Build the greeting that the run exists to deliver",
          success: Schema.String,
          error: Schema.Never,
        },
        Effect.succeed(`Hello, ${payload.who}!`),
      );

      return yield* code(
        {
          name: "deliver",
          description: "Deliver the greeting, or refuse to when asked to fail",
          success: Schema.String,
          error: GreetingRefused,
        },
        payload.fail
          ? Effect.fail(new GreetingRefused({ who: payload.who }))
          : Effect.succeed(greeting),
      );
    }),
);
