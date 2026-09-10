import { Schema } from "effect";
import { RunId } from "../../shared/models/RunId.ts";
import { RunRequest } from "./RunRequest.ts";

export const RunOutcome: Schema.Literals<readonly ["succeeded", "failed", "suspended"]> =
  Schema.Literals(["succeeded", "failed", "suspended"]);
export type RunOutcome = typeof RunOutcome.Type;

const RunRecordBase: Schema.Class<
  RunRecord,
  Schema.Struct<{
    readonly runId: Schema.brand<Schema.String, "RunId">;
    readonly workflow: Schema.String;
    readonly idempotencyKey: Schema.String;
    readonly startedAt: Schema.Finite;
    readonly engineVersion: Schema.String;
    readonly engineCommit: Schema.String;
    readonly configDigest: Schema.String;
    readonly host: Schema.String;
    readonly imageDigest: Schema.optionalKey<Schema.String>;
    readonly request: Schema.optionalKey<typeof RunRequest>;
  }>,
  Record<never, never>
> = Schema.Class<RunRecord>("RunRecord")({
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
  /** Full captured Workflow Revision digest, including Factory configuration and packages. */
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
  request: Schema.optionalKey(RunRequest),
});

/**
 * The record that ties a run's phases together, and the only mutable one.
 *
 * It carries what produced the run, not only what the run did: the engine version and commit are
 * stamped here because they cannot be reconstructed later.
 */
export class RunRecord extends RunRecordBase {}
