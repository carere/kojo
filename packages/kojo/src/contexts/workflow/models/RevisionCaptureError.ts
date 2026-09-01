import { Data } from "effect";

export class RevisionCaptureError extends Data.TaggedError("RevisionCaptureError")<{
  readonly code: "FACTORY_INVALID" | "WORKFLOW_INVALID" | "REFRESH_UNSTABLE" | "CAPTURE_FAILED";
  readonly message: string;
  readonly remedy: string;
  readonly cause?: unknown;
}> {}
