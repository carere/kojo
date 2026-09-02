import { Clock, Effect, type SchemaError } from "effect";
import { DurableDeferred, type WorkflowEngine } from "effect/unstable/workflow";

import { decodeUnknown } from "../../shared/lib/decode.ts";
import { Verdict } from "../models/Verdict.ts";

/**
 * The deferred a token points at, rebuilt from nothing but the token's deferred name.
 *
 * This is what the single `Verdict` schema buys. `DurableDeferred.done` needs the deferred *value*
 * — the schemas, not just the name — and the token carries no schema at all. With one verdict
 * schema for every gate, the answering process reconstructs a usable deferred without a registry
 * and without ever having seen the workflow that asked.
 */
const deferredFor = (deferredName: string) =>
  DurableDeferred.make(deferredName, { success: Verdict });

/**
 * Validates a token string that came from outside the process — a CLI argument, a URL, a click.
 *
 * `TokenParsed.fromString` is a `decodeSync`: handed a typo it throws rather than failing, and a
 * thrown parse error inside `kojo gate answer` is a stack trace where a usage message belongs.
 */
export const parseToken = (
  input: string,
): Effect.Effect<DurableDeferred.TokenParsed, SchemaError.SchemaError> =>
  decodeUnknown(DurableDeferred.TokenParsed.FromString)(input);

/**
 * The answering half. Any process holding the token can run it — that is the point.
 *
 * It takes no `Gate`: the port exists to *ask*, and asking already finished. What resumes the run
 * is a write to the engine's storage, so this needs the engine and nothing else.
 *
 * Answering twice keeps the first answer. `deferredDone` refuses to overwrite a recorded result,
 * which is the same property that makes a per-asking deferred name load-bearing.
 */
export const answerGate = (options: {
  readonly token: DurableDeferred.Token;
  readonly choice: string;
  readonly reason: string;
  readonly answerer: string;
}): Effect.Effect<Verdict, never, WorkflowEngine.WorkflowEngine> =>
  Effect.gen(function* () {
    const answeredAt = yield* Clock.currentTimeMillis;
    const parsed = DurableDeferred.TokenParsed.fromString(options.token);
    const verdict = new Verdict({
      choice: options.choice,
      reason: options.reason,
      answerer: options.answerer,
      answeredAt,
    });

    yield* DurableDeferred.succeed(deferredFor(parsed.deferredName), {
      token: options.token,
      value: verdict,
    });

    // Returned rather than discarded: whatever else writes this answer down — the askings list, a
    // Console, an audit log — must record the *same* verdict, stamped with the same clock. Building
    // a second one from the same arguments would differ by however long the write took.
    return verdict;
  });
