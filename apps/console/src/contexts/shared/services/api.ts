/** Distinguish a Daemon API refusal from an unreachable API. */

/** The body every failing route answers with — `responses.problem` on the server side. */
interface Problem {
  readonly error?: string;
  readonly message?: string;
}

/**
 * A request that reached the server and came back with a status.
 *
 * `code` is the Daemon API's own word for what happened. The status is what retry policy uses.
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

export const problemOf = async (path: string, response: Response): Promise<ApiError> => {
  // The body is this API's own JSON problem shape. A proxy or a crash may send something else, so a
  // failure to read it falls back to the status line rather than becoming a second failure.
  const body = (await response.json().catch(() => undefined)) as Problem | undefined;
  return new ApiError({
    status: response.status,
    code: body?.error ?? "unknown",
    message: body?.message ?? `${path} answered ${response.status} ${response.statusText}`,
  });
};
