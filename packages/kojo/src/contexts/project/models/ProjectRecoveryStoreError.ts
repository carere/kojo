import { Data } from "effect";

export class ProjectRecoveryStoreError extends Data.TaggedError("ProjectRecoveryStoreError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}
