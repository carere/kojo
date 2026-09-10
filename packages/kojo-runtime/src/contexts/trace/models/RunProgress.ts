import { Schema } from "effect";
import type { WorkItemProgress } from "./WorkItemProgress.ts";

export interface RunProgress {
  readonly _tag: "KojoRunProgress";
  readonly items: ReadonlyArray<WorkItemProgress>;
}

/** Explicit presentation data in a retained Phase result. Other results are never inferred. */
export const RunProgress: Schema.Codec<RunProgress> = Schema.TaggedStruct("KojoRunProgress", {
  items: Schema.Array(
    Schema.Struct({
      key: Schema.NonEmptyString,
      title: Schema.String,
      revision: Schema.Int.check(Schema.isGreaterThan(0)),
      state: Schema.Literals([
        "waiting",
        "executing",
        "accepted",
        "integrating",
        "integrated",
        "failed",
      ]),
      waitingFor: Schema.optionalKey(Schema.Literals(["dependencies", "capacity", "human"])),
      detail: Schema.String,
      dependencies: Schema.Array(Schema.String),
      url: Schema.optionalKey(Schema.String),
    }),
  ),
});
