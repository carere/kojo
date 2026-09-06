import { Schema } from "effect";

/** Which part of initialisation refused. Named, so a message can say where it stopped. */
export const ScaffoldOperation = Schema.Literals(["read", "write", "mkdir"]);
export type ScaffoldOperation = typeof ScaffoldOperation.Type;

/** Stamping or checking a Factory did not finish. */
export class ScaffoldError extends Schema.TaggedError<ScaffoldError>()("ScaffoldError", {
  operation: ScaffoldOperation,
  /** The path the caller asked for. */
  target: Schema.String,
  reason: Schema.String,
  cause: Schema.Defect(),
}) {}
