import { Data } from "effect";

export class RevisionMaintenanceError extends Data.TaggedError("RevisionMaintenanceError")<{
  readonly code:
    | "REVISION_NOT_FOUND"
    | "REVISION_PROTECTED"
    | "READER_CONFLICT"
    | "READER_RELEASE_REFUSED"
    | "EXACT_COPY_REFUSED"
    | "COLLECTION_FAILED"
    | "REVISION_STORE_FAILED";
  readonly message: string;
  readonly cause?: unknown;
}> {}
