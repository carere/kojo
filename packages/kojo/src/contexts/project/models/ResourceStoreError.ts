import { Data } from "effect";

export class ResourceStoreError extends Data.TaggedError("ResourceStoreError")<{
  readonly code: "RESOURCE_STORE_FAILED" | "RESOURCE_AUTHORITY_LOST" | "RESOURCE_STATE_CONFLICT";
  readonly message: string;
  readonly cause: unknown;
}> {}
