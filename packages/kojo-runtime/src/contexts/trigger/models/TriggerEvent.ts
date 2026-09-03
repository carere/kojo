import { Schema } from "effect";

/**
 * One unit of work, offered to a workflow.
 *
 * An event is not a run. It is the *claim* that a run should exist for this unit of work, and the
 * same claim may arrive many times: a poller re-reads a ticket every minute, a webhook is redelivered
 * because nobody answered it in time, a person runs the command twice. `key` is what makes those
 * repetitions harmless — it is the value the run is deduplicated by, and the engine derives one
 * execution id from it, so the second event finds the first run rather than opening a second factory.
 *
 * `payload` is still encoded. It arrived from outside the process — a webhook body, a tracker's JSON,
 * a CLI argument — so it is decoded against the workflow's own payload schema when the run starts,
 * and a body that is not one is a named error rather than a run that starts on rubbish.
 */
export class TriggerEvent extends Schema.Class<TriggerEvent>("TriggerEvent")({
  /**
   * Which trigger produced it — `manual`, `poller/github`, `webhook/gitlab`.
   *
   * Carried on the event because a Runner may read several sources, and an acknowledgement has to
   * go back to the source the event came from.
   */
  source: Schema.String,
  /**
   * What the run is deduplicated by: the ticket revision, the commit sha, the delivery id.
   *
   * It must be the value the workflow's own `idempotencyKey` returns for this payload. That is not
   * a convention the Runner hopes for — it is checked before the Run starts, because a Trigger that
   * disagrees with its workflow about what a unit of work *is* opens a second factory silently.
   */
  key: Schema.String,
  /** The payload the run starts from, exactly as the source produced it. Decoded when it is used. */
  payload: Schema.Unknown,
  /** When the event was taken from its source, read from the `Clock`. */
  receivedAt: Schema.Finite,
}) {}
