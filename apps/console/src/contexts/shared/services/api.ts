/**
 * The Console's one way of talking to `kojo ui`.
 *
 * **Structural reads, never a validating decode.** console.md §10 asks the Console to ignore
 * anything the trace grew that this build does not know about — that is what the additive-migration
 * promise buys — and a schema that rejected an unknown field would spend that promise on nothing.
 * A field this build does not read simply is not read.
 *
 * A non-2xx answer is thrown so that TanStack Query owns the retry. The Console's answer to an
 * unreachable API is *keep the last data and retry* (console.md §10), and Query already implements
 * exactly that as long as the failure reaches it as a rejection.
 *
 * **But a refusal is not an outage, and this module is where the two stop being the same thing.**
 * `GET /api/runs/run-nope` answers a clean `404 {"error":"no-such-run", …}`: the server was reached,
 * it read the trace, and it says there is no such run. Thrown as an undifferentiated `Error` that
 * fact is lost, and a Console that retries for ever shows *Loading the run…* under a retrying banner
 * over a mistyped id — for ever, for a question that already has an answer. So every non-2xx answer
 * arrives as an {@link ApiError} carrying the status and the API's own error code, and
 * {@link refused} is what the retry policy and the views ask.
 */

/** The body every failing route answers with — `responses.problem` on the server side. */
interface Problem {
  readonly error?: string;
  readonly message?: string;
}

/**
 * A request that reached the server and came back with a status.
 *
 * `code` is the API's own word for what happened — `no-such-run`, `no-such-artifact`,
 * `trace-unreadable` — and it is what a view switches on. The status is what the *retry* switches
 * on, because that distinction is about the class of failure rather than about the case.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(options: {
    readonly status: number;
    readonly code: string;
    readonly message: string;
  }) {
    super(options.message);
    this.name = "ApiError";
    this.status = options.status;
    this.code = options.code;
  }
}

/**
 * Did the server *answer*, rather than fail to be reached?
 *
 * A 4xx is an answer: the request named something that is not there, or is not allowed, and asking
 * again cannot change it. A 5xx is not — `503 trace-unreadable` is precisely the class console.md
 * §10 says to survive by asking again — and neither is a connection that never completed, which
 * arrives as a `TypeError` from `fetch` and is not an `ApiError` at all.
 */
export const refused = (error: unknown): error is ApiError =>
  error instanceof ApiError && error.status >= 400 && error.status < 500;

const problemOf = async (path: string, response: Response): Promise<ApiError> => {
  // The body is this API's own JSON problem shape. A proxy or a crash may send something else, so a
  // failure to read it falls back to the status line rather than becoming a second failure.
  const body = (await response.json().catch(() => undefined)) as Problem | undefined;
  return new ApiError({
    status: response.status,
    code: body?.error ?? "unknown",
    message: body?.message ?? `${path} answered ${response.status} ${response.statusText}`,
  });
};

export const fetchJson = async <A>(path: string): Promise<A> => {
  const response = await fetch(path, { headers: { accept: "application/json" } });
  if (!response.ok) {
    throw await problemOf(path, response);
  }
  return (await response.json()) as A;
};

/**
 * The one write this Console makes: a verdict, against a token.
 *
 * It is not retried and it must never be. `POST /api/gates/:token/answer` refuses a second answer
 * with `409 already-answered` on purpose — the first answer is the one that counts — so a retry
 * could only ever turn a success into a refusal over a verdict that had already been written. The
 * mutation surfaces the failure instead, and the three refusals arrive as {@link ApiError} with the
 * API's own code, which is what lets the card say *which* of them happened.
 */
export const postJson = async <A>(path: string, body: unknown): Promise<A> => {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw await problemOf(path, response);
  }
  return (await response.json()) as A;
};

/**
 * One artifact, as text.
 *
 * The three artifact routes answer with the artifact's own media type — markdown, ndjson, a patch —
 * rather than JSON, so that a transcript or a diff is the thing a person can save or pipe. Their
 * *failures* are still the JSON problem shape, which is why the same reader handles both.
 */
export const fetchText = async (path: string): Promise<string> => {
  const response = await fetch(path, { headers: { accept: "text/plain, */*" } });
  if (!response.ok) {
    throw await problemOf(path, response);
  }
  return await response.text();
};
