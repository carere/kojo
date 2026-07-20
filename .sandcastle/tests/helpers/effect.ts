import { Effect } from "effect";

export const runEffect = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

export const runFailure = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromise(effect.pipe(Effect.flip));
