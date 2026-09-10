import { Schema } from "effect";

/** Public request facts chosen by the author. Never put credentials or private payload here. */
export const RunRequest: Schema.Struct<{
  readonly title: Schema.String;
  readonly url: Schema.optionalKey<Schema.String>;
  readonly fields: Schema.$Record<Schema.String, Schema.String>;
}> = Schema.Struct({
  title: Schema.String,
  url: Schema.optionalKey(Schema.String),
  fields: Schema.Record(Schema.String, Schema.String),
});
export type RunRequest = typeof RunRequest.Type;
