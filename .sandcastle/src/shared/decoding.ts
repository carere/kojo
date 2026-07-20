import { Effect, Schema } from "effect";
import { DecodeError } from "../types/errors";
import { failureMessage } from "./external-failure";

export const decodeUnknown = <S extends Schema.Constraint>(
  schema: S,
  source: string,
  value: unknown,
) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(
      (cause) =>
        new DecodeError({
          cause,
          message: failureMessage(cause),
          source,
        }),
    ),
  );

export const decodeJson = <S extends Schema.Constraint>(schema: S, source: string, value: string) =>
  decodeUnknown(Schema.fromJsonString(schema), source, value);
