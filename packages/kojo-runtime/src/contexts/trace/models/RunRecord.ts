import { Schema } from "effect";
import { RunId } from "../../shared/models/RunId.ts";

export const RunOutcome = Schema.Literals(["succeeded", "failed", "suspended"]);
export type RunOutcome = typeof RunOutcome.Type;

/**
 * The record that ties a run's phases together, and the only mutable one.
 *
 * It carries what produced the run, not only what the run did: the engine version and commit are
 * stamped here because they cannot be reconstructed later.
 */
export class RunRecord extends Schema.Class<RunRecord>("RunRecord")({
  runId: RunId,
  workflow: Schema.String,
  /**
   * What this run was deduplicated by — the workflow's own key for this payload.
   *
   * It answers *which unit of work opened this run*, which is a question about the run rather than
   * about any phase, so it lives here and nowhere else. Two triggers for one ticket must produce one
   * run, and after the fact this column is what shows whether they did.
   */
  idempotencyKey: Schema.String,
  startedAt: Schema.Finite,
  engineVersion: Schema.String,
  engineCommit: Schema.String,
  /**
   * The factory's own configuration, as a digest.
   *
   * The engine version says what Kojo was; this says what the factory told it to be. A run that
   * behaved differently from yesterday's differs in one of the two, and neither can be
   * reconstructed after the fact.
   */
  configDigest: Schema.String,
  /** Which machine ran it. Two hosts of one factory answer "why is it slow here" and not there. */
  host: Schema.String,
  /**
   * The sandbox image the run resolved to, when it resolved one.
   *
   * Absent on a run that never built a container, and absent while nothing resolves a digest — no
   * provider in Kojo reports one yet, and a fabricated value here would be worse than a null.
   */
  imageDigest: Schema.optionalKey(Schema.String),
}) {}
