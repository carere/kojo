import { Data } from "effect";

export type GateTransitionErrorCode =
  | "ASKING_CONFLICT"
  | "ASKING_NOT_FOUND"
  | "CHOICE_REFUSED"
  | "DEADLINE_PASSED"
  | "ALREADY_SETTLED"
  | "REQUEST_CONFLICT"
  | "STALE_AUTHORITY"
  | "STORE_FAILED";

export class GateTransitionError extends Data.TaggedError("GateTransitionError")<{
  readonly code: GateTransitionErrorCode;
  readonly message: string;
  readonly cause?: unknown;
}> {}
