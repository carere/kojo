import { Clock, Effect, type SchemaError } from "effect";
import { DurableDeferred, type WorkflowEngine } from "effect/unstable/workflow";

import { Verdict } from "../../src/contexts/gate/models/Verdict.ts";
import { decodeUnknown } from "../../src/contexts/shared/lib/decode.ts";

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
 * Test-only Daemon application seam for applying a recorded verdict.
 *
 * Production Clients only record a verdict through the Daemon API. This helper simulates the
 * Daemon application step after that recording boundary so Workflow tests can resume a suspended
 * Run without shipping an answering Client or a storage-writing application service.
 *
 * Answering twice keeps the first answer. `deferredDone` refuses to overwrite a recorded result,
 * which is the same property that makes a per-asking deferred name load-bearing.
 */
export const applyRecordedGateVerdict = (options: {
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
