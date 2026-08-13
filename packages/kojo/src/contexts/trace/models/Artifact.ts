import { Schema } from "effect";

/**
 * The three things the trace deliberately does not store.
 *
 * Each is too large for a wide row and each is reconstructible from where it already lives, so the
 * record says a phase had one and this says how to name it:
 *
 * - **prompt** — the rendered prompt, system and user, as the agent received it.
 * - **session** — the captured transcript. Without it, "this phase corrected itself twice" is a
 *   number nobody can audit: you see the count and nothing about what was said.
 * - **diff** — the content of the change, read from git on demand. The phase record lists *which*
 *   paths changed; git supplies what changed in them, so the trace never holds a blob.
 */
export const ArtifactKind = Schema.Literals(["prompt", "session", "diff"]);
export type ArtifactKind = typeof ArtifactKind.Type;

/**
 * One artifact, as text, with what it is.
 *
 * Text rather than bytes because all three are text and a byte array would make every caller decode
 * one. The kind travels with the content because the thing that receives this has to say what it is
 * — an HTTP response needs a content type, and a panel needs to know whether it is rendering
 * markdown, a transcript, or a patch.
 */
/**
 * What each kind is, for anything that has to label it.
 *
 * A table rather than a branch, so the three are stated once and every kind is answered by
 * construction. `application/x-ndjson` is what a JSONL transcript is; `text/x-diff` is what `git`
 * produces, and both are what a browser needs to be told before it will show them as text rather
 * than offer to download them.
 */
const mediaTypes: Record<ArtifactKind, string> = {
  prompt: "text/markdown; charset=utf-8",
  session: "application/x-ndjson; charset=utf-8",
  diff: "text/x-diff; charset=utf-8",
};

export class Artifact extends Schema.Class<Artifact>("Artifact")({
  kind: ArtifactKind,
  content: Schema.String,
}) {
  /** Derived from the kind rather than stored, so no two adapters can disagree about it. */
  get mediaType(): string {
    return mediaTypes[this.kind];
  }
}
