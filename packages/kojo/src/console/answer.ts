import { Schema } from "effect";
import { Verdict } from "../contexts/gate/models/Verdict.ts";
import { RunnerPresence } from "./FactoryHealth.ts";

/**
 * What a browser sends to answer a gate — and nothing more than that.
 *
 * **The answerer is not in it.** console.md §9 fixes v1 at localhost, no authentication, with the OS
 * user recorded as the answerer, so the server takes the name from the process it is running as. A
 * field here would let a page name anybody at all, and a verdict attributed to somebody who did not
 * give it is worse than one attributed to a machine account.
 *
 * `reason` defaults to empty rather than being required, because the alternative is a form that
 * refuses to submit and a person who types a full stop to get past it. A rejected run is re-prompted
 * from the reason, so the Console asks for one — the API does not pretend to enforce it.
 */
export class GateAnswer extends Schema.Class<GateAnswer>("GateAnswer")({
  /** One of the choices the gate declared. Checked against them before anything is written. */
  choice: Schema.String,
  reason: Schema.optionalKey(Schema.String),
}) {}

/**
 * What the answer endpoint gives back: the verdict as written, and whether anybody can apply it.
 *
 * **`runner` is the field that keeps the Console honest**, and it is here rather than left to a
 * second call because the three states a gate card resolves to are decided the moment the answer
 * lands: *recorded — applying…* when a runner is live, and *recorded — start `kojo watch` to apply
 * it* when none is. A page that had to poll `/api/health` afterwards would show the wrong one of the
 * two for as long as that request took.
 *
 * There is no `applied` field, and there cannot be one. Applying is a runner picking the answer up
 * on its own poll, which has not happened yet by definition when this response is written.
 */
export class GateAnswerReceipt extends Schema.Class<GateAnswerReceipt>("GateAnswerReceipt")({
  /** The verdict exactly as it was written down, stamped with the clock that wrote it. */
  verdict: Verdict,
  runner: RunnerPresence,
}) {}
