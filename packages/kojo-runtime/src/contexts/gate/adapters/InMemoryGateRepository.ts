import { Effect, Layer, Option } from "effect";
import { AskedGate } from "../models/AskedGate.ts";
import { GateRepository } from "../ports/GateRepository.ts";

/**
 * The askings of one process, held in a map.
 *
 * Correct for a unit test and wrong for anything a human reads, because the whole value of the list
 * is that it survives the process that asked. It exists so the loop around it — record on ask,
 * update on answer, list worst first — is testable without a database.
 *
 * Keyed by the token, which is unique to one asking of one gate of one run. That is also what makes
 * writing the same asking twice idempotent rather than duplicating it, which a replayed body would
 * otherwise do if the write ever escaped its activity.
 */
export const layer: Layer.Layer<GateRepository> = Layer.effect(
  GateRepository,
  Effect.sync(() => {
    const askings = new Map<string, AskedGate>();

    return {
      asked: (request) =>
        Effect.sync(() => {
          askings.set(request.token, new AskedGate({ request }));
        }),

      // Keeps the first answer, exactly as the engine does: `DurableDeferred.succeed` refuses to
      // overwrite a recorded result, so a second answer changes nothing about the run — and a list
      // showing the second answerer would be reporting a decision the run never took.
      recorded: ({ token, verdict }) =>
        Effect.sync(() => {
          const asking = askings.get(token);
          if (asking === undefined || asking.verdict !== undefined) return false;
          askings.set(
            token,
            new AskedGate({
              request: asking.request,
              verdict,
              ...(asking.expiredAt === undefined ? {} : { expiredAt: asking.expiredAt }),
            }),
          );
          return true;
        }),

      // Keeps the first settlement, like `recorded` keeps the first verdict. A verdict already on
      // the row is kept beside it: the two are different facts — somebody answered, and the run
      // settled without an answer — and `state` is where they are ranked, not here.
      expired: ({ token, expiredAt }) =>
        Effect.sync(() => {
          const asking = askings.get(token);
          if (asking === undefined || asking.expiredAt !== undefined) return false;
          askings.set(
            token,
            new AskedGate({
              request: asking.request,
              expiredAt,
              ...(asking.verdict === undefined ? {} : { verdict: asking.verdict }),
            }),
          );
          return true;
        }),

      byToken: (token) => Effect.sync(() => Option.fromUndefinedOr(askings.get(token))),

      all: Effect.sync(() => [...askings.values()]),
    };
  }),
);
