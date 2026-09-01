export class LifecycleError extends Error {
  readonly _tag = "LifecycleError";

  constructor(
    readonly code: string,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
  }
}
