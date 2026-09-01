import { Data } from "effect";

export class ConfigurationError extends Data.TaggedError("ConfigurationError")<{
  readonly code:
    | "INVALID_CONFIGURATION_PATCH"
    | "CONFIGURATION_CONFLICT"
    | "CONFIGURATION_PLAN_REQUIRED"
    | "CONFIGURATION_PLAN_NOT_FOUND"
    | "CONFIGURATION_PLAN_EXPIRED"
    | "CONFIGURATION_PLAN_STALE"
    | "CONFIGURATION_STORE_FAILED";
  readonly message: string;
  readonly cause?: unknown;
}> {}
