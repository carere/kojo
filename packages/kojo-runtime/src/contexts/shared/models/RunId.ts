import { Schema } from "effect";

/**
 * Identifies one execution of a workflow.
 *
 * A run id names its branch, crosses into every sandbox as `KOJO_RUN_ID`, and is the column every
 * trace record joins on. It sits beside phase ids and sandbox ids in the same rows and the same
 * function signatures, so it is branded: passing one where another belongs is a type error rather
 * than a silent mis-join.
 */
export const RunId = Schema.String.pipe(Schema.brand("RunId"));

export type RunId = typeof RunId.Type;
