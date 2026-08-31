import { Schema } from "effect";

/**
 * The answer to a gate — the choice the human made, and the reason they gave.
 *
 * **One schema for every gate, and that is the whole point.** A gate token decodes to
 * workflow / execution / deferred name and carries no schema, so an answering process cannot
 * discover what shape a particular gate expects. With one shared `Verdict`, any adapter — a
 * terminal, a webhook, the Console — answers any gate holding nothing but the token. The price is
 * that `choice` is a plain string rather than the gate's own literal union; the gate declares its
 * choices and checks the answer against them.
 *
 * `reason` is the answerer's own words. A rejected fix is re-prompted from it, so an empty reason
 * costs the next attempt its only clue.
 */
export class Verdict extends Schema.Class<Verdict>("Verdict")({
  choice: Schema.String,
  reason: Schema.String,
  /** Who the verdict is attributed to, and the reason a gate is worth auditing at all. */
  answerer: Schema.String,
  /**
   * When the answer was given, by the answering process's clock.
   *
   * Carried on the verdict rather than measured when the run wakes up, because a runner picks up
   * an answer written by another process on a poll interval. Measuring at resume would report that
   * engine lag as human latency.
   */
  answeredAt: Schema.Finite,
}) {}

/** What a gate settles as: a verdict, or nothing because the deadline passed first. */
export const Expired = Schema.Literal("expired");

/**
 * The one success schema the deadline race resolves to.
 *
 * `DurableDeferred.raceAll` shares a single schema pair across every racer, so the verdict and the
 * expiry have to inhabit one type. A struct against a string literal keeps the union unambiguous
 * to decode.
 */
export const Settlement = Schema.Union([Verdict, Expired]);
export type Settlement = typeof Settlement.Type;
