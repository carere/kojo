import { Data } from "effect";

export class RunStoreError extends Data.TaggedError("RunStoreError")<{
  readonly code:
    | "DEDUP_COLLISION"
    | "REQUEST_CONFLICT"
    | "QUEUE_FULL"
    | "RUN_NOT_FOUND"
    | "RUN_NOT_ELIGIBLE"
    | "WORKFLOW_REVIEW_STALE"
    | "STALE_AUTHORITY"
    | "STORE_FAILED";
  readonly message: string;
  readonly cause?: unknown;
}> {}
