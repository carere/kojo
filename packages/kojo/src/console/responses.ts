import { Effect, type Schema } from "effect";
import { HttpServerResponse } from "effect/unstable/http";

/**
 * How long a browser may keep an artifact. One year, which is what *forever* is spelled as.
 *
 * Sound because of what is cached, not because of how long: an artifact is only ever served for a
 * phase that has a **record**, and a record is written when the phase exits. A phase that has exited
 * cannot change, so its prompt, its transcript and its diff cannot either (console.md §7). `immutable`
 * is what stops a browser revalidating on reload, which is the whole benefit.
 */
export const forever = "public, max-age=31536000, immutable";

/**
 * One failure, as a shape every route answers with.
 *
 * `jsonUnsafe` rather than `json`, and it is not laziness: this body is two strings this module
 * built, so `JSON.stringify` cannot fail on it, and a synchronous response is what lets a handler
 * end with an error whose own effect channel is `never`. That is the property the whole router
 * depends on — see `api.ts`.
 */
export const problem = (
  status: number,
  error: string,
  message: string,
): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.jsonUnsafe({ error, message }, { status });

/**
 * A JSON responder built from a schema, whose failure channel is empty.
 *
 * **Both halves matter.** Encoding through the schema keeps the single-contract rule of the read
 * side: what a browser receives is what `Schema` says the record is, so no route writes a row
 * mapping by hand. And catching `HttpBodyError` here is what stops that contract leaking into the
 * router — `HttpServerResponse.json` alone puts that error in the handler's channel, and
 * `HttpRouter.add` turns a handler's error into an unsatisfied *requirement* at `serve`, which is a
 * startup failure rather than a 500.
 *
 * An encoding failure is genuinely a server fault: the value came from this process's own records
 * and the schema is this process's own. So it is a 500 that says so, rather than a defect that kills
 * the request with no body.
 */
export const sends = <A, RE>(schema: Schema.ConstraintCodec<A, unknown, unknown, RE>) => {
  const encode = HttpServerResponse.schemaJson(schema);
  return (
    value: A,
    options?: { readonly status?: number | undefined; readonly headers?: Record<string, string> },
  ): Effect.Effect<HttpServerResponse.HttpServerResponse, never, RE> =>
    encode(value, options).pipe(
      Effect.catch((cause) =>
        Effect.succeed(
          problem(500, "encoding-failed", `the response could not be encoded: ${cause.message}`),
        ),
      ),
    );
};
