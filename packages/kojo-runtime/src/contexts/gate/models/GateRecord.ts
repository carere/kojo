import { Option, Schema } from "effect";
import { DurableDeferred } from "effect/unstable/workflow";
import { RunId } from "../../shared/models/RunId.ts";
import type { GateRequest } from "./GateRequest.ts";
import { ExpiryBranch } from "./OnExpiry.ts";
import type { Settlement } from "./Verdict.ts";

/** How one asking of a gate ended. A gate still waiting has no record yet — see below. */
export const GateOutcome = Schema.Literals(["answered", "expired"]);
export type GateOutcome = typeof GateOutcome.Type;

/**
 * Everything known about one asking of one gate, written once, when it settles.
 *
 * Written on settle rather than on request, for the same reason a phase row is written on exit: a
 * record that is inserted and then updated is two half-records, and the trace's rule is one wide
 * row per unit of work. A gate that is still waiting is the run's *mutable status*, and lives on
 * the run row beside the in-flight phase — see adr/trace/0002.
 *
 * One asking, one record. A gate asked three times by the reviewed loop leaves three, so the human
 * latency of each round is visible separately instead of averaged into one number.
 */
export class GateRecord extends Schema.Class<GateRecord>("GateRecord")({
  runId: RunId,
  gate: Schema.String,
  /** The durable deferred name — unique to this asking, and what makes the records distinct. */
  asking: Schema.String,
  token: DurableDeferred.Token,
  description: Schema.String,
  /** Who was asked. */
  actor: Schema.String,
  choices: Schema.Array(Schema.String),
  requestedAt: Schema.Finite,
  deadlineAt: Schema.Finite,
  onExpiry: ExpiryBranch,
  outcome: GateOutcome,
  /** Who answered. Absent on a gate that nobody answered. */
  answerer: Schema.optionalKey(Schema.String),
  choice: Schema.optionalKey(Schema.String),
  reason: Schema.optionalKey(Schema.String),
  answeredAt: Schema.optionalKey(Schema.Finite),
}) {
  /**
   * Human latency: request to answer. Nothing upstream measures it, and it is the metric a factory
   * lives or dies by — as a distribution across runs, not as a number on one run.
   */
  get latencyMillis(): Option.Option<number> {
    return this.answeredAt === undefined
      ? Option.none()
      : Option.some(this.answeredAt - this.requestedAt);
  }
}

/** Folds a request and how it settled into the one record the trace keeps. */
export const settled = (request: GateRequest, settlement: Settlement): GateRecord =>
  new GateRecord({
    runId: request.runId,
    gate: request.gate,
    asking: request.asking,
    token: request.token,
    description: request.description,
    actor: request.actor,
    choices: request.choices,
    requestedAt: request.requestedAt,
    deadlineAt: request.deadlineAt,
    onExpiry: request.onExpiry,
    ...(settlement === "expired"
      ? { outcome: "expired" as const }
      : {
          outcome: "answered" as const,
          answerer: settlement.answerer,
          choice: settlement.choice,
          reason: settlement.reason,
          answeredAt: settlement.answeredAt,
        }),
  });
