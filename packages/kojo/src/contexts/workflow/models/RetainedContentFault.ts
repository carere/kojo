import { Data } from "effect";

export type RetainedContentFaultCode =
  | "RETAINED_CONTENT_MISSING"
  | "RETAINED_CONTENT_CORRUPT"
  | "RETAINED_HOST_INCOMPATIBLE"
  | "RETAINED_PROTOCOL_INCOMPATIBLE";

/** A fault that holds one pinned Run without selecting current Project content. */
export class RetainedContentFault extends Data.TaggedError("RetainedContentFault")<{
  readonly code: RetainedContentFaultCode;
  readonly message: string;
  readonly remedy: string;
  readonly cause?: unknown;
}> {}
