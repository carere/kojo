import { Effect } from "effect";
import { ExternalServiceError } from "../types/errors";

export const failureMessage = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

export const tryExternalPromise = <A>(
  service: string,
  operation: string,
  evaluate: (signal: AbortSignal) => PromiseLike<A>,
) =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) =>
      new ExternalServiceError({
        cause,
        message: failureMessage(cause),
        operation,
        service,
      }),
  });

export const mapExternalFailure = (service: string, operation: string) =>
  Effect.mapError(
    (cause: unknown) =>
      new ExternalServiceError({
        cause,
        message: failureMessage(cause),
        operation,
        service,
      }),
  );
