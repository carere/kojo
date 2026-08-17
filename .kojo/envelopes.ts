// This file is Kojo's own.
//
// The shape of every answer an agent of Kojo's factory may give.
//
// One declaration serves four uses: the type at the call site, the decoder, the JSON Schema the
// agent is shown, and the wire contract. `renderPrompt` appends the envelope's own schema to every
// call, so there is never a hand-written example here to drift out of step with the decoder.

import { EnvelopeBase } from "@carere/kojo/contexts/workflow/models/Envelope";
import { Schema } from "effect";

/**
 * The lanes this factory routes into. **This list is the taxonomy, and it is ours, not Kojo's.**
 *
 * It is declared here rather than in the workflow because two things read it and they must not be
 * able to disagree: the decoder that grades the router's answer, and the `Match` that chooses the
 * subgraph. A fourth lane is a literal added here and a branch added there, and the compiler will
 * not let you add one without the other.
 *
 * Three, because three is what this repository actually has work of. Each one differs from the
 * others in a way a Kojo maintainer would notice on a Monday — see `workflows/factory.ts`.
 */
export const lanes = ["hotfix", "feature", "chore"] as const;

/**
 * What the router decided, and why.
 *
 * There is no check over this envelope, and the absence is deliberate: the decoder already refuses
 * any lane that is not one of the three, and a check that re-asserted what the schema proved would
 * be theatre. `because` is not graded either — it is what a human reads in the trace when they
 * disagree with the routing, and grading prose against a repository is not something a check can do.
 */
export class Routed extends EnvelopeBase.extend<Routed>("Routed")({
  _tag: Schema.tag("Routed"),
  lane: Schema.Literals(lanes),
  /** One sentence, in the router's own words, naming what in the request decided the lane. */
  because: Schema.String,
}) {}

/**
 * What the planner wrote down before anybody changed any code.
 *
 * The plan is a **file**, not a paragraph on the envelope, and that is the whole reason this lane
 * has a planner at all: the builder after it reads the file, the reviewer reads the file, and the
 * file lands on the branch with the work. `artifactsExist` goes and looks for every path claimed
 * here, because a plan a later phase is built on is a claim the rest of the run inherits.
 */
export class Planned extends EnvelopeBase.extend<Planned>("Planned")({
  _tag: Schema.tag("Planned"),
  /** One paragraph: how the change is going to be made. */
  approach: Schema.String,
  /** Every path the planner wrote. `checks.ts` goes and looks for each one. */
  artifacts: Schema.Array(Schema.String),
}) {}

/**
 * What an agent that changed the repository claims it changed.
 *
 * Shared by the three writing agents — fixer, builder, tidier — because the claim is the same claim
 * whatever lane made it, and `diffMatchesClaims` grades it the same way. Three envelopes with the
 * same two fields would be three decoders to keep in step for no gain.
 */
export class Built extends EnvelopeBase.extend<Built>("Built")({
  _tag: Schema.tag("Built"),
  /** One paragraph a reviewer reads before they read the diff. It becomes the commit message. */
  summary: Schema.String,
  /** Every path the working tree now differs on. `checks.ts` goes and looks. */
  changedFiles: Schema.Array(Schema.String),
}) {}
