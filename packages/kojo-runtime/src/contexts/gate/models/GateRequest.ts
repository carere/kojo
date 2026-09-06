import { Schema } from "effect";
import { DurableDeferred } from "effect/unstable/workflow";
import { RunId } from "../../shared/models/RunId.ts";
import { ExpiryBranch } from "./OnExpiry.ts";

const GateRequestBase: Schema.Class<
  GateRequest,
  Schema.Struct<{
    readonly runId: Schema.brand<Schema.String, "RunId">;
    readonly gate: Schema.String;
    readonly asking: Schema.String;
    readonly description: Schema.String;
    readonly actor: Schema.String;
    readonly choices: Schema.$Array<Schema.String>;
    readonly token: Schema.brand<Schema.String, "~effect/workflow/DurableDeferred/Token">;
    readonly requestedAt: Schema.Finite;
    readonly deadlineAt: Schema.Finite;
    readonly onExpiry: Schema.Literals<readonly ["fail", "reject", "escalate"]>;
  }>,
  Record<never, never>
> = Schema.Class<GateRequest>("GateRequest")({
  runId: RunId,
  /** The gate's authored name, stable across every asking of it. */
  gate: Schema.String,
  /**
   * The durable deferred name, unique to *this* asking of the gate.
   *
   * A deferred is keyed `executionId/name` and refuses to overwrite, so this is what keeps a
   * second asking from reading the first verdict back instantly and forever.
   */
  asking: Schema.String,
  description: Schema.String,
  /** Who was asked to decide. */
  actor: Schema.String,
  choices: Schema.Array(Schema.String),
  token: DurableDeferred.Token,
  requestedAt: Schema.Finite,
  /** The time after which the gate stops waiting. Every gate has one; a run that waits forever leaks. */
  deadlineAt: Schema.Finite,
  onExpiry: ExpiryBranch,
});

/**
 * Everything an answering half needs to ask a human, and everything the trace needs to remember it.
 *
 * The requesting half posts a review, prints a command, or sends a message from this value and then
 * finishes. It never waits, so the request is the only thing that crosses to whoever will answer.
 *
 * `token` is what identifies one exact suspension. Holding it is what lets any process answer.
 */
export class GateRequest extends GateRequestBase {}
