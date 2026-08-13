import { Schema } from "effect";
import { ArtifactKind } from "./Artifact.ts";

/**
 * Why an artifact did not come back. Three answers, because they are answered three ways.
 *
 * The Console maps them to three very different things on screen, and ticket 26 maps them to three
 * status codes, so a single boolean here would cost both surfaces the distinction:
 *
 * - **refused** — the identifier is not one this reader will use. Nothing was looked for; the
 *   caller asked wrongly.
 * - **absent** — nothing is there. The branch is gone, the prompt was never captured, the phase
 *   committed nothing. This is the ordinary case and it is not a fault.
 * - **unreadable** — something is there and it could not be read. The disk, git, or the process
 *   failed. This is the only one worth an alarm.
 */
export const ArtifactRefusal = Schema.Literals(["refused", "absent", "unreadable"]);
export type ArtifactRefusal = typeof ArtifactRefusal.Type;

/**
 * One artifact could not be served — and only that one.
 *
 * **The failure is survivable, which is why the port has its own error rather than sharing the
 * trace's.** console.md fixes the behaviour: *one missing artifact never fails the whole panel*. A
 * phase whose branch was deleted still has its record, its checks and its token counts, and a
 * reader that could not find the diff must leave all of that on screen. Making this a distinct
 * type is what stops a caller catching a missing patch with the same handler as a trace that
 * cannot be read.
 */
export class ArtifactUnavailable extends Schema.TaggedError<ArtifactUnavailable>()(
  "ArtifactUnavailable",
  {
    kind: ArtifactKind,
    /** What was asked for — the identifier, the path, or the revision, as the caller wrote it. */
    subject: Schema.String,
    refusal: ArtifactRefusal,
    reason: Schema.String,
  },
) {}
