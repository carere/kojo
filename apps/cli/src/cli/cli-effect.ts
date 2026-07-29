import { Effect } from "effect";

export type EffectOutcome<A, E> =
  | { readonly succeeded: true; readonly value: A }
  | { readonly succeeded: false; readonly error: E };

export const runEffect = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.match({
        onFailure: (error): EffectOutcome<A, E> => ({ succeeded: false, error }),
        onSuccess: (value): EffectOutcome<A, E> => ({ succeeded: true, value }),
      }),
    ),
  );
