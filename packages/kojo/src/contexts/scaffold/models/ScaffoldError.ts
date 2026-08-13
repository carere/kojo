import { Schema } from "effect";

/** Which part of initialisation refused. Named, so a message can say where it stopped. */
export const ScaffoldOperation = Schema.Literals(["read", "write", "mkdir", "build"]);
export type ScaffoldOperation = typeof ScaffoldOperation.Type;

/**
 * Stamping a factory, or building its image, did not finish.
 *
 * A `Schema.TaggedError` like every other error in Kojo, even though initialisation never travels a
 * workflow error channel: one error style across the codebase is worth more than the two bytes a
 * plain class saves, and `kojo doctor` will want to report one of these next ticket.
 */
export class ScaffoldError extends Schema.TaggedError<ScaffoldError>()("ScaffoldError", {
  operation: ScaffoldOperation,
  /** The path, or the image name, the caller asked for. */
  target: Schema.String,
  reason: Schema.String,
  cause: Schema.Defect(),
}) {}
