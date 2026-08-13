import type { UseQueryResult } from "@tanstack/solid-query";
import { type ApiError, refused } from "../services/api.ts";

/**
 * A query's data, read without ever suspending.
 *
 * `solid-query` backs `data` with a resource: reading it before the first success throws to the
 * nearest `<Suspense>`. That is the wrong shape for this Console. The Console retries forever, so a
 * resource that never resolves would hold a suspense fallback on screen for the whole outage — and
 * the fallback is exactly the blank view console.md §10 forbids. Asking `isPending` first, which is
 * plain store state, keeps the read out of the resource until there is something in it.
 */
export const settled = <A>(query: UseQueryResult<A, Error>): A | undefined =>
  query.isPending ? undefined : query.data;

/**
 * Is this query currently failing to **reach** the server?
 *
 * `failureCount` rather than `isError`, because the Console retries without end and therefore never
 * reaches the error status for the failure this is about. The count rises on the first refused
 * connection and resets on the first success, which is precisely when the retrying banner should
 * appear and disappear.
 *
 * **And a refusal is excluded, by asking whether the query gave up.** A `404` is not retried, so it
 * settles into the error status immediately while still raising the failure count. Without the second
 * half of this condition a mistyped run id would raise *Cannot reach the Console API* over a server
 * that answered in three milliseconds.
 */
export const retrying = (query: UseQueryResult<unknown, Error>): boolean =>
  query.failureCount > 0 && !query.isError;

/**
 * The answer the server gave, when what it gave was a refusal.
 *
 * `undefined` for every other state, including an outage — a view asks this to decide whether to say
 * *that does not exist* rather than *the Console cannot reach the API*, and those are the only two
 * sentences either of them may produce.
 *
 * **Stated over the two fields it reads rather than over a query**, because a mutation fails the
 * same two ways: the server refused, or it was never reached. Answering a gate needs exactly this
 * distinction — `409 already-answered` is a decision somebody else made, not an outage — and a
 * second copy of the rule for mutations is a second place for the two to drift apart.
 */
export const refusal = (query: {
  readonly isError: boolean;
  readonly error: Error | null;
}): ApiError | undefined => (query.isError && refused(query.error) ? query.error : undefined);
