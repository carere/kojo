import { Effect } from "effect";
import type { Verdict } from "../../gate/models/Verdict.ts";
import type { Acceptance } from "../models/Acceptance.ts";
import { Judgement } from "../models/Acceptance.ts";
import { NotAccepted } from "../models/NotAccepted.ts";
import { approval } from "./reviewed.ts";

/**
 * The human half of an acceptance, read off the answer a person gave.
 *
 * Written here rather than at a call site so that "approved" means one thing in Kojo. The reviewed
 * loop already treats every choice but `approve` as a rejection — an answer nobody declared is not
 * an approval — and an acceptance built by hand somewhere else would be free to disagree with it.
 */
/** @public */
export const fromVerdict = (verdict: Verdict): Judgement =>
  new Judgement({
    by: verdict.answerer,
    accepted: verdict.choice === approval,
    reason: verdict.reason,
  });

/**
 * The single condition anything irreversible hangs on.
 *
 * Succeeds with the acceptance it was given, so it composes in front of the thing it guards rather
 * than beside it: `merge` calls this before it touches git, and a caller cannot reach the merge
 * without having gone through it.
 *
 * The failure carries the refusers' own words. `NotAccepted` is one field on purpose — a run that
 * was not accepted is not accepted, and which half said so is a sentence rather than a taxonomy.
 */
export const requireAcceptance = (
  acceptance: Acceptance,
): Effect.Effect<Acceptance, NotAccepted> =>
  acceptance.accepted
    ? Effect.succeed(acceptance)
    : Effect.fail(new NotAccepted({ reason: acceptance.refusal }));
